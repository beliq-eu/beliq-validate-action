import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGlobs,
  classify,
  aggregate,
  renderSummary,
  expandFiles,
  skippedDirsFor,
  DEFAULT_FILES,
  DEFAULT_CLI_VERSION,
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

describe('classify', () => {
  it('exit 0 with a valid result is a pass with its counts', () => {
    const r = classify('a.xml', 0, validJson)
    expect(r).toMatchObject({ file: 'a.xml', status: 'pass', format: 'cii', errors: 0, warnings: 0 })
  })
  it('exit 1 with an invalid result is a fail carrying the counts', () => {
    const r = classify('b.xml', 1, invalidJson)
    expect(r).toMatchObject({ status: 'fail', format: 'ubl', errors: 1, warnings: 1 })
  })
  it('exit 3 is an API error', () => {
    expect(classify('c.xml', 3, '').message).toBe('API error')
    expect(classify('c.xml', 3, '').status).toBe('error')
  })
  it('exit 2 is a usage error and exit 4 is an I/O error', () => {
    expect(classify('d.xml', 2, '').message).toBe('usage error')
    expect(classify('e.xml', 4, '').message).toBe('I/O error')
  })
  it('tolerates non-JSON stdout on a pass/fail exit', () => {
    const r = classify('f.xml', 1, 'not json')
    expect(r).toMatchObject({ status: 'fail', format: '', errors: 0, warnings: 0 })
  })
})

describe('aggregate', () => {
  it('counts anything that is not a pass as invalid', () => {
    const results = [
      classify('a', 0, validJson),
      classify('b', 1, invalidJson),
      classify('c', 3, ''),
    ]
    expect(aggregate(results)).toEqual({ total: 3, invalid: 2 })
  })
  it('is all-clear when every file passes', () => {
    expect(aggregate([classify('a', 0, validJson)])).toEqual({ total: 1, invalid: 0 })
  })
})

describe('renderSummary', () => {
  it('headlines the failing count and marks the failing row', () => {
    const md = renderSummary([classify('a', 0, validJson), classify('b', 1, invalidJson)])
    expect(md).toContain('1 of 2 file(s) not compliant')
    expect(md).toContain('| ✅ | `a` |')
    expect(md).toContain('| ❌ | `b` |')
    expect(md).toContain('not compliant')
  })
  it('headlines all-compliant when nothing fails', () => {
    expect(renderSummary([classify('a', 0, validJson)])).toContain('all 1 file(s) compliant')
  })
  it('shows the reason for an errored file', () => {
    expect(renderSummary([classify('a', 3, '')])).toContain('API error')
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

describe('the beliq-cli version is written in three files', () => {
  const repo = new URL('../', import.meta.url)
  const read = (rel) => readFile(new URL(rel, repo), 'utf8')

  // Where the pin lives, and how each file spells it. Adding a fourth site
  // means adding it here and to renovate.json's managerFilePatterns; the last
  // test in this block fails if the two lists disagree.
  const sites = [
    { path: 'action.yml', spelling: (v) => `default: '${v}'` },
    { path: 'runner.mjs', spelling: (v) => `DEFAULT_CLI_VERSION = '${v}'` },
    { path: '.github/workflows/test-action.yml', spelling: (v) => `beliq-cli@${v}` },
  ]

  it.each(sites)('$path pins the version runner.mjs exports', async ({ path, spelling }) => {
    expect(await read(path)).toContain(spelling(DEFAULT_CLI_VERSION))
  })

  it('no beliq-cli@latest survives anywhere', async () => {
    // README.md:62 promises that a full version tag freezes behaviour. The
    // validation runs in the CLI, so one `latest` left behind unfreezes it.
    for (const { path } of sites) {
      expect(await read(path), `${path} still floats the CLI`).not.toMatch(/beliq-cli@latest|'latest'/)
    }
  })
})

describe('the Renovate custom manager reads all three pins', () => {
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
