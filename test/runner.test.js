import { describe, it, expect } from 'vitest'
import { parseGlobs, classify, aggregate, renderSummary } from '../runner.mjs'

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
