# TestFlight release

- App: Split by Yoink Labs, `6836072005`, SKU `YOINK-SPLIT-IOS`
- Bundle: `com.yoinklabs.split`, team `64PUT29XZ8`
- Profile: Split App Store (`FZ2S8RH4U3`); ASC profile `default`, key `2VGQN75FV5`
- Public beta: https://testflight.apple.com/join/YX8W6bCx
- Version: 0.1.0 (2), with original light/dark/tinted icons and direct invite copying.

## Distribution

Build 2 (`275fcbca-0bd5-45b6-bdd0-f156d67c6c85`) was submitted at 2026-11-17 22:56 UTC. Apple reports `WAITING_FOR_BETA_REVIEW` externally and `READY_FOR_BETA_TESTING` internally; automatic notifications are enabled. Both groups are confirmed attached.

Harris approved external beta review on 2026-11-17. Public Beta (`29476472-8917-4cd6-b916-d0d695dcc90e`) has its public link enabled, limit 1,000, and harris@undrift.dev added. Beta description, feedback email, privacy/marketing URLs and review contacts are configured. Public installation requires Apple's beta review approval.

Yoink Internal (`6949ab6e-b7d2-4245-9a72-8a095832113f`) was created with automatic access to all builds. Builds 1 and 2 processed successfully and are available internally. Apple rejected harris@undrift.dev as an internal tester because it is not an App Store Connect team user. Harris's existing account-holder email differs; no team roles or email addresses were changed. The requested address is added to Public Beta instead.

## Verification

The Clerk redirect/native registration and ASC app-record blockers are cleared. Google now reaches the accounts.google.com sign-in form for yoinklabs.dev. Full provider credential completion is not claimed. Real Clerk sessions from two isolated tagged QA accounts verified production sync and group invites on the simulator: Alex created a group and ARS 24,000 expense, generated/copied the invite, Maya joined through the HTTPS universal link and inherited ARS 12,000 owed to Alex. Opening the website in Safari and tapping Open Split verified the custom-scheme fallback and idempotent rejoin.

Seven Worker tests and TypeScript checking pass. Five ledger/outbox iOS tests passed during initial implementation. The final Debug app compiled and ran on ADE's simulator; release archive compilation, distribution signing and strict signature verification pass. Release binary has no Debug ticket-file hook. Fresh light/dark screenshots are under `screenshots/`.

## Rebuild

```sh
xcodegen generate
asc xcode archive --project Split.xcodeproj --scheme Split --configuration Release --archive-path .ade/build/Split.xcarchive --xcodebuild-flag=-derivedDataPath --xcodebuild-flag=.ade/cache/ios-simulator/DerivedData --xcodebuild-flag=CODE_SIGNING_ALLOWED=NO
asc --profile default profiles download --id FZ2S8RH4U3 --output .ade/tmp/Split.mobileprovision
scripts/package-release.sh
```

The helper uses the installed distribution identity, embeds the profile, verifies the signature, and packages an IPA entirely in ignored `.ade/` storage. It never exports a private key. Increment the build number for every upload and verify automatic internal distribution after processing. External submission is now authorized for Split; keep the app free.

## QA accounts

`scripts/qa/clerk-ticket.mjs alex|maya` runs under ADE secrets exec with CLERK_SECRET_KEY. It only reuses users marked splitE2ETestUser and writes a five-minute, one-use ticket owner-only in ignored `.ade/tmp/qa/`. Debug launch argument `-splitQATicketFile <absolute path>` consumes the ticket using the official Clerk SDK. There is no server authentication bypass and no production test-mode change. Never commit ticket files or logs containing credentials.
