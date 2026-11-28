#!/bin/bash
# Creates (or updates) Split's "TestFlight (main)" Xcode Cloud workflow through
# the App Store Connect API. Run once after Split is onboarded to Xcode Cloud
# (docs/TESTFLIGHT.md → "Xcode Cloud"). Needs the authorized `asc` profile.
#
# The API cannot set a TestFlight post-action, so add "TestFlight Internal
# Testing → Yoink Internal" in App Store Connect afterwards. The workflow never
# submits for App Store review.
set -euo pipefail

APP_ID=6836072005
NAME="TestFlight (main)"
XCODE_27_2=8330ad8b-821d-4f60-afe3-8a598385c7e9     # "Xcode 27.2" (27B52)
MACOS=b2747d10-9b4e-44ef-ab11-cde6ac42ab31          # "macOS Golden Gate 27.2.1", paired with Xcode 27.2
asc() { command asc --profile "${ASC_PROFILE:-default}" "$@"; }

product=$(asc xcode-cloud products list --output json | jq -r --arg app "$APP_ID" \
  '.data[] | select(.relationships.app.data.id == $app or .attributes.name == "Split") | .id' | head -1)
if [[ -z "$product" ]]; then
  # Fall back to matching each product's app.
  for id in $(asc xcode-cloud products list --output json | jq -r '.data[].id'); do
    [[ "$(asc xcode-cloud products app --id "$id" --output json | jq -r .data.id)" == "$APP_ID" ]] && product=$id && break
  done
fi
[[ -n "$product" ]] || { echo "Split has no Xcode Cloud product yet. Onboard it in Xcode first (docs/TESTFLIGHT.md)." >&2; exit 1; }

repo=$(asc xcode-cloud products primary-repositories --id "$product" --output json | jq -r '.data[0].id // empty')
[[ -n "$repo" ]] || { echo "Xcode Cloud has no repository for Split. Grant it access to yoink-labs/split." >&2; exit 1; }

payload=$(mktemp)
trap 'rm -f "$payload"' EXIT
attributes=$(jq -n --arg name "$NAME" '{
  name: $name,
  description: "Every push to main: archive Split with Xcode 27.2 for TestFlight (Yoink Internal). Never submits for App Store review.",
  branchStartCondition: { source: { isAllMatch: false, patterns: [{ pattern: "main", isPrefix: false }] }, autoCancel: false },
  actions: [{ name: "Archive - iOS", actionType: "ARCHIVE", platform: "IOS", scheme: "Split",
              buildDistributionAudience: "APP_STORE_ELIGIBLE", isRequiredToPass: true }],
  isEnabled: true, isLockedForEditing: false, clean: true, containerFilePath: "Split.xcodeproj"
}')
relationships=$(jq -n --arg x "$XCODE_27_2" --arg m "$MACOS" '{
  xcodeVersion: { data: { type: "ciXcodeVersions", id: $x } },
  macOsVersion: { data: { type: "ciMacOsVersions", id: $m } }
}')

existing=$(asc xcode-cloud workflows list --app "$APP_ID" --output json | jq -r --arg name "$NAME" '.data[] | select(.attributes.name == $name) | .id' | head -1)
if [[ -n "$existing" ]]; then
  jq -n --arg id "$existing" --argjson a "$attributes" --argjson r "$relationships" \
    '{ data: { type: "ciWorkflows", id: $id, attributes: $a, relationships: $r } }' > "$payload"
  asc xcode-cloud workflows update --id "$existing" --file "$payload" --output json | jq '{id: .data.id, name: .data.attributes.name}'
else
  jq -n --arg p "$product" --arg repo "$repo" --argjson a "$attributes" --argjson r "$relationships" \
    '{ data: { type: "ciWorkflows", attributes: $a, relationships: ($r + {
        product: { data: { type: "ciProducts", id: $p } },
        repository: { data: { type: "scmRepositories", id: $repo } } }) } }' > "$payload"
  asc xcode-cloud workflows create --file "$payload" --output json | jq '{id: .data.id, name: .data.attributes.name}'
fi
