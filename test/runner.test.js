import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGlobs,
  classifyRun,
  validateAll,
  FILES_PER_RUN,
  aggregate,
  renderSummary,
  expandFiles,
  skippedDirsFor,
  DEFAULT_FILES,
  DEFAULT_CLI_VERSION,
  VERIFICATION_DOC,
  NO_VERDICT,
  verdictText,
  logLine,
} from '../runner.mjs'

// Pure-logic tests: no network, no CLI. The runner's I/O (spawning the CLI,
// expanding the glob, writing the step summary/outputs) is exercised live in
// .github/workflows/test-action.yml against the real API; here we pin the
// parsing, classification, aggregation, and rendering that decide pass/fail.

const validJson = JSON.stringify({ valid: true, format: 'cii', errors: [], warnings: [] })
const invalidJson = JSON.stringify({
  valid: false,
  format: 'ubl',
  errors: [{ ruleId: 'BR-01', severity: 'error', message: 'missing' }],
  warnings: [{ ruleId: 'BR-CL-01', severity: 'warning', message: 'odd code' }],
})

// Printed by `npx beliq-cli@0.2.2 validate inv/a.xml inv/b.xml inv/c.xml
// inv/d.xml --json` against a local stub API (exit 3, because c.xml errored).
const batchReport = readFileSync(new URL('./cli-0.2.2-batch.json', import.meta.url), 'utf8')
const batchFiles = ['inv/a.xml', 'inv/b.xml', 'inv/c.xml', 'inv/d.xml']

// Printed by `npx beliq-cli@0.4.0 validate <the four files> --json` against the
// live API with a sandbox key on 2026-10-13 (exit 0).
const liveBatch = readFileSync(new URL('./cli-0.4.0-batch.json', import.meta.url), 'utf8')
const liveFiles = JSON.parse(liveBatch).results.map((row) => row.file)

// The live API's answer to one validate of a French Factur-X document on the
// `previous` ruleset channel, 2026-10-11: `valid` is true and the result
// carries France CTC blocking rule ids. beliq-cli prints a single file's result
// unchanged with --json, and it cannot send the channel header itself.
const franceResult = readFileSync(new URL('./api-validate-france-previous.json', import.meta.url), 'utf8')

const noVerdict = { ...NO_VERDICT }
/** The verdict fields of a 0.2.2 row, which predates the badge. */
const unbadged = (valid) => ({ ...noVerdict, valid })

/** One file through classifyRun, for the tests that only need a row. */
const one = (file, exitCode, stdout, stderr) => classifyRun([file], exitCode, stdout, stderr).results[0]

describe('parseGlobs', () => {
  it('splits on commas and newlines and trims', () => {
    expect(parseGlobs('a.xml, b.xml\n c/*.xml')).toEqual(['a.xml', 'b.xml', 'c/*.xml'])
  })
  it('drops empty entries', () => {
    expect(parseGlobs('a.xml,,\n')).toEqual(['a.xml'])
  })
  it('returns [] for empty or nullish input', () => {
    expect(parseGlobs('')).toEqual([])
    expect(parseGlobs(undefined)).toEqual([])
  })
})

