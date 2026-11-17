#!/usr/bin/env bash
set -euo pipefail
repo=${1:?repository}
tag=${2:?version tag}
archive=${3:?tarball}
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  # Retry a release without overwriting an asset that people already installed.
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  if gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | grep -Fxq "$(basename "$archive")"; then
    gh release download "$tag" --repo "$repo" --pattern "$(basename "$archive")" --dir "$dir"
    cmp "$archive" "$dir/$(basename "$archive")"
  else
    gh release upload "$tag" "$archive" --repo "$repo"
  fi
else
  gh release create "$tag" "$archive" --repo "$repo" --target main --title "Split CLI ${tag#split-v}" \
    --notes 'Install with `brew install yoink-labs/tap/split`. Run `split login` to connect a computer, or `split mcp` from your MCP client.'
fi
