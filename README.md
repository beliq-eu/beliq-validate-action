# beliq-validate-action

Validate EU e-invoices (XRechnung, ZUGFeRD, Factur-X, Peppol BIS) in your CI against beliq's authority-pinned, drift-checked rules. Point it at your invoice files: a non-compliant document fails the build, and every run leaves a per-file table in the job summary.

It runs the published [`beliq-cli`](https://www.npmjs.com/package/beliq-cli), so the validation logic and the pass/fail contract are the same on your laptop and in CI.

## Usage

```yaml
- uses: beliq-eu/beliq-validate-action@v1
  with:
    files: 'dist/invoices/**/*.xml'
    api-key: ${{ secrets.BELIQ_API_KEY }}
```

A minimal workflow that validates every XML invoice in the repository:

```yaml
name: validate-invoices
on: [push, pull_request]
jobs:
  invoices:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: beliq-eu/beliq-validate-action@v1
        with:
          files: '**/*.xml'
          fail-on: error
          api-key: ${{ secrets.BELIQ_API_KEY }}
```

Get an API key from your beliq dashboard (the free tier is enough to evaluate) and store it as the `BELIQ_API_KEY` repository secret.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `files` | no | `**/*.xml` | Newline- or comma-separated glob(s) of e-invoice files to validate. |
| `format` | no | `auto` | Force the input syntax: `auto`, `cii`, or `ubl`. |
| `fail-on` | no | `error` | Severity threshold that fails the job: `error` or `warning`. |
| `api-key` | yes | | Your beliq API key. Pass it from a repository secret. |
| `base-url` | no | | Override the beliq API base URL (self-hosted deployments only). |
| `cli-version` | no | `latest` | Version of `beliq-cli` to run (an npm dist-tag or exact version). |

## Outputs

| Output | Description |
|---|---|
| `total` | Number of files validated. |
| `invalid` | Number of files that failed the threshold. |
| `results` | JSON array of per-file results (`{ file, status, format, errors, warnings, message }`). |

## Behavior

- The job **fails** (exit 1) if any file is not compliant at the chosen `fail-on` threshold, or if a file could not be validated (a bad key, quota, or unreadable file counts as a failure, not a silent pass).
- If no file matches `files`, the run logs a warning and passes: an empty match is not a compliance failure.
- Each run appends a Markdown table to the job's step summary: one row per file with its format, error/warning counts, and verdict.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH`, and a moving `v1` tag tracks the latest 1.x. Pin `@v1` for automatic compatible updates, or a full version (`@v1.0.0`) to freeze it.

Pushing a `v*.*.*` tag runs `.github/workflows/release.yml`, which checks the tree at that tag, moves the `v1` alias onto it and cuts the GitHub release. Never move `v1` by hand: the alias resolves in the caller's CI, so it must only ever name a tree those checks passed on.

## Development

```bash
npm install
npm run lint
npm run scrub:check   # no em-dash
npm run check         # runner.mjs parses
npm test              # pure-logic unit tests, no network
./scripts/check-action-pins.sh   # every uses: names a commit SHA
```

The live end-to-end test lives in `.github/workflows/test-action.yml`. It runs only when the `BELIQ_API_KEY` secret is present, validates a generated good fixture (expects 0 invalid) and a committed bad fixture (expects the job to fail), and so proves the action red-Xes a non-compliant invoice.

## License

MIT