describe('classifyRun, one file', () => {
  it('exit 0 with a valid result is a pass with its counts', () => {
    expect(one('a.xml', 0, validJson)).toMatchObject({ file: 'a.xml', status: 'pass', format: 'cii', errors: 0, warnings: 0 })
  })
  it('exit 1 with an invalid result is a fail carrying the counts', () => {
    expect(one('b.xml', 1, invalidJson)).toMatchObject({ status: 'fail', format: 'ubl', errors: 1, warnings: 1 })
  })
  it('exit 3 is an API error carrying the first stderr line', () => {
    const run = classifyRun(['c.xml'], 3, '', 'beliq: API error 401 (INVALID_API_KEY): Invalid API key\n')
    expect(run.results[0]).toMatchObject({ status: 'error', message: 'API error: beliq: API error 401 (INVALID_API_KEY): Invalid API key' })
    expect(run.failed).toBe(true)
  })
  it('exit 2 is a usage error and exit 4 is an I/O error', () => {
    expect(one('d.xml', 2, '').message).toBe('usage error')
    expect(one('e.xml', 4, '').message).toBe('I/O error')
  })
  it('exit 1 without a verdict is an error, not a failed document', () => {
    // beliq-cli 0.2.2 exits 1 with empty stdout when the API cannot be reached.
    const run = classifyRun(['f.xml'], 1, '', 'beliq: unexpected error: fetch failed\n')
    expect(run.results[0]).toMatchObject({ status: 'error', message: 'no verdict (exit 1): beliq: unexpected error: fetch failed' })
    expect(run.failed).toBe(true)
  })
  it('exit 0 with unparseable stdout is not a pass either', () => {
    expect(one('g.xml', 0, 'not json').status).toBe('error')
  })
})

