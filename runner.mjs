import { spawnSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// The action's job: run the published beliq CLI over every matched e-invoice,
// summarize the verdicts, and fail the workflow if any file is not compliant.
// The CLI validates one file and returns the CI exit code; this runner owns the
// glob, the aggregation, the step summary, and the outputs.

const FAIL_ON = new Set(['error', 'warning'])
const FORMATS = new Set(['auto', 'cii', 'ubl'])
// spawn stdout cap: a validation result JSON is small, but a pathological
// document could produce a long error list. 16 MiB is well clear of that.
const MAX_BUFFER = 16 * 1024 * 1024

export function parseGlobs(input) {
  return String(input ?? '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim()) ?? ''
}

// Map a CLI (exitCode, stdout) pair to a normalized per-file result.
// The CLI contract: 0 valid, 1 invalid (per --fail-on), 2 usage, 3 API, 4 I/O.
export function classify(file, exitCode, stdout) {
  if (exitCode === 0 || exitCode === 1) {
    let parsed = null
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
    return {
      file,
      status: exitCode === 0 ? 'pass' : 'fail',
      format: parsed?.format ?? '',
      errors: parsed?.errors?.length ?? 0,
      warnings: parsed?.warnings?.length ?? 0,
      message: '',
    }
  }
  const reason =
    exitCode === 2 ? 'usage error'
      : exitCode === 3 ? 'API error'
        : exitCode === 4 ? 'I/O error'
          : `exit ${exitCode}`
  return { file, status: 'error', format: '', errors: 0, warnings: 0, message: reason }
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

async function expandFiles(globs) {
  const seen = new Set()
  for (const pattern of globs) {
    for await (const entry of glob(pattern)) {
      seen.add(entry)
    }
  }
  return [...seen].sort()
}

function validateFile(file, { cliVersion, format, failOn, baseUrl }) {
  const argv = ['-y', `beliq-cli@${cliVersion}`, 'validate', file, '--json', '--fail-on', failOn]
  if (format && format !== 'auto') argv.push('--format', format)
  const env = { ...process.env }
  if (baseUrl) env.BELIQ_BASE_URL = baseUrl
  const res = spawnSync('npx', argv, { encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
  if (res.error) return { exitCode: 4, stdout: '', stderr: String(res.error.message) }
  return { exitCode: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
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

  const globs = parseGlobs(process.env.INPUT_FILES || '**/*.xml')
  const failOnRaw = (process.env.INPUT_FAIL_ON || 'error').trim()
  const failOn = FAIL_ON.has(failOnRaw) ? failOnRaw : 'error'
  const formatRaw = (process.env.INPUT_FORMAT || 'auto').trim()
  const format = FORMATS.has(formatRaw) ? formatRaw : 'auto'
  const cliVersion = (process.env.INPUT_CLI_VERSION || 'latest').trim() || 'latest'
  const baseUrl = (process.env.INPUT_BASE_URL || '').trim()

  const files = await expandFiles(globs)
  if (files.length === 0) {
    issue('warning', `no files matched ${globs.join(', ')}`)
    await writeSummary([])
    await setOutputs([])
    return
  }

  const results = []
  for (const file of files) {
    const { exitCode, stdout, stderr } = validateFile(file, { cliVersion, format, failOn, baseUrl })
    const r = classify(file, exitCode, stdout)
    if (r.status === 'error' && stderr) r.message = `${r.message}: ${firstLine(stderr)}`
    results.push(r)
    process.stdout.write(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${file}\n`)
  }

  await writeSummary(results)
  await setOutputs(results)

  const { invalid } = aggregate(results)
  if (invalid > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
