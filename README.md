# beliq-validate-action

Validate e-invoices (XRechnung, ZUGFeRD, Factur-X, Peppol BIS, FatturaPA and the other formats beliq checks) in your CI. Point it at your invoice files: an invalid document fails the build, and every run leaves a per-file table in the job summary with each verdict and how deep its check went.

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

The default `files` glob matches XML only. To check hybrid ZUGFeRD/Factur-X PDFs as well (the CLI validates the XML embedded in them), widen it:

```yaml
- uses: beliq-eu/beliq-validate-action@v1
  with:
    files: 'invoices/**/*.{xml,pdf}'
    api-key: ${{ secrets.BELIQ_API_KEY }}
```

## Requirements

- **Linux or macOS runners.** Windows runners are not supported.
- **Node.js 22, set up by the action.** It runs `actions/setup-node` with Node 22, and that Node stays first on the `PATH` for the rest of the job. If a later step needs a different version, run `actions/setup-node` again after this action.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `files` | no | `**/*.xml` | Newline- or comma-separated glob(s) of e-invoice files to validate. XML only by default; use `**/*.{xml,pdf}` to include hybrid ZUGFeRD/Factur-X PDFs. |
| `format` | no | `auto` | Force the input syntax: `auto`, `cii`, or `ubl`. |
| `fail-on` | no | `error` | Severity threshold that fails the job: `error` or `warning`. |
| `api-key` | yes | | Your beliq API key. Pass it from a repository secret. |
| `base-url` | no | | Override the beliq API base URL (self-hosted deployments only). |
| `cli-version` | no | <!-- renovate: datasource=npm depName=beliq-cli --> `0.4.0` | Version of `beliq-cli` to run (an exact version or an npm dist-tag). Defaults to the exact version this action release was tested against; pass `latest` to follow the CLI instead. |

A `format` or `fail-on` value outside the listed ones fails the step before any file is sent.

## Outputs

| Output | Description |
|---|---|
| `total` | Number of files validated. |
| `invalid` | Number of files that failed the threshold. |
| `results` | JSON array of per-file results (`{ file, status, format, errors, warnings, message, valid, verificationTier, verificationBadge, verificationBadgeLabel, franceCtcBlockingRuleIds, pdfInput }`). `status` is `pass`, `fail` or `error`; `valid` and the three verification fields are the API's own values, `null` where it sent none. |

## Behavior

- Every matched file goes to the beliq API, which detects its format. The formats beliq checks, each with its rule pack, version and check depth, are listed at https://docs.beliq.eu/api-reference/rulesets/. A file the API cannot read or does not check gets an error row with the API's reason.
- The job **fails** (exit 1) if any file fails the chosen `fail-on` threshold, carries France CTC blocking rule ids, or could not be validated (a bad key, quota, or unreadable file counts as a failure, not a silent pass).
- A result with France CTC blocking rule ids (`franceCtcBlockingRuleIds`) fails its file under either `fail-on` value, also where `valid` is true: the API reports those ids as ending a transmission. The action applies this itself, so an older `cli-version` such as 0.3.0 does not pass such a file either.
- If no file matches `files`, the run logs a warning and passes: an empty match is not a failed check.
- Each run appends a Markdown table to the job's step summary: one row per file with its format, check depth, error/warning counts, and verdict. The verdict is the API's own word, `valid` or `invalid`. The check depth is the badge label the API gave the verdict, or `-` where it stated none; what each label means is at https://docs.beliq.eu/compliance/how-verification-works/. For a PDF the verdict is about the XML embedded in it, and the row says so.
- Files go to `beliq-cli` in batches of up to 100 per process. A refused key, a forbidden request or a rate limit stops the run: the files not yet sent are reported as not checked, rather than each spending another call on the same answer.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH`, and a moving `v1` tag tracks the latest 1.x. Pin `@v1` to follow it, or a full version (`@v1.3.0`) to freeze it. A 1.x release keeps the inputs and the outputs, which can only gain fields. It can still turn a passing job red: a release moves the CLI pin, and a newer CLI can fail a file that an older one passed.

Freezing means the whole thing. The validation itself runs in `beliq-cli`, which the action installs at run time, so a floating CLI would keep changing under a frozen action tag. Each release therefore defaults `cli-version` to one exact CLI version, and that default is part of what the tag freezes. Renovate raises a PR here when a newer `beliq-cli` ships, so the pin moves on a reviewed release rather than silently on every run. Set `cli-version` yourself to override it either way, including to `latest`.

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

The live end-to-end test lives in `.github/workflows/test-action.yml`. It runs only when the `BELIQ_API_KEY` secret is present, validates a generated good fixture (expects 0 invalid and a badge label in its `results` row) and a committed bad fixture (expects the job to fail), and so proves the action red-Xes an invalid invoice.

## License

MIT
