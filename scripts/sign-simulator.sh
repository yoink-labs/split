#!/bin/bash
set -euo pipefail
# Some macOS file providers add FinderInfo to build bundles, which codesign rejects.
# After a metadata-only signing failure, finish the ad-hoc signature with
# Xcode’s own entitlements (simulator entitlements are embedded by the linker).
APP='.ade/cache/ios-simulator/DerivedData/Build/Products/Debug-iphonesimulator/Split.app'
xattr -cr "$APP"
codesign --force --sign - --deep --entitlements .ade/cache/ios-simulator/DerivedData/Build/Intermediates.noindex/Split.build/Debug-iphonesimulator/Split.build/Split.app.xcent "$APP"
codesign --verify "$APP"
