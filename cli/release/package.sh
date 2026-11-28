#!/usr/bin/env bash
set -euo pipefail
tag=${1:?Supply a split-vX.Y.Z tag}
[[ "$tag" =~ ^split-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "Invalid CLI version tag" >&2; exit 1; }
version=${tag#split-v}
declared=$(node -p "require('./cli/release/version.json')")
out=${2:?Supply an output directory}
mkdir -p "$out"

# Archive only committed client files. For automatic patch releases, the tag
# supplies the runtime version without a version-only commit on main.
prefix="split-$version/"
archive="$out/split-$version.tar.gz"
files=(cli/bin/split cli/split.mjs ':(glob)cli/lib/*.mjs' cli/README.md)
options=(--format=tar --prefix="$prefix")
if [[ "$version" == "$declared" ]]; then
  files+=(cli/release/version.json)
else
  options+=(--add-virtual-file="${prefix}cli/release/version.json:\"$version\"")
fi
git archive "${options[@]}" HEAD -- "${files[@]}" | gzip -n > "$archive"
sha=$(shasum -a 256 "$archive" | cut -d ' ' -f1)
sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/g" cli/release/split.rb.in > "$out/split.rb"
echo "$sha  split-$version.tar.gz"