describe('classifyRun, a batch', () => {
  it('maps every row of the CLI batch report to its file', () => {
    const { results, failed } = classifyRun(batchFiles, 3, batchReport)
    expect(failed).toBe(false)
    expect(results).toEqual([
      { file: 'inv/a.xml', status: 'pass', format: 'cii', errors: 0, warnings: 0, message: '', ...unbadged(true) },
      { file: 'inv/b.xml', status: 'fail', format: 'cii', errors: 1, warnings: 0, message: '', ...unbadged(false) },
      { file: 'inv/c.xml', status: 'error', format: '', errors: 0, warnings: 0, message: 'API error 400 (PARSE_FAILED): Not an XML document', ...noVerdict },
      { file: 'inv/d.xml', status: 'pass', format: 'ubl', errors: 0, warnings: 1, message: '', ...unbadged(true) },
    ])
  })
  it('marks a requested file the report does not mention as an error', () => {
    const { results } = classifyRun([...batchFiles, 'inv/e.xml'], 3, batchReport)
    expect(results[4]).toMatchObject({ file: 'inv/e.xml', status: 'error', message: 'the CLI reported no result for this file' })
  })
  it('gives every file the reason when the run failed as a whole', () => {
    // A 401 stops a CLI batch before it prints a report.
    const { results, failed } = classifyRun(batchFiles, 3, '', 'beliq: API error 401 (INVALID_API_KEY): Invalid API key\n')
    expect(failed).toBe(true)
    expect(results.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error'])
    expect(results[3].message).toContain('INVALID_API_KEY')
  })
  it('does not read a bare validation result as the verdict for several files', () => {
    const { results, failed } = classifyRun(['a.xml', 'b.xml'], 0, validJson)
    expect(failed).toBe(true)
    expect(results.map((r) => r.status)).toEqual(['error', 'error'])
  })
})

describe('classifyRun over a live beliq-cli 0.4.0 batch', () => {
  // Every key of the CLI's rows, and what the action does with it. A key that
  // a re-recorded fixture adds fails the last test here until it is named, so
  // a new verdict field is a decision and not a silent drop.
  const ROW_KEYS = {
    file: 'output and summary',
    status: 'output and summary',
    valid: 'output and summary',
    format: 'output and summary',
    errors: 'output and summary, as a count',
    warnings: 'output and summary, as a count',
    verificationTier: 'output',
    verificationBadge: 'output',
    verificationBadgeLabel: 'output and summary, as the check depth',
    franceCtcBlockingRuleIds: 'output, and fails the file',
    pdfInput: 'output and summary',
    profileDetected: 'dropped: the format column names the syntax; the CLI prints the profile',
    ciusVersion: 'dropped: a ruleset detail, in the CLI output',
    schematronVersion: 'dropped: a ruleset detail, in the CLI output',
    rulesetArtifacts: 'dropped: a ruleset detail, in the CLI output',
    rulesetSha256: 'dropped: a ruleset detail, in the CLI output',
    sha256: 'dropped: the hash of a file the caller already holds',
    driftCheckedAt: 'dropped: a ruleset detail, in the CLI output',
    italyFatturapaRuntimeVersion: 'dropped: a ruleset detail, in the CLI output',
    italyFatturapaXsdBundle: 'dropped: a ruleset detail, in the CLI output',
    franceCtcApplied: 'dropped: a ruleset detail, in the CLI output',
    franceCtcVersion: 'dropped: a ruleset detail, in the CLI output',
    rulesetChannel: 'dropped: which channel served the verdict; the CLI prints it',
    rulesetFellBack: 'dropped: which channel served the verdict; the CLI prints it',
    rulesetSunsetsOn: 'dropped: which channel served the verdict; the CLI prints it',
  }

  it('carries the badge label of each verdict, and null where the API sent none', () => {
    const { results, failed } = classifyRun(liveFiles, 0, liveBatch)
    expect(failed).toBe(false)
    expect(results.map((r) => [r.file, r.status, r.valid, r.verificationBadgeLabel])).toEqual([
      ['authority-xrechnung-ubl.xml', 'pass', true, 'Authority-checked'],
      ['schema-fatturapa-fpr12.xml', 'pass', true, 'Schema-checked'],
      ['nobadge-fatturapa-fpa12.xml', 'pass', true, null],
      ['pdf-zugferd-2p1-en16931-einfach.pdf', 'pass', true, 'Authority-checked'],
    ])
    expect(results[0]).toMatchObject({ verificationTier: 'conformance-verified', verificationBadge: 'authority-verified' })
    expect(results[1]).toMatchObject({ verificationTier: 'xsd-structural', verificationBadge: 'structure-checked' })
    expect(results[3].pdfInput).toMatchObject({ attachmentName: 'factur-x.xml' })
  })

  it('names every key the CLI puts on a row', () => {
    for (const row of [...JSON.parse(liveBatch).results, { file: 'france', ...JSON.parse(franceResult) }]) {
      for (const key of Object.keys(row)) {
        expect(ROW_KEYS, `${row.file}: the CLI row key "${key}" is not named in ROW_KEYS`).toHaveProperty(key)
      }
    }
  })
})

describe('a France CTC block fails the file', () => {
  const france = JSON.parse(franceResult)

  it('the fixture is the case the rule exists for: valid, with blocking rule ids', () => {
    expect(france.valid).toBe(true)
    expect(france.franceCtcBlockingRuleIds.length).toBeGreaterThan(0)
  })

  it('in a one-file run that an older CLI passed with exit 0', () => {
    const r = one('fr.xml', 0, franceResult)
    expect(r).toMatchObject({ status: 'fail', valid: true, franceCtcBlockingRuleIds: france.franceCtcBlockingRuleIds })
    expect(r.message).toMatch(/^A plateforme agréée refuses/)
  })

  it('in a batch row that an older CLI marked as a pass', () => {
    const report = JSON.stringify({ results: [{ file: 'fr.xml', status: 'pass', ...france }] })
    expect(classifyRun(['fr.xml'], 0, report).results[0]).toMatchObject({ status: 'fail', valid: true })
  })

  it('names the ids itself when the block entry carries no message', () => {
    const noMessage = JSON.stringify({
      valid: true,
      format: 'cii',
      errors: [],
      warnings: [{ ruleId: 'FRANCE_CTC_FINDINGS_BLOCK_TRANSMISSION', severity: 'info' }],
      franceCtcBlockingRuleIds: ['BR-FR-10_BT-30'],
    })
    expect(one('fr.xml', 0, noMessage).message).toBe('France CTC blocking rule ids: BR-FR-10_BT-30')
  })

  it('names the ids itself when the API sent no message that names them all', () => {
    const bare = JSON.stringify({ valid: true, format: 'cii', errors: [], warnings: [], franceCtcBlockingRuleIds: ['BR-FR-10_BT-30'] })
    expect(one('fr.xml', 0, bare).message).toBe('France CTC blocking rule ids: BR-FR-10_BT-30')
  })

  it('leaves a result without ids as the CLI judged it', () => {
    expect(one('a.xml', 0, validJson)).toMatchObject({ status: 'pass', message: '', franceCtcBlockingRuleIds: [] })
  })
})

describe('validateAll', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => `f${i}.xml`)
  const passAll = (batch) => ({
    exitCode: 0,
    stdout: JSON.stringify({ results: batch.map((file) => ({ file, status: 'pass', valid: true, format: 'cii', errors: [], warnings: [] })) }),
    stderr: '',
  })

  it('sends the files in runs of FILES_PER_RUN, in order', () => {
    const runs = []
    const results = validateAll(files(FILES_PER_RUN + 2), {}, (batch) => {
      runs.push(batch.length)
      return batch.length === 1 ? { exitCode: 0, stdout: validJson, stderr: '' } : passAll(batch)
    })
    expect(runs).toEqual([FILES_PER_RUN, 2])
    expect(results).toHaveLength(FILES_PER_RUN + 2)
    expect(results.every((r) => r.status === 'pass')).toBe(true)
    expect(results.at(-1).file).toBe(`f${FILES_PER_RUN + 1}.xml`)
  })

  it('stops after a run that failed as a whole and marks the rest unchecked', () => {
    let calls = 0
    const results = validateAll(files(2 * FILES_PER_RUN + 1), {}, () => {
      calls++
      return { exitCode: 3, stdout: '', stderr: 'beliq: API error 429 (RATE_LIMITED): slow down' }
    })
    expect(calls).toBe(1)
    expect(results).toHaveLength(2 * FILES_PER_RUN + 1)
    expect(results.every((r) => r.status === 'error')).toBe(true)
    expect(results.at(-1).message).toBe('not checked: API error: beliq: API error 429 (RATE_LIMITED): slow down')
  })

  it('keeps going after a run whose files merely errored one by one', () => {
    let calls = 0
    validateAll(files(FILES_PER_RUN + 2), {}, (batch) => {
      calls++
      const results = batch.map((file) => ({ file, status: 'error', message: 'API error 400 (PARSE_FAILED): nope' }))
      return { exitCode: 3, stdout: JSON.stringify({ results }), stderr: '' }
    })
    expect(calls).toBe(2)
  })
})

