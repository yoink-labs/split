# TestFlight

Split is listed under Undrift LLC in App Store Connect. The bundle is `com.yoinklabs.split`, team `64PUT29XZ8`, App Store Connect app `6836072005`. The 0.8.0 build 10 adds Splitwise import and free currency conversion and is distributed to Yoink Internal and, after external beta review, Public Beta. The 0.7.1 UI consistency build is 9, distributed to Yoink Internal only. The 0.7 release uses build 8. It follows the member drill-down release 0.6.0 (7) and the 0.4 build 5. It adds the Splitwise-parity dashboard, friends, comments and likes, search, insights charts, Liquid Glass surfaces, the iPhone Duo layouts and receipt claimant chips on top of member statements and the web client.

[Public Beta](https://testflight.apple.com/join/YX8W6bCx) · [Live build and beta review status](https://appstoreconnect.apple.com/apps/6836072005/testflight/ios)

Yoink Internal receives builds automatically. Public Beta uses external beta review. A public-link installation depends on Apple approving an eligible build. Build 0.1.0 (2) was the preceding MVP. Both versions use the same Split Worker, bundle and shared Yoink sign-in.

## Build and sign

Install XcodeGen, Xcode and the App Store Connect CLI. Use the authorized ASC profile and the existing Undrift distribution identity in the macOS keychain. Check the next build number in App Store Connect before editing `project.yml`.

```sh
mkdir -p .ade/build .ade/tmp
xcodegen generate
xcodebuild archive -project Split.xcodeproj -scheme Split -configuration Release -destination 'generic/platform=iOS' -archivePath .ade/build/Split.xcarchive -derivedDataPath .ade/cache/release CODE_SIGNING_ALLOWED=NO
asc --profile default profiles download --id FZ2S8RH4U3 --output .ade/tmp/Split.mobileprovision
scripts/package-release.sh
```

The packaging script verifies the profile’s bundle ID, team and expiry, applies distribution entitlements and verifies the signature before creating the IPA. Signing material stays outside source control.

## Distribute

Upload after the release PR lands and verify the build’s processing state. The distribution groups are Yoink Internal (`6949ab6e-b7d2-4245-9a72-8a095832113f`) and Public Beta (`29476472-8917-4cd6-b916-d0d695dcc90e`).

```sh
asc --profile default publish testflight --app 6836072005 --ipa .ade/build/Split-0.7.0-8.ipa --group 29476472-8917-4cd6-b916-d0d695dcc90e --test-notes "Open your profile or a group member, choose a group, then open a charge. Add a receipt and mark who had each item with the new chips. Try search, insights, Liquid Glass, and the iPhone Duo open and closed layouts." --locale en-US --wait --submit --confirm
```

Confirm both group relationships, the internal testing state and the external review submission in App Store Connect.

## QA

Start with the standard email signup and verification flow. For repeat cross-account checks, run `scripts/qa/clerk-ticket.mjs alex` or `maya` through `ade secrets exec --env CLERK_SECRET_KEY`. It checks the tagged QA identity before issuing a five-minute sign-in ticket in ignored, owner-only lane storage. The Debug launch argument `-splitQATicketFile` accepts the file path. Release omits this hook.

The [usability audit](USABILITY.md) records the baseline and [the gallery](../screenshots/README.md) shows the revised UI.
