#!/usr/bin/env bash
# Fail if an em-dash (U+2014) appears in any source, docs, workflows, or examples.
# Org rule: no em-dashes in published / customer-facing text.
set -euo pipefail

targets=(runner.mjs test README.md action.yml examples .github)
existing=()
for t in "${targets[@]}"; do
  [ -e "$t" ] && existing+=("$t")
done

if grep -rn $'—' "${existing[@]}"; then
  echo "em-dash (U+2014) found in the files above; remove it before publishing."
  exit 1
fi
echo "no em-dash found"
