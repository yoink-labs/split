#!/usr/bin/env bash
set -euo pipefail

declared=$(node -p "require('./cli/release/version.json')")
version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$declared" =~ $version_pattern ]] || { echo 'CLI release version must be X.Y.Z.' >&2; exit 1; }

latest=$(git tag --merged HEAD --list 'split-v*' --sort=-version:refname |
  awk '/^split-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && !found { print; found=1 }')
if [[ -z "$latest" ]] || [[ "$(printf '%s\n' "$latest" "split-v$declared" | sort -V | tail -n 1)" != "$latest" ]]; then
  printf 'split-v%s\n' "$declared"
  exit 0
fi

# A rerun can finish publishing a tag after a failed release or tap push.
if [[ "$(git rev-parse HEAD)" == "$(git rev-list -n 1 "$latest")" ]]; then
  printf '%s\n' "$latest"
elif ! git diff --quiet "$latest" HEAD -- cli/bin cli/lib cli/split.mjs cli/package.json \
  cli/release/package.sh cli/release/split.rb.in; then
  printf '%s.%d\n' "${latest%.*}" "$(( ${latest##*.} + 1 ))"
fi