describe('aggregate', () => {
  it('counts anything that is not a pass as invalid', () => {
    const results = [
      one('a', 0, validJson),
      one('b', 1, invalidJson),
      one('c', 3, ''),
    ]
    expect(aggregate(results)).toEqual({ total: 3, invalid: 2 })
  })
  it('is all-clear when every file passes', () => {
    expect(aggregate([one('a', 0, validJson)])).toEqual({ total: 1, invalid: 0 })
  })
})

describe('renderSummary', () => {
  const live = classifyRun(liveFiles, 0, liveBatch).results

  it('headlines the failing count and marks the failing row', () => {
    const md = renderSummary([one('a', 0, validJson), one('b', 1, invalidJson)])
    expect(md).toContain('## beliq validate: 1 of 2 file(s) failed')
    expect(md).toContain('| ✅ | `a` |')
    expect(md).toContain('| ❌ | `b` | ubl | - | 1 | 1 | invalid |')
  })
  it('headlines all-passed when nothing fails', () => {
    expect(renderSummary([one('a', 0, validJson)])).toContain('## beliq validate: all 1 file(s) passed')
  })
  it('shows the reason for an errored file', () => {
    expect(renderSummary([one('a', 3, '')])).toContain('API error')
  })
  it('gives each live verdict its check depth, and - where the API stated none', () => {
    const md = renderSummary(live)
    expect(md).toContain('| | File | Format | Check depth | Errors | Warnings | Verdict |')
    expect(md).toContain('| ✅ | `authority-xrechnung-ubl.xml` | ubl | Authority-checked | 0 | 1 | valid |')
    expect(md).toContain('| ✅ | `schema-fatturapa-fpr12.xml` | fatturapa | Schema-checked | 0 | 0 | valid |')
    expect(md).toContain('| ✅ | `nobadge-fatturapa-fpa12.xml` | fatturapa | - | 0 | 0 | valid |')
    expect(md).toContain(VERIFICATION_DOC)
  })
  it('says that a PDF verdict is about the embedded XML', () => {
    expect(renderSummary(live)).toContain(
      '| ✅ | `pdf-zugferd-2p1-en16931-einfach.pdf` | cii | Authority-checked | 0 | 0 | valid. The verdict is about the embedded XML; the PDF itself was not checked. |',
    )
  })
  it('never calls a verdict compliant', () => {
    const france = one('fr.xml', 0, franceResult)
    for (const results of [live, [france], [one('b', 1, invalidJson)], []]) {
      expect(renderSummary(results)).not.toMatch(/compliant/i)
    }
  })
  it('prints the France block in the API\'s words on one table line', () => {
    const md = renderSummary([one('fr.xml', 0, franceResult)])
    const row = md.split('\n').find((line) => line.includes('`fr.xml`'))
    expect(row).toMatch(/^\| ❌ \| `fr\.xml` \| cii \| Authority-checked \| 0 \| 10 \| valid\. A plateforme agréée refuses/)
  })
  it('keeps API text from breaking the table', () => {
    const report = JSON.stringify({ results: [{ file: 'x.xml', status: 'error', message: 'API error 400: a | b <Invoice>\nc' }] })
    const row = classifyRun(['x.xml'], 3, report).results[0]
    expect(renderSummary([row])).toContain('| API error 400: a \\| b &lt;Invoice&gt; c |')
  })
  it('keeps a backslash before a pipe from reopening the cell', () => {
    const report = JSON.stringify({ results: [{ file: 'x.xml', status: 'error', message: 'a \\| b' }] })
    const row = classifyRun(['x.xml'], 3, report).results[0]
    expect(renderSummary([row])).toContain('| a \\\\\\| b |')
  })
  it('does not call a verdict valid when the CLI row carries no valid field', () => {
    const report = JSON.stringify({ results: [{ file: 'n.xml', status: 'pass', format: 'ubl', errors: [], warnings: [] }] })
    expect(verdictText(classifyRun(['n.xml'], 0, report).results[0])).toBe('verdict not stated')
  })
  it('says no file matched for an empty match', () => {
    expect(renderSummary([])).toBe('## beliq validate: no file matched\n')
  })
})

