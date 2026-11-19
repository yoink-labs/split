#!/usr/bin/env python3
"""Check the SDK stamped into Split's archived or packaged app."""
import plistlib
import re
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

path = Path(sys.argv[1])
try:
    if path.suffix == ".ipa":
        with ZipFile(path) as ipa:
            metadata = plistlib.loads(ipa.read("Payload/Split.app/Info.plist"))
    else:
        with path.open("rb") as plist:
            metadata = plistlib.load(plist)
except (OSError, ValueError, KeyError, BadZipFile) as error:
    sys.exit(f"Cannot read release metadata from {path}: {error}")

sdk = str(metadata.get("DTSDKName", "missing"))
xcode = str(metadata.get("DTXcode", "missing"))
if not re.fullmatch(r"iphoneos27(?:\.\d+)+", sdk) or not re.fullmatch(r"27\d{2}", xcode):
    sys.exit(
        f"Expected an Xcode 27 / iOS 27 device archive, got DTSDKName={sdk} "
        f"DTXcode={xcode}. Run scripts/archive-release.sh."
    )
print(f"Release metadata: DTSDKName={sdk} DTXcode={xcode}")
