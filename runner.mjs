import { spawnSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// The action's job: run the published beliq CLI over every matched e-invoice,
// summarize the verdicts, and fail the workflow if any file is not compliant.
// The CLI validates the files in batch mode and reports a verdict per file;
// this runner owns the glob, the aggregation, the step summary, and the outputs.

const FAIL_ON = new Set(['error', 'warning'])
const FORMATS = new Set(['auto', 'cii', 'ubl'])
// spawn stdout cap: a validation result JSON is small, but a pathological
// document could produce a long error list. 16 MiB is well clear of that.
const MAX_BUFFER = 16 * 1024 * 1024

// Files per CLI run. One run validates its files in sequence and stops on a
// refused key, a forbidden request or a rate limit instead of trying the rest;
// the cap only keeps the argument list far below the OS limit on a large tree.
export const FILES_PER_RUN = 100

// The default glob is `**/*.xml`, which in a consumer's checkout also matches
// every XML file vendored under these directories: fixtures inside an installed
// package, a Composer tree, a build output. Each match is one billed validate
// call against the caller's key and monthly quota, so they are skipped.
//
// `.git` needs no entry: node's fs.glob does not match dotted path segments
// under `**`.
const SKIPPED_DIRS = ['node_modules', 'vendor', 'dist']

/** The default the `files` input declares in action.yml. Kept in step by a test. */
export const DEFAULT_FILES = '**/*.xml'

// The CLI version the action runs when the caller does not name one. It is an
// exact version, not `latest`: README.md promises that pinning a full action
// version freezes behaviour, and a floating CLI breaks that promise on a tag
// that is never rebuilt. The same version is written in action.yml and in
// .github/workflows/test-action.yml; a test binds all three, and the marker
// comment above each one is what lets Renovate move them together.
// renovate: datasource=npm depName=beliq-cli
export const DEFAULT_CLI_VERSION = '0.2.2'

export function parseGlobs(input) {
  return String(input ?? '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim()) ?? ''
}

// The CLI contract: 0 valid, 1 invalid (per --fail-on), 2 usage, 3 API, 4 I/O.
function reasonFor(exitCode) {
  return exitCode === 2 ? 'usage error'
    : exitCode === 3 ? 'API error'
      : exitCode === 4 ? 'I/O error'
        : `exit ${exitCode}`
}

function counted(file, status, result, message = '') {
  return {
    file,
    status,
    format: result?.format ?? '',
    errors: result?.errors?.length ?? 0,
    warnings: result?.warnings?.length ?? 0,
    message,
  }
}

function errored(file, message) {
  return { file, status: 'error', format: '', errors: 0, warnings: 0, message }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Map one CLI run over `files` to one normalized result per file.
 *
 * Several files come back as the CLI's batch report, one row per file. One
 * file comes back as a bare validation result, because that is what the CLI
 * prints for a single named file. Anything else means the run as a whole
 * failed (a refused key, an unreachable API, npx itself), and every file in it
 * gets that reason. `failed` says so, so the caller can stop instead of
 * repeating the same failure for the next run.
 *
 * Exit 0 or 1 without a verdict is an error, not a failed document: beliq-cli
 * 0.2.2 and earlier exit 1 when the API cannot be reached.
 */
export function classifyRun(files, exitCode, stdout, stderr = '') {
  const parsed = parseJson(stdout)

  if ([0, 1, 3].includes(exitCode) && Array.isArray(parsed?.results)) {
    const rows = new Map(parsed.results.map((row) => [row.file, row]))
    const results = files.map((file) => {
      const row = rows.get(file)
      if (!row) return errored(file, 'the CLI reported no result for this file')
      if (row.status === 'pass' || row.status === 'fail') return counted(file, row.status, row)
      return errored(file, row.message ?? 'not checked')
    })
    return { results, failed: false }
  }

  if (files.length === 1 && (exitCode === 0 || exitCode === 1) && typeof parsed?.valid === 'boolean') {
    return { results: [counted(files[0], exitCode === 0 ? 'pass' : 'fail', parsed)], failed: false }
  }

  const detail = firstLine(stderr)
  const reason = exitCode === 0 || exitCode === 1 ? `no verdict (exit ${exitCode})` : reasonFor(exitCode)
  const message = detail ? `${reason}: ${detail}` : reason
  return { results: files.map((file) => errored(file, message)), failed: true }
}

export function aggregate(results) {
  return {
    total: results.length,
    invalid: results.filter((r) => r.status !== 'pass').length,
  }
}

export function renderSummary(results) {
  const { total, invalid } = aggregate(results)
  const head =
    invalid === 0
      ? `## beliq validate: all ${total} file(s) compliant`
      : `## beliq validate: ${invalid} of ${total} file(s) not compliant`
  const rows = results.map((r) => {
    const icon = r.status === 'pass' ? '✅' : '❌'
    const verdict =
      r.status === 'pass' ? 'compliant' : r.status === 'fail' ? 'not compliant' : r.message
    return `| ${icon} | \`${r.file}\` | ${r.format || '-'} | ${r.errors} | ${r.warnings} | ${verdict} |`
  })
  return [
    head,
    '',
    '| | File | Format | Errors | Warnings | Verdict |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

/**
 * Which SKIPPED_DIRS apply to one pattern. A pattern that names a directory
 * outright means it, so `vendor/invoices/*.xml` still resolves; only an
 * incidental sweep into one is dropped.
 */
export function skippedDirsFor(pattern) {
  return SKIPPED_DIRS.filter((dir) => !String(pattern).includes(dir))
}

export async function expandFiles(globs) {
  const seen = new Set()
  for (const pattern of globs) {
    const skipped = skippedDirsFor(pattern)
    for await (const entry of glob(pattern)) {
      if (entry.split(/[\\/]/).some((segment) => skipped.includes(segment))) continue
      seen.add(entry)
    }
  }
  return [...seen].sort()
}

function runCli(files, { cliVersion, format, failOn, baseUrl }) {
  const argv = ['-y', `beliq-cli@${cliVersion}`, 'validate', ...files, '--json', '--fail-on', failOn]
  if (format && format !== 'auto') argv.push('--format', format)
  const env = { ...process.env }
  if (baseUrl) env.BELIQ_BASE_URL = baseUrl
  const res = spawnSync('npx', argv, { encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
  if (res.error) return { exitCode: 4, stdout: '', stderr: String(res.error.message) }
  return { exitCode: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Validate `files` in runs of FILES_PER_RUN. After a run that failed as a
 * whole, the remaining files are marked with its reason and not sent: the
 * same key, quota and network would fail them the same way.
 */
export function validateAll(files, opts, run = runCli, onRun = () => {}) {
  const results = []
  for (let i = 0; i < files.length; i += FILES_PER_RUN) {
    const batch = files.slice(i, i + FILES_PER_RUN)
    const { exitCode, stdout, stderr } = run(batch, opts)
    const { results: batchResults, failed } = classifyRun(batch, exitCode, stdout, stderr)
    results.push(...batchResults)
    onRun(batchResults)
    if (failed) {
      const reason = `not checked: ${batchResults[0].message}`
      for (const file of files.slice(i + FILES_PER_RUN)) results.push(errored(file, reason))
      break
    }
  }
  return results
}

function issue(kind, message) {
  process.stdout.write(`::${kind}::beliq-validate: ${message}\n`)
}

async function writeSummary(results) {
  const md = renderSummary(results)
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path) await appendFile(path, `${md}\n`)
  else process.stdout.write(`${md}\n`)
}

async function setOutputs(results) {
  const { total, invalid } = aggregate(results)
  const path = process.env.GITHUB_OUTPUT
  if (!path) return
  const delim = 'beliq_results_EOF'
  const block = `total=${total}\ninvalid=${invalid}\nresults<<${delim}\n${JSON.stringify(results)}\n${delim}\n`
  await appendFile(path, block)
}

export async function main() {
  if (!process.env.BELIQ_API_KEY) {
    issue('error', 'no beliq API key provided (set the `api-key` input from a repository secret)')
    process.exitCode = 1
    return
  }

  const globs = parseGlobs(process.env.INPUT_FILES || DEFAULT_FILES)
  const failOnRaw = (process.env.INPUT_FAIL_ON || 'error').trim()
  const failOn = FAIL_ON.has(failOnRaw) ? failOnRaw : 'error'
  const formatRaw = (process.env.INPUT_FORMAT || 'auto').trim()
  const format = FORMATS.has(formatRaw) ? formatRaw : 'auto'
  const cliVersion = (process.env.INPUT_CLI_VERSION || DEFAULT_CLI_VERSION).trim() || DEFAULT_CLI_VERSION
  const baseUrl = (process.env.INPUT_BASE_URL || '').trim()

  const files = await expandFiles(globs)
  if (files.length === 0) {
    issue('warning', `no files matched ${globs.join(', ')}`)
    await writeSummary([])
    await setOutputs([])
    return
  }

  const results = validateAll(files, { cliVersion, format, failOn, baseUrl }, runCli, (batch) => {
    for (const r of batch) process.stdout.write(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.file}\n`)
  })

  await writeSummary(results)
  await setOutputs(results)

  const { invalid } = aggregate(results)
  if (invalid > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
