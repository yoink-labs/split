#!/bin/bash
set -euo pipefail
# Uses an existing distribution identity; never exports a private key.
ARCHIVE="${1:-.ade/build/Split.xcarchive}"
APP="$ARCHIVE/Products/Applications/Split.app"
PROFILE='.ade/tmp/Split.mobileprovision'
IDENTITY='iPhone Distribution: Undrift LLC (64PUT29XZ8)'
security cms -D -i "$PROFILE" > .ade/tmp/profile.plist
python3 - <<'PY'
import plistlib, datetime
p=plistlib.load(open('.ade/tmp/profile.plist','rb'))
assert p['Entitlements']['application-identifier']=='64PUT29XZ8.com.yoinklabs.split'
assert p['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
assert not p['Entitlements'].get('get-task-allow',False)
plistlib.dump(p['Entitlements'],open('.ade/tmp/release-entitlements.plist','wb'))
PY
cp "$PROFILE" "$APP/embedded.mobileprovision"
xattr -cr "$APP"
# Xcode links Clerk statically; fail if future changes add executable frameworks.
if [ -d "$APP/Frameworks" ]; then
  echo 'Embedded frameworks need signing support before packaging.' >&2
  exit 1
fi
codesign --force --sign "$IDENTITY" --entitlements .ade/tmp/release-entitlements.plist "$APP"
codesign --verify --deep --strict "$APP"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Info.plist")
STAGING=$(mktemp -d .ade/build/ipa-stage.XXXXXX)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/Payload"
cp -R "$APP" "$STAGING/Payload/"
xattr -cr "$STAGING/Payload"
codesign --verify --deep --strict "$STAGING/Payload/Split.app"
OUTPUT="$PWD/.ade/build/Split-$VERSION-$BUILD.ipa"
# zip updates existing files; remove our prior output so stale resources cannot survive.
rm -f "$OUTPUT"
(cd "$STAGING" && COPYFILE_DISABLE=1 /usr/bin/zip -q -r "$OUTPUT" Payload)
echo "Packaged $OUTPUT"
