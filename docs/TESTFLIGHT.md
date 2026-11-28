# TestFlight

Split is listed under Undrift LLC in App Store Connect. The bundle is `com.yoinklabs.split`, team `64PUT29XZ8`, App Store Connect app `6836072005`. The 0.8.0 build 10 adds Splitwise import and free currency conversion and is distributed to Yoink Internal and, after external beta review, Public Beta. The 0.7.1 UI consistency build is 9, distributed to Yoink Internal only. The 0.7 release uses build 8. It follows the member drill-down release 0.6.0 (7) and the 0.4 build 5. It adds the Splitwise-parity dashboard, friends, comments and likes, search, insights charts, Liquid Glass surfaces, the iPhone Duo layouts and receipt claimant chips on top of member statements and the web client.

[Public Beta](https://testflight.apple.com/join/YX8W6bCx) · [Live build and beta review status](https://appstoreconnect.apple.com/apps/6836072005/testflight/ios)

Yoink Internal receives every `main` build automatically through Xcode Cloud (below). Public Beta uses external beta review. A public-link installation depends on Apple approving an eligible build. Build 0.1.0 (2) was the preceding MVP. Both versions use the same Split Worker, bundle and shared Yoink sign-in.

## Automatic builds (Xcode Cloud)

Every push to `main` starts the Xcode Cloud workflow **TestFlight (main)**. It archives the `Split` scheme with Xcode 27.2 (App Store eligible) and its TestFlight Internal Testing post-action adds the build to **Yoink Internal**. The workflow never submits for App Store review or external beta review. Both stay manual in App Store Connect.

- [`ci_scripts/ci_post_clone.sh`](../ci_scripts/ci_post_clone.sh) installs XcodeGen and runs `xcodegen generate`, because `project.yml` is the source of truth and the project must match it.
- **Build numbers go up automatically.** Xcode Cloud stamps `CFBundleVersion` with its own build number, `CI_BUILD_NUMBER`, when it exports, overriding the project value. Builds 1–15 were uploaded by hand, so Split's Xcode Cloud **Next Build Number** is set to 16. That is the offset. The post-clone script writes `CI_BUILD_NUMBER` into `CURRENT_PROJECT_VERSION` so the archive agrees. It fails the build if the number is 15 or lower rather than produce an upload TestFlight would reject. Nobody edits `CURRENT_PROJECT_VERSION` by hand any more. The committed `'15'` is only the local fallback.
- `MARKETING_VERSION` in `project.yml` is still bumped by hand in the release PR when the version changes.
- [`scripts/create-xcode-cloud-workflow.sh`](../scripts/create-xcode-cloud-workflow.sh) creates or updates the workflow through the App Store Connect API (`asc`). The API cannot create the Xcode Cloud product or set the TestFlight post-action, so those two steps happen once in Xcode and App Store Connect.

One-time setup (Admin or App Manager):

1. In Xcode 27.2, open `Split.xcodeproj` (run `xcodegen generate` first), choose **Integrate → Create Workflow…**, select the **Split** app, and grant Xcode Cloud access to the `yoink-labs/split` GitHub repository when asked. Finish the onboarding with any workflow; the script replaces it.
2. In App Store Connect → Split → **Xcode Cloud → Settings → Build Number**, click **Edit** next to *Next Build Number* and set it to **16** (one above the latest TestFlight build).
3. Run `scripts/create-xcode-cloud-workflow.sh`, then delete any onboarding workflow you no longer want.
4. In App Store Connect → Split → **Xcode Cloud → Manage Workflows → TestFlight (main)**, add a **Post-Action → TestFlight Internal Testing** for the *Archive - iOS* action. Select **Yoink Internal** and save. Do not add *TestFlight External Testing* or any App Store post-action.

## Manual build (fallback)

Use this only when Xcode Cloud is unavailable. Take the build number from App Store Connect (one above the latest, including Xcode Cloud builds) and set it for that one archive only.

Install Xcode 27.2 with the iOS 27 SDK, XcodeGen and the App Store Connect CLI. The archive script defaults to `/Applications/Xcode-27.app/Contents/Developer`. Set `DEVELOPER_DIR` to the chosen Xcode 27 installation if it lives elsewhere. The script selects the device SDK explicitly. Split still deploys to iOS 18.0.

Use the authorized ASC profile and the existing Undrift distribution identity in the macOS keychain. Don't commit the build number change.

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

## App Store listing

For the next public App Store release, set the English App Store Connect name to **Split** and the subtitle to **Split expenses** under App Information. Keep the existing bundle ID and app icon.
