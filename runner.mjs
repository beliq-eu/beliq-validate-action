import { spawnSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// The action's job: run the published beliq CLI over every matched e-invoice,
// summarize the verdicts with the depth of each check, and fail the workflow if
// any file fails.
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
export const DEFAULT_CLI_VERSION = '0.4.0'

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

// The API's own entry in `warnings` that explains `franceCtcBlockingRuleIds`.
const FRANCE_BLOCK_ENTRY = 'FRANCE_CTC_FINDINGS_BLOCK_TRANSMISSION'

/**
 * The text that explains a France CTC block: the API's own message for it, and
 * the rule ids unless that message already names every one. The same lines
 * beliq-cli prints (`src/verdict.ts`, franceBlockLines).
 */
export function franceBlockText(result) {
  const ids = result?.franceCtcBlockingRuleIds ?? []
  if (ids.length === 0) return ''
  const entry = (result.warnings ?? []).find((w) => w?.ruleId === FRANCE_BLOCK_ENTRY)
  const idLine = `France CTC blocking rule ids: ${ids.join(', ')}`
  if (!entry) return idLine
  const named = new Set(String(entry.message).split(/[^A-Za-z0-9_-]+/))
  return ids.every((id) => named.has(id)) ? entry.message : `${entry.message} ${idLine}`
}

/**
 * One validated file. A result that carries France CTC blocking rule ids fails
 * even where the CLI passed it: beliq-cli 0.4.0 already fails such a file, and
 * an older `cli-version` does not.
 */
function counted(file, status, result) {
  const franceIds = result?.franceCtcBlockingRuleIds ?? []
  return {
    file,
    status: franceIds.length > 0 ? 'fail' : status,
    format: result?.format ?? '',
    errors: result?.errors?.length ?? 0,
    warnings: result?.warnings?.length ?? 0,
    message: franceBlockText(result),
    valid: typeof result?.valid === 'boolean' ? result.valid : null,
    verificationTier: result?.verificationTier ?? null,
    verificationBadge: result?.verificationBadge ?? null,
    verificationBadgeLabel: result?.verificationBadgeLabel ?? null,
    franceCtcBlockingRuleIds: franceIds,
    pdfInput: result?.pdfInput ?? null,
  }
}

function errored(file, message) {
  return {
    file,
    status: 'error',
    format: '',
    errors: 0,
    warnings: 0,
    message,
    valid: null,
    verificationTier: null,
    verificationBadge: null,
    verificationBadgeLabel: null,
    franceCtcBlockingRuleIds: [],
    pdfInput: null,
  }
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

export const VERIFICATION_DOC = 'https://docs.beliq.eu/compliance/how-verification-works/'

/** API text goes into a table cell, where a pipe or a line break would end it. */
function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/**
 * A file's verdict in the API's own words, `valid` or `invalid`, with what else
 * decided it: a France CTC block, or the `fail-on` threshold. A PDF's verdict is
 * about the XML embedded in it, and the API says so in `pdfInput`.
 */
export function verdictText(r) {
  if (r.status === 'error') return r.message
  const word = r.valid === false ? 'invalid' : 'valid'
  const notes = []
  if (r.message) notes.push(r.message)
  else if (r.status === 'fail' && r.valid !== false) notes.push('Fails the `fail-on` threshold.')
  if (r.pdfInput) notes.push('The verdict is about the embedded XML; the PDF itself was not checked.')
  return notes.length > 0 ? `${word}. ${notes.join(' ')}` : word
}

export function renderSummary(results) {
  const { total, invalid } = aggregate(results)
  if (total === 0) return '## beliq validate: no file matched\n'
  const head =
    invalid === 0
      ? `## beliq validate: all ${total} file(s) passed`
      : `## beliq validate: ${invalid} of ${total} file(s) failed`
  const rows = results.map((r) => {
    const icon = r.status === 'pass' ? '✅' : '❌'
    const depth = r.verificationBadgeLabel ?? '-'
    return `| ${icon} | \`${r.file}\` | ${r.format || '-'} | ${depth} | ${r.errors} | ${r.warnings} | ${cell(verdictText(r))} |`
  })
  return [
    head,
    '',
    '| | File | Format | Check depth | Errors | Warnings | Verdict |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Check depth is the badge beliq gave the verdict, explained at ${VERIFICATION_DOC}. \`-\` means none was stated.`,
    '',
  ].join('\n')
}

/** The line each file leaves in the step's log. */
export function logLine(r) {
  if (r.status === 'error') return `FAIL ${r.file}: ${r.message}`
  const depth = r.verificationBadgeLabel ?? 'check depth not stated'
  const note = r.message ? `: ${r.message}` : ''
  return `${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.file} (${depth})${note}`
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

/**
 * What stops the step before any file is sent, as messages. An unknown
 * `fail-on` or `format` used to fall back to the default without a word, so
 * `fail-on: warnings` (for `warning`) passed a job on the warnings it asked to
 * fail on. Windows is refused by name: the runner spawns `npx`, which is
 * `npx.cmd` there, and that path has never been built or tested.
 */
export function preflightProblems(env, platform = process.platform) {
  const problems = []
  if (platform === 'win32') {
    problems.push('Windows runners are not supported; run this step on a Linux or macOS runner')
  }
  const failOn = (env.INPUT_FAIL_ON || 'error').trim()
  if (!FAIL_ON.has(failOn)) {
    problems.push(`fail-on must be one of: ${[...FAIL_ON].join(', ')} (got "${failOn}")`)
  }
  const format = (env.INPUT_FORMAT || 'auto').trim()
  if (!FORMATS.has(format)) {
    problems.push(`format must be one of: ${[...FORMATS].join(', ')} (got "${format}")`)
  }
  return problems
}

export async function main() {
  if (!process.env.BELIQ_API_KEY) {
    issue('error', 'no beliq API key provided (set the `api-key` input from a repository secret)')
    process.exitCode = 1
    return
  }

  const problems = preflightProblems(process.env)
  if (problems.length > 0) {
    for (const problem of problems) issue('error', problem)
    process.exitCode = 1
    return
  }

  const globs = parseGlobs(process.env.INPUT_FILES || DEFAULT_FILES)
  const failOn = (process.env.INPUT_FAIL_ON || 'error').trim()
  const format = (process.env.INPUT_FORMAT || 'auto').trim()
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
    for (const r of batch) process.stdout.write(`${logLine(r)}\n`)
  })

  await writeSummary(results)
  await setOutputs(results)

  const { invalid } = aggregate(results)
  if (invalid > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
