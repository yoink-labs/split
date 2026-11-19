#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != *.ipa ]]; then
  echo "Usage: scripts/upload-release.sh path/to/Split.ipa" >&2
  exit 1
fi

python3 "$(dirname "$0")/check-release-sdk.py" "$1"
exec asc --profile default publish testflight --app 6836072005 --ipa "$1" \
  --group 6949ab6e-b7d2-4245-9a72-8a095832113f --wait