describe('verdictText', () => {
  it('names the fail-on threshold for a valid file that failed without a France block', () => {
    const report = JSON.stringify({ results: [{ file: 'w.xml', status: 'fail', valid: true, format: 'ubl', errors: [], warnings: [{}] }] })
    expect(verdictText(classifyRun(['w.xml'], 1, report).results[0])).toBe('valid. Fails the `fail-on` threshold.')
  })
})

describe('logLine', () => {
  const live = classifyRun(liveFiles, 0, liveBatch).results
  it('gives each file its verdict and check depth', () => {
    expect(live.map(logLine)).toEqual([
      'PASS authority-xrechnung-ubl.xml (Authority-checked)',
      'PASS schema-fatturapa-fpr12.xml (Schema-checked)',
      'PASS nobadge-fatturapa-fpa12.xml (check depth not stated)',
      'PASS pdf-zugferd-2p1-en16931-einfach.pdf (Authority-checked)',
    ])
  })
  it('gives an errored file its reason', () => {
    expect(logLine(one('c.xml', 2, ''))).toBe('FAIL c.xml: usage error')
  })
})

describe('the default glob does not sweep the caller for billed calls', () => {
  // The action runs in someone else's checkout with their key, and every file
  // the glob returns is one validate call against their monthly quota. `**/*.xml`
  // otherwise matches the XML fixtures inside an installed npm package, a
  // Composer vendor tree and a build output.

  /** A throwaway tree with one real invoice and one of each trap. */
  async function fixtureTree() {
    const root = await mkdtemp(join(tmpdir(), 'beliq-glob-'))
    for (const dir of ['node_modules/pkg', 'vendor/lib', 'dist', 'invoices', '.git']) {
      await mkdir(join(root, dir), { recursive: true })
    }
    for (const file of [
      'invoices/real.xml',
      'node_modules/pkg/fixture.xml',
      'vendor/lib/fixture.xml',
      'dist/built.xml',
      '.git/config.xml',
    ]) {
      await writeFile(join(root, file), '<Invoice/>')
    }
    return root
  }

  async function expandIn(root, globs) {
    const cwd = process.cwd()
    process.chdir(root)
    try {
      return await expandFiles(globs)
    } finally {
      process.chdir(cwd)
    }
  }

  it('skips node_modules, vendor and dist under the default glob', async () => {
    const root = await fixtureTree()
    expect(await expandIn(root, [DEFAULT_FILES])).toEqual(['invoices/real.xml'])
  })

  it('finds those same files when the exclusion is lifted, so the fixture is real', async () => {
    // Without this, the test above would also pass on a glob that matched nothing.
    const root = await fixtureTree()
    const all = await expandIn(root, ['node_modules/**/*.xml', 'vendor/**/*.xml', 'dist/*.xml'])
    expect(all).toEqual(['dist/built.xml', 'node_modules/pkg/fixture.xml', 'vendor/lib/fixture.xml'])
  })

  it('honours a glob that names an excluded directory outright', async () => {
    const root = await fixtureTree()
    expect(await expandIn(root, ['vendor/lib/*.xml'])).toEqual(['vendor/lib/fixture.xml'])
  })

  it('leaves .git to node, which does not match dotted segments under **', async () => {
    const root = await fixtureTree()
    expect(await expandIn(root, [DEFAULT_FILES])).not.toContain('.git/config.xml')
  })

  it('drops only the named directories from a pattern', () => {
    expect(skippedDirsFor('**/*.xml')).toEqual(['node_modules', 'vendor', 'dist'])
    expect(skippedDirsFor('vendor/**/*.xml')).toEqual(['node_modules', 'dist'])
  })
})

