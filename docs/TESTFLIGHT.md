# TestFlight

Split is listed under Undrift LLC in App Store Connect. The bundle is `com.yoinklabs.split`, team `64PUT29XZ8`, App Store Connect app `6836072005`. The 0.8.0 build 10 adds Splitwise import and free currency conversion and is distributed to Yoink Internal and, after external beta review, Public Beta. The 0.7.1 UI consistency build is 9, distributed to Yoink Internal only. The 0.7 release uses build 8. It follows the member drill-down release 0.6.0 (7) and the 0.4 build 5. It adds the Splitwise-parity dashboard, friends, comments and likes, search, insights charts, Liquid Glass surfaces, the iPhone Duo layouts and receipt claimant chips on top of member statements and the web client.

[Public Beta](https://testflight.apple.com/join/YX8W6bCx) · [Live build and beta review status](https://appstoreconnect.apple.com/apps/6836072005/testflight/ios)

Yoink Internal receives builds automatically. Public Beta uses external beta review. A public-link installation depends on Apple approving an eligible build. Build 0.1.0 (2) was the preceding MVP. Both versions use the same Split Worker, bundle and shared Yoink sign-in.

## Build and sign

Install Xcode 27.2 with the iOS 27 SDK, XcodeGen and the App Store Connect CLI. The archive script defaults to `/Applications/Xcode-27.app/Contents/Developer`. Set `DEVELOPER_DIR` to the chosen Xcode 27 installation if it lives elsewhere. The script selects the device SDK explicitly. Split still deploys to iOS 18.0.

Use the authorized ASC profile and the existing Undrift distribution identity in the macOS keychain. Check the next build number in App Store Connect before editing `project.yml`.

```sh
scripts/archive-release.sh
mkdir -p .ade/tmp
asc --profile default profiles download --id FZ2S8RH4U3 --output .ade/tmp/Split.mobileprovision
scripts/package-release.sh
```

The packaging script prints the app's `DTSDKName` and `DTXcode` and requires an iOS 27 device SDK and Xcode 27 before signing. For Xcode 27.2, expect `iphoneos27.2` and `2720`. It also checks the profile’s bundle ID, team and expiry and verifies the signature before creating the IPA.

## Distribute

After the release PR lands, set `SPLIT_IPA` to the path printed by the packaging script. Upload the IPA and wait for processing. The upload script rechecks the IPA’s SDK metadata and targets Yoink Internal only.

```sh
scripts/upload-release.sh "${SPLIT_IPA:?Set SPLIT_IPA to the packaged IPA path}"
```

In App Store Connect, confirm that the same version and build finished processing and appears in Yoink Internal. Record the SDK metadata from packaging and check the release mailbox for ITMS-90725 once processing completes. Public Beta distribution is a separate decision. Leave build 0.8.0 (10) in external review until Harris approves a replacement.

## QA

Start with the standard email signup and verification flow. For repeat cross-account checks, run `scripts/qa/clerk-ticket.mjs alex` or `maya` through `ade secrets exec --env CLERK_SECRET_KEY`. It checks the tagged QA identity before issuing a five-minute sign-in ticket in ignored, owner-only lane storage. The Debug launch argument `-splitQATicketFile` accepts the file path. Release omits this hook.

The [usability audit](USABILITY.md) records the baseline and [the gallery](../screenshots/README.md) shows the revised UI.
