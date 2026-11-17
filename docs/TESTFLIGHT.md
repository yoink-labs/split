# Internal TestFlight release

## Registered assets

- Bundle ID: `com.yoinklabs.split` (`VQ4YR3F8D6`)
- Team: `64PUT29XZ8`
- Capabilities: Sign in with Apple (primary app) and Associated Domains
- App Store profile: `Split App Store` (`FZ2S8RH4U3`)
- ASC CLI profile: `default`, key ID `2VGQN75FV5`
- Version/build: `0.1.0 (1)`

## Confirmed Clerk blocker

On the ADE simulator, Google sign-in returns: “The current redirect url passed in the sign in or sign up request does not match an authorized redirect URI for this instance.” The rejected URI is `com.yoinklabs.split://callback`. In the existing Yoink Labs **production** Clerk instance, open **Native applications → Allowlist for mobile SSO redirect**, add `com.yoinklabs.split://callback`, and save. On the same Native applications page, ensure an iOS app exists with bundle `com.yoinklabs.split` and team `64PUT29XZ8`. The agent stopped at this gate, as requested; no dashboard settings were changed. Apple/email authentication and real-account sync are not yet validated.

## Current blocker: app record

`asc apps list --bundle-id com.yoinklabs.split` returns no app. The public API does not create app records (`asc apps create` is removed; the CLI routes creation through `asc web apps create`). `asc web auth status` reports no authenticated web session. Per Harris's instruction, stop at this step instead of changing logins or using a dashboard workaround.

Harris: go to **App Store Connect → Apps → + → New App**:

1. Platform: **iOS**
2. Name: **Split by Yoink Labs** (the home-screen name remains Split)
3. Primary language: **English (U.S.)**
4. Bundle ID: **Split by Yoink Labs — com.yoinklabs.split**
5. SKU: **YOINK-SPLIT-IOS**
6. User access: **Full Access**
7. Click **Create**. Share the new app ID or simply confirm it exists.

## After the app record exists

Use the `asc` CLI with `--profile default`. Create **Yoink Internal** with `--internal --access-all-builds` **at creation time**. Apple does not let an existing group's automatic distribution flag be retrofitted reliably. Add `harris@undrift.dev` as an internal tester (an App Store Connect user with access), then upload build 1 and verify processing and group availability. Do not submit external beta review.

```sh
asc --profile default testflight groups create --app APP_ID --name 'Yoink Internal' --internal --access-all-builds
# Discover exact tester/build command flags with asc testflight --help and asc builds upload --help.
```

Every later development build should increment `CURRENT_PROJECT_VERSION`, use the same automatically distributing internal group, and verify the processed build is available to that group. Keep the app free. Tip jar products are not part of this build.

## Build

```sh
xcodegen generate
asc xcode archive --project Split.xcodeproj --scheme Split --configuration Release --archive-path .ade/build/Split.xcarchive --xcodebuild-flag=-derivedDataPath --xcodebuild-flag=.ade/cache/archive --xcodebuild-flag=CODE_SIGNING_ALLOWED=NO
asc --profile default profiles download --id FZ2S8RH4U3 --output .ade/tmp/Split.mobileprovision
scripts/package-release.sh
```

The packaging helper uses the distribution identity already installed on this Mac. It signs the archived app with the downloaded profile, verifies the signature, and packages an IPA without exporting a private key or installing profiles outside the lane. Keep all archives, profiles and IPA files in ignored `.ade/` storage. The app links Clerk statically; update the helper if embedded frameworks/extensions are added.

An archive or local signature is not proof of an accepted TestFlight upload. Apple processing and real-device sign-in remain release checks.

## Handoff state

The Release archive compiled as 0.1.0 (1). It is unsigned; packaging/signing, upload, processing, internal group creation, and tester assignment remain pending. The packaging helper is prepared but has not been run. No TestFlight build exists yet.