describe('the files default is written in two files', () => {
  it('action.yml and runner.mjs declare the same one', async () => {
    // action.yml declares `default:` for the input; runner.mjs re-defaults
    // independently for an empty INPUT_FILES. Nothing but this binds them.
    const actionYml = await readFile(new URL('../action.yml', import.meta.url), 'utf8')
    const declared = actionYml.match(/ {2}files:[\s\S]*?default: '([^']+)'/)
    expect(declared, 'action.yml has no files default').not.toBeNull()
    expect(declared[1]).toBe(DEFAULT_FILES)
  })
})

describe('the beliq-cli version is written in four files', () => {
  const repo = new URL('../', import.meta.url)
  const read = (rel) => readFile(new URL(rel, repo), 'utf8')

  // Where the pin lives, and how each file spells it. Adding a fifth site
  // means adding it here and to renovate.json's managerFilePatterns; the last
  // test of the next block fails if the two lists disagree.
  const sites = [
    { path: 'action.yml', spelling: (v) => `default: '${v}'` },
    { path: 'runner.mjs', spelling: (v) => `DEFAULT_CLI_VERSION = '${v}'` },
    { path: '.github/workflows/test-action.yml', spelling: (v) => `beliq-cli@${v}` },
    { path: 'README.md', spelling: (v) => `depName=beliq-cli --> \`${v}\`` },
  ]

  it.each(sites)('$path pins the version runner.mjs exports', async ({ path, spelling }) => {
    expect(await read(path)).toContain(spelling(DEFAULT_CLI_VERSION))
  })

  it('no beliq-cli@latest survives anywhere', async () => {
    // README.md, "Versioning", promises that a full version tag freezes behaviour. The
    // validation runs in the CLI, so one `latest` left behind unfreezes it.
    for (const { path } of sites) {
      expect(await read(path), `${path} still floats the CLI`).not.toMatch(/beliq-cli@latest|'latest'/)
    }
  })
})

