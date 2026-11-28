#!/bin/bash
# Xcode Cloud: runs after the repository is cloned, before xcodebuild.
# project.yml is the source of truth, so generate Split.xcodeproj here.
set -euo pipefail
cd "${CI_PRIMARY_REPOSITORY_PATH:?Run this on Xcode Cloud}"

# Build numbers come from Xcode Cloud. Builds up to 15 were uploaded by hand,
# so Xcode Cloud's Next Build Number starts at 16 (App Store Connect → Split →
# Xcode Cloud → Settings → Build Number). Xcode Cloud stamps CFBundleVersion
# with CI_BUILD_NUMBER on export; mirror it in the project so the archive agrees.
LAST_MANUAL_BUILD=15
number="${CI_BUILD_NUMBER:-}"
if [[ ! "$number" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: CI_BUILD_NUMBER must be a positive integer (got '$number')." >&2
  exit 1
fi
if (( number <= LAST_MANUAL_BUILD )); then
  echo "error: Xcode Cloud build number $number would collide with a TestFlight build already uploaded (1-$LAST_MANUAL_BUILD)." >&2
  echo "Set Next Build Number to $((LAST_MANUAL_BUILD + 1)) or higher in App Store Connect → Split → Xcode Cloud → Settings → Build Number." >&2
  exit 1
fi
sed -i '' -E "s/^( *CURRENT_PROJECT_VERSION: ).*/\1'$number'/" project.yml
grep -q "CURRENT_PROJECT_VERSION: '$number'" project.yml || { echo "error: could not set CURRENT_PROJECT_VERSION in project.yml" >&2; exit 1; }
echo "Build number: $number"

brew install xcodegen
xcodegen generate
