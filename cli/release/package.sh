#!/usr/bin/env bash
set -euo pipefail
version=$(node -p "require('./cli/release/version.json')")
[[ "${1:?Supply a split-vX.Y.Z tag}" == "split-v$version" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "CLI version and tag must match" >&2; exit 1; }
out=${2:?Supply an output directory}
mkdir -p "$out"
# An explicit file list keeps server code, local config and test data private.
archive="$out/split-$version.tar.gz"
git archive --format=tar --prefix="split-$version/" HEAD -- \
  cli/bin/split cli/split.mjs cli/lib/catalog.mjs cli/lib/client.mjs cli/lib/stdio.mjs cli/release/version.json cli/README.md | gzip -n > "$archive"
sha=$(shasum -a 256 "$archive" | cut -d ' ' -f1)
sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/g" cli/release/split.rb.in > "$out/split.rb"
echo "$sha  split-$version.tar.gz"
