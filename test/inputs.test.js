import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightProblems } from '../runner.mjs'

const runner = fileURLToPath(new URL('../runner.mjs', import.meta.url))

describe('preflightProblems', () => {
  it('accepts the defaults and every listed value', () => {
    expect(preflightProblems({}, 'linux')).toEqual([])
    for (const failOn of ['error', 'warning']) {
      for (const format of ['auto', 'cii', 'ubl']) {
        expect(preflightProblems({ INPUT_FAIL_ON: failOn, INPUT_FORMAT: format }, 'darwin')).toEqual([])
      }
    }
  })

  it('names an unknown fail-on or format instead of falling back to the default', () => {
    expect(preflightProblems({ INPUT_FAIL_ON: 'warnings', INPUT_FORMAT: 'xml' }, 'linux')).toEqual([
      'fail-on must be one of: error, warning (got "warnings")',
      'format must be one of: auto, cii, ubl (got "xml")',
    ])
  })

  it('refuses a Windows runner', () => {
    expect(preflightProblems({}, 'win32')).toEqual([
      'Windows runners are not supported; run this step on a Linux or macOS runner',
    ])
  })
})

describe('runner.mjs with a bad input', () => {
  // The real script in a real process. It must stop before the glob or the
  // CLI. An empty directory and a dead base URL keep a regression from
  // reaching the network: it would find no files and pass instead.
  it('fails the step with an ::error:: line and sends nothing', () => {
    const res = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      cwd: mkdtempSync(join(tmpdir(), 'beliq-inputs-')),
      env: {
        PATH: process.env.PATH,
        BELIQ_API_KEY: 'blq_test_x',
        INPUT_BASE_URL: 'http://127.0.0.1:9',
        INPUT_FAIL_ON: 'warnings',
      },
    })
    expect(res.status).toBe(1)
    expect(res.stdout).toBe('::error::beliq-validate: fail-on must be one of: error, warning (got "warnings")\n')
  })
})
