#!/usr/bin/env bash
# Every `uses:` must name a 40-character commit SHA.
#
# action.yml is the one that matters most: it runs inside the CALLER's CI, so a
# floating ref there resolves at their run time, to code and a `runs.using`
# runtime nobody here chose. A SHA pins both.
set -euo pipefail

files=("action.yml")
for w in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -e "$w" ] && files+=("$w")
done

bad=0
checked=0
for file in "${files[@]}"; do
  [ -e "$file" ] || continue
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    ref=$(printf '%s' "${hit#*:}" | sed -E \
      -e 's/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//' \
      -e 's/[[:space:]]+#.*$//' \
      -e 's/^["'"'"']//' -e 's/["'"'"']$//' \
      -e 's/[[:space:]]*$//')
    checked=$((checked + 1))
    # A ./-relative ref is the repo's own tree at the commit already checked
    # out; there is nothing to pin it to.
    case "$ref" in ./*) continue ;; esac
    if ! printf '%s' "$ref" | grep -qE '@[0-9a-f]{40}$'; then
      echo "unpinned: $file:$lineno -> $ref"
      bad=1
    fi
  done < <(grep -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^[:space:]]' "$file" || true)
done

if [ "$checked" -eq 0 ]; then
  echo "no 'uses:' found in ${files[*]}; the extraction is broken, not the tree"
  exit 1
fi

if [ "$bad" -ne 0 ]; then
  echo "pin each ref above to a 40-character commit SHA (keep the # vN comment)."
  exit 1
fi
echo "$checked uses: refs, all pinned to a commit SHA"
