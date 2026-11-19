#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-27.app/Contents/Developer}"
if ! version=$(xcodebuild -version) || [[ "$version" != "Xcode 27."* ]]; then
  echo "Select Xcode 27 with DEVELOPER_DIR (currently $DEVELOPER_DIR)." >&2
  exit 1
fi
if ! sdk=$(xcodebuild -version -sdk iphoneos SDKVersion) || [[ "$sdk" != 27.* ]]; then
  echo "The selected Xcode must provide the iOS 27 device SDK." >&2
  exit 1
fi

mkdir -p .ade/build
xcodegen generate
xcodebuild archive -project Split.xcodeproj -scheme Split -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath .ade/build/Split.xcarchive -derivedDataPath .ade/cache/release \
  CODE_SIGNING_ALLOWED=NO