describe('the Renovate custom manager reads all four pins', () => {
  const repo = new URL('../', import.meta.url)
  const read = (rel) => readFile(new URL(rel, repo), 'utf8')

  async function manager() {
    const config = JSON.parse(await read('renovate.json'))
    const [only, ...rest] = config.customManagers ?? []
    expect(only, 'renovate.json declares no customManagers').toBeDefined()
    expect(rest, 'this test assumes exactly one custom manager').toHaveLength(0)
    return only
  }

  // `/^\.github/workflows/test-action\.yml$/` back to a plain path. Renovate's
  // patterns are anchored literals here on purpose; a pattern that is not one
  // fails this conversion rather than being silently half-read.
  function patternToPath(pattern) {
    const m = pattern.match(/^\/\^(.+)\$\/$/)
    expect(m, `managerFilePatterns entry is not an anchored literal: ${pattern}`).not.toBeNull()
    return m[1].replace(/\\(.)/g, '$1')
  }

  it('extracts npm/beliq-cli and the pinned version from every file it covers', async () => {
    const { matchStrings, managerFilePatterns } = await manager()
    expect(matchStrings).toHaveLength(1)
    const paths = managerFilePatterns.map(patternToPath)
    expect(paths.length).toBeGreaterThan(0)

    for (const path of paths) {
      // A fresh regex per file: /g carries lastIndex between calls.
      const found = [...(await read(path)).matchAll(new RegExp(matchStrings[0], 'g'))]
      expect(found, `the manager's regex matches nothing in ${path}`).toHaveLength(1)
      expect(found[0].groups).toMatchObject({
        datasource: 'npm',
        depName: 'beliq-cli',
        currentValue: DEFAULT_CLI_VERSION,
      })
    }
  })

  it('covers every file that carries a marker comment', async () => {
    // The manager is only as wide as its file list. A pin added with a marker
    // but without the list entry would never be updated, which is the freeze
    // this manager exists to prevent.
    const { managerFilePatterns } = await manager()
    const covered = new Set(managerFilePatterns.map(patternToPath))
    const candidates = [
      'action.yml',
      'runner.mjs',
      'README.md',
      'package.json',
      '.github/workflows/test-action.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
    ]
    for (const path of candidates) {
      const marked = /renovate: datasource=/.test(await read(path))
      expect(marked, `${path} carries a marker comment but renovate.json does not list it`)
        .toBe(covered.has(path))
    }
  })
})

describe('action.yml stays publishable to the GitHub Marketplace', () => {
  // The Marketplace refuses a release whose action.yml description is 125
  // characters or longer, and it only says so in the Edit release dialog,
  // after the tag is cut and the release is already published. v1.1.0 was
  // refused at 166 characters and needed a whole extra release to fix.
  const MARKETPLACE_DESCRIPTION_LIMIT = 125

  it(`declares a description shorter than ${MARKETPLACE_DESCRIPTION_LIMIT} characters`, async () => {
    const actionYml = await readFile(new URL('../action.yml', import.meta.url), 'utf8')
    const declared = actionYml.match(/^description: '([^']+)'$/m)
    expect(declared, 'action.yml has no top-level description').not.toBeNull()
    expect(declared[1].length).toBeLessThan(MARKETPLACE_DESCRIPTION_LIMIT)
  })
})
