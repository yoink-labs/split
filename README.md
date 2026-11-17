# Split by Yoink Labs

A free native iOS app for shared expenses. No paywall or Pro tier.

- **Working name:** Split · `com.yoinklabs.split`
- **Team:** `64PUT29XZ8`
- **App:** SwiftUI, iOS 18+, XcodeGen, Clerk iOS 1.7.1
- **API:** https://split-api.yoinklabs.dev · separate Cloudflare Worker and D1 database
- **Identity:** the existing Yoink Labs production Clerk instance used by Wanderer and yoinklabs.dev

## First build

Groups for trips and homes; one-to-one friend tabs; invitations to named member slots; expenses split equally, by exact amounts, percentages, or shares; per-currency balances; simplified group debts; partial/full settle-up records; activity feed; account-scoped local storage and a FIFO upload outbox. ARS, USD, EUR, GBP, BRL, CAD, AUD, MXN are supported with two decimal places. Currencies are never combined or converted.

The sample preview is explicitly labeled, uses fictional people, and never writes to the server. Sign in to use real groups. Returning email sign-in uses a code. Email signup also asks for a password because the existing shared Clerk instance requires it; no dashboard settings were changed.

## Development

```sh
xcodegen generate
ade apple launch --follow --open-drawer --text
ade apple test --scheme Split --text
npm ci --prefix worker
npm test --prefix worker
npm run typecheck --prefix worker
```

The lane simulator is owned by ADE. On this Mac, the file provider adds FinderInfo metadata to build bundles and can make Xcode's final signing step fail after compilation. For **that specific metadata error only**, run `scripts/sign-simulator.sh`, then `ade apple install --no-build --launch --text`. The script finishes the ad-hoc signature using Xcode's generated entitlements; it does not disable authentication or change device signing. Do not use it to ignore compiler/test failures.

## Backend deployment

Use the project's ADE secrets. Never put them in source, logs, or `.env` files.

```sh
ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID -- /opt/homebrew/bin/node worker/node_modules/wrangler/bin/wrangler.js d1 migrations apply split --remote --config worker/wrangler.jsonc
ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID -- /opt/homebrew/bin/node worker/node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc
```

D1: `1bd76a4e-1855-4699-922d-c3f7f5486800`, Worker: `split-api`, account: `2bc9c3c136a62ea9dcbddaa6f59edca4`. No paid product is needed. No Wanderer route or database is reused. The Worker verifies RS256 JWTs using Clerk's public JWKS; it needs no Clerk private key. `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` were copied securely as requested and remain only in ADE's vault.

The compatibility date is 2026-11-16: the installed workerd binary rejects 2026-11-17 despite its package date. Advance it after the runtime supports that date and tests pass.

## Data and security

Amounts are integer minor units; largest-remainder allocation preserves every cent. Server-side validation checks the sum, participants, currency, amount limits and membership. Group creation is transactional. Expense IDs make retries idempotent; conflicting reuse is rejected. Invite tokens have 256+ bits of entropy, are hashed at rest, expire in seven days, and can claim only their assigned unclaimed member. Request bodies are limited to 32 KiB. There is no production test-auth bypass.

The local cache/outbox uses file protection, atomic writes, per-account filenames, and is excluded from backup. Changes are acknowledged individually before leaving the outbox. Refresh preserves any changes made while a request was in flight. Returning to the foreground or regaining connectivity retries sync. iOS does not guarantee sync while the app is suspended.

## Beta limitations and verification gaps

- No currency conversion, expense editing/deletion, receipt upload, recurring expenses, or actual money transfer in this first build.
- Server guardrails: 50 people/group, 100 groups/account, 5,000 entries/account. These are beta capacity safeguards, never paid upgrades.
- Google now reaches the Google account sign-in page after Harris registered the native callback. Full Google/Apple/email-code completion still needs real-provider testing.
- Two tagged QA accounts verified production group creation, expense sync, invite generation, universal links, web fallback/custom links, and joining with preexisting balances preserved. QA uses real Clerk sign-in tickets in Debug only; Release contains no ticket-file hook.
- Account deletion/export, expense editing and broader device coverage remain follow-up work for the beta.
- `npm audit --omit=dev` reports no production vulnerabilities. The local test toolchain has upstream advisories (picomatch/Vite); no Vite dev server is deployed.

See [release status](docs/TESTFLIGHT.md) for TestFlight distribution and [fresh screenshots](screenshots/README.md).
