#!/bin/bash
set -euo pipefail
# Uses an existing distribution identity; never exports a private key.
ARCHIVE="${1:-.ade/build/Split.xcarchive}"
APP="$ARCHIVE/Products/Applications/Split.app"
PROFILE='.ade/tmp/Split.mobileprovision'
IDENTITY='iPhone Distribution: Undrift LLC (64PUT29XZ8)'
security cms -D -i "$PROFILE" > .ade/tmp/profile.plist
python3 - <<'PY'
import plistlib
p=plistlib.load(open('.ade/tmp/profile.plist','rb'))
assert p['Entitlements']['application-identifier']=='64PUT29XZ8.com.yoinklabs.split'
plistlib.dump(p['Entitlements'],open('.ade/tmp/release-entitlements.plist','wb'))
PY
cp "$PROFILE" "$APP/embedded.mobileprovision"
xattr -cr "$APP"
# Xcode links Clerk statically; there are no embedded frameworks to sign.
codesign --force --sign "$IDENTITY" --entitlements .ade/tmp/release-entitlements.plist "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p .ade/build/ipa/Payload
cp -R "$APP" .ade/build/ipa/Payload/
xattr -cr .ade/build/ipa/Payload
(cd .ade/build/ipa && COPYFILE_DISABLE=1 /usr/bin/zip -q -r ../Split-0.1.0-1.ipa Payload)
echo 'Packaged .ade/build/Split-0.1.0-1.ipa'
