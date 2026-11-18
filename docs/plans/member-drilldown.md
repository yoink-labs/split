# Member drilldown on iOS and a mobile-first web app

Fable 5.2 prepared this design before implementation. It describes the proposed scope; the release notes and screenshot gallery record the shipped work.
Sources: the Swift app in `Split/`, the Worker in `worker/src`, the D1 migrations, the CLI catalog, the README and the docs in this lane at `53d95b5`.

## 1. Outcome

One navigation model on both clients, always scoped to a group:

```
group ─▶ member (self, joined, or placeholder)
            └─▶ charge rows: amount · this member's share · date · payer
                   └─▶ expense: receipt photos · line items · claims · split-with shares
                          └─▶ another member ─▶ … and Back retraces every step
```

- **iOS:** replace the stacked sheets with pushed screens in the existing `NavigationStack`. No server change is needed.
- **Web:** a new mobile-first app at `https://split.yoinklabs.dev`, using the same Clerk instance and the same Worker and D1 database, covering groups, expenses, balances, payments, receipts and claims, in light and dark.
- **API:** the drilldown reuses `GET /v1/snapshot` and the receipt image route unchanged. The web app needs three small Worker changes (section 5).

## 2. What exists today

### iOS navigation

| Area | Today | Gap |
| --- | --- | --- |
| Tabs | `MainView` has Groups, Friends, Activity, You (`Split/Views/MainView.swift:7-11`). Groups and Friends share `GroupsView` with `path: [String]` of group IDs (`MainView.swift:21,52`). | The path can only hold groups. |
| Group | `GroupDetail` has an Expenses / Balances segmented control and five sheets: settings, add expense, people, entry details, settle up (`Split/Views/GroupDetail.swift:25,44-48`). | Expense detail is a sheet. |
| Member | `SpendingCard` rows open a private `MemberSpending` **sheet** per currency (`Split/Views/Insights.swift:20,32-34,43-64`). Rows show title, category, a raw `yyyy-MM-dd` string, "Paid" and "Share". | No payer name, no payments, no header or net balance, expenses only, reachable only from Balances. |
| Expense | `EntryDetails` is its own `NavigationStack` with a Done button, presented as a sheet from the group and again as a sheet on top of the member sheet (`Split/Views/EntryDetails.swift:18,56`; `Insights.swift:61`). | No date shown. Payer, claimant and split rows are plain text, so there is no way from an expense to a member. |
| People | `InviteView` lists members with Joined / Placeholder labels (`Split/Views/InviteView.swift:24-32`). | Rows are not tappable. |
| Activity | `ActivityView` rows are static cards (`MainView.swift:84-87`). | Rows do not open the entry. |
| Self | Found client-side as the member whose `userID` equals the Clerk user (`MainView.swift:26`, `Forms.swift:119`). | Fine; keep. |

Result: member → expense is sheet-on-sheet, and expense → another member is impossible.

### Data model

- `groups`, `members` (stable seat ID, nullable `user_id`), `entries` (JSON payload), `member_aliases`, `deleted_entries`, `receipts` (JPEG blobs), `payment_profiles`, `group_splits`, `recurring` (`worker/migrations`).
- A placeholder is a member with `user_id IS NULL`. A claimed duplicate seat becomes an alias, and the Worker rewrites every entry to canonical seat IDs before returning it (`worker/src/people.ts:20-38`).
- An entry carries `paidBy`, `splits[{memberID, amount}]`, `createdAt`, optional `category`, `exchange`, and `bill {items[{id,title,amount,memberIDs}], tax, tip, closed}`. Money is integer minor units.

### Worker authentication and API

- `fetch` verifies a Clerk RS256 session JWT against a hard-coded JWKS URL and `env.CLERK_ISSUER`, and accepts `azp` only when absent or one of `com.yoinklabs.split`, `https://yoinklabs.dev`, `https://www.yoinklabs.dev` (`worker/src/index.ts:9,203`). Device tokens (`spl_…`) are limited to `/v1/cli`, `/mcp` and `/v1/device/*`.
- Every ledger route derives the user from the token and checks membership in SQL. There is no CORS handling anywhere, and JSON bodies must be `application/json` (`worker/src/http.ts:6`).
- `GET /v1/snapshot` returns every group the user belongs to (limit 100) with canonical members `{id, groupID, userID, name, payment}` and `defaultWeights`, plus every visible entry (limit 5,000) with `recurrence`, `receiptIDs` and `editable` (`index.ts:29-47`). Member email and phone are never returned.

### Web UI

There is no web app. The Worker serves two static HTML pages: the invitation landing page at `/join/<code>` (`index.ts:195`) and the CLI instructions at `/device` (`worker/src/cli/devices.ts:13`). The README roadmap lists "a web/PWA companion".

## 3. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Drilldown data | Reuse the snapshot on both clients | It already contains every member, share, date, payer, line item and claim, alias-resolved and membership-filtered. |
| iOS navigation | Typed route enum pushed on the existing stack; sheets only for editing tasks | Gives member ⇄ expense in both directions with the system Back gesture. |
| Web hosting | Static assets on the **existing `split-api` Worker**, reached through a second custom domain `split.yoinklabs.dev` | Same origin as the API, so no CORS surface and no preflight requests. Static asset requests are free and do not count against the Worker quota. |
| Web stack | Vite + React + TypeScript + React Router, plain CSS custom properties, `@clerk/clerk-react` | Small bundle, no server rendering needed, and it can import the Worker's pure ledger modules directly. |
| Ledger maths on web | Import `worker/src/ledger.ts`, `items.ts`, `exchange.ts`, `settle.ts` | Identical rounding, validation and settlement plans to the server. The Worker already imports across packages (`worker/src/cli/routes.ts:6`). |
| Web persistence | In memory only; no service worker, no stored ledger or tokens | Safe on shared computers; avoids stale balances. |
| Web v1 scope | Groups, people and invites, expenses, balances, payments, receipts and claims | Matches the request. CSV, recurring schedules, default-share editing and connected computers stay iOS-only for now (section 6.6). |

Rejected: a separate assets-only Worker calling the API cross-origin. It adds CORS headers to a ledger API and doubles Worker invocations through preflights.

## 4. Shared member statement

Both clients compute the same view from snapshot data for one `(groupID, memberID)`.

- **Entries considered:** entries in the group where the member is `paidBy` or appears in `splits`.
- **Currency sections:** convert each entry with its frozen rate first (`LedgerEntry.settling` on iOS, `settlementEntry` on web), then group by resulting currency. This matches how balances are already computed.
- **Header per currency:** `paid` (expenses the member paid), `share` (sum of the member's split amounts on expenses), `net` (from `Ledger.balances` / `balances`, which includes payments). Label: "Owed", "Owes" or "All square".
- **Charge row (expense):** title; date from `createdAt` shown as a local medium date; "Paid by <name>" or "You paid"; the full amount; **this member's share**. For a converted expense show the original amount as secondary text. Badge "Open items" when `bill.openCount > 0`.
- **Payment row (settlement):** "Paid <name>" or "Received from <name>", amount, date. Listed in a separate Payments section so paid − share ± payments visibly equals net.
- **Unknown member ID:** render "Group member", not tappable. Members cannot be deleted today, so this is defensive only.

On web, `breakdown()` (`worker/src/items.ts:35`) already yields per-member `paid`, `share`, `net` and expense IDs per currency; the web statement helper wraps it and adds payments.

## 5. API: reuse and precise changes

### Reused unchanged

| Need | Route | Authorization already enforced |
| --- | --- | --- |
| Groups, members (self, joined, placeholder), entries, items, claims, shares, receipt IDs | `GET /v1/snapshot` | Joined on `members.user_id = token subject` |
| Receipt photo | `GET /v1/entries/:id/receipts/:photo` | Membership join; `private, no-store`; `nosniff` (`worker/src/receipts.ts:24-31`) |
| Claim / unclaim an item | `POST /v1/entries/:id/claim` `{itemID, original, memberIDs, mergeEdits:true}` | Member only; optimistic concurrency on payload |
| Close a receipt | `POST /v1/entries/:id/close` `{memberIDs}` | Payer, or the author when the payer is a placeholder (`receipts.ts:43`) |
| Add expense or payment (with up to 4 photos) | `POST /v1/entries` | Member only; idempotent on ID + payload |
| Edit / delete | `POST /v1/entries/:id/edit\|delete` `{original, entry, photos?}` | Author only; 409 on stale `original` |
| Create group, add member, invite, join, people search | `POST /v1/groups`, `/v1/groups/:id/members`, `/v1/groups/:id/invites`, `/v1/join`, `/v1/people/search` | Member checks; search limited to 60 per hour |
| Own payment details | `POST /v1/groups/:id/payment-profile` | Writes only the caller's seat |

No new query is needed for the drilldown. iOS needs **no Worker change at all**.

### Required for the web app

| # | File | Change |
| --- | --- | --- |
| A1 | `worker/src/index.ts:203` | Extend the `azp` allowlist with origins from a new public var `WEB_ORIGINS` (comma-separated, exact match). Web session tokens carry `azp: https://split.yoinklabs.dev` and are rejected today with 401. Keep accepting tokens without `azp` for the native app. Extract the check into an exported pure function so it can be unit-tested. |
| A2 | `worker/wrangler.jsonc` | Add `"assets": {"directory": "../web/dist", "not_found_handling": "single-page-application", "run_worker_first": ["/v1/*", "/mcp", "/health", "/join/*", "/device", "/.well-known/*"]}`, add `WEB_ORIGINS` to `vars`, and add the route `{"pattern": "split.yoinklabs.dev", "custom_domain": true}`. Check key names against current Cloudflare docs when implementing. |
| A3 | `worker/src/index.ts:29-47` | Add top-level `userID` (the token subject) to the snapshot response. The web client discards a snapshot whose `userID` differs from the active Clerk user. Additive; Swift `Codable` ignores unknown keys. |

### Recommended, small

| # | File | Change |
| --- | --- | --- |
| A4 | `worker/src/index.ts:195` | On the `/join/<code>` landing page add a "Continue on the web" link to `https://split.yoinklabs.dev/invite/<code>`, driven by a `WEB_URL` var and omitted when unset. |
| A5 | `web/public/_headers` | Content Security Policy and caching for the app shell: `default-src 'self'`; scripts from self and the Clerk Frontend API host; `connect-src` self, Clerk and `api.frankfurter.dev`; `img-src` self, `blob:`, `data:` and Clerk's image host; `frame-ancestors 'none'`; immutable caching for hashed assets. Confirm the exact hosts against Clerk's CSP guidance. |

### Not needed now

- A group-scoped snapshot (`GET /v1/snapshot?group=<id>`). Add it only if refreshes become slow or approach the D1 read quota; it is an additive `WHERE` on the two existing queries after the membership check.
- CORS headers. Do not add `Access-Control-Allow-Origin` anywhere.

### Wire rules the web client must follow

- IDs: `crypto.randomUUID()`; validate every route parameter with `^[a-zA-Z0-9_-]{8,80}$` (`worker/src/ledger.ts:50`) before use. Imported members and entries have 64-character hex IDs.
- `createdAt` **without fractional seconds** (same as `worker/src/cli/operations.ts:21`). iOS parses dates with a plain `ISO8601DateFormatter`, which fails on milliseconds and would hide the date on those rows.
- Converted expenses: `createdAt = <rate date>T12:00:00Z`, `exchange.target` equals the group currency, `exchange.date ≤ createdAt` date.
- Itemized expenses: `splitMode: "exact"` and `splits` equal to `itemSplit(bill, paidBy)`; new receipts start open.
- Photos: JPEG only, each at most 245,760 bytes, at most 4 per expense, request body under 1,350,000 bytes.
- Edits and deletes send the entry exactly as received as `original`; on 409 refetch the snapshot and tell the user it changed.

## 6. Identity and authorization

1. **The server decides who you are.** The user comes only from the verified token subject. The clients never send a user ID or member ID to prove identity.
2. **Self** is the member whose `userID` equals the signed-in Clerk user ID. It is used for labels ("You"), default payer and default claimant only.
3. **Placeholders** are members with `userID == null`. Show a "Placeholder" badge and offer "Invite to claim" (`POST /v1/groups/:id/invites {memberID}`).
4. **Same person across groups** is matched by `userID` only. Never match by name, email or phone. A placeholder therefore has no cross-group identity.
5. **URLs** contain only group, member-seat and entry IDs. Clerk user IDs, names, invite codes and tokens never stay in a URL; the `/invite/<code>` route reads the code, keeps it in memory through sign-in and replaces the URL immediately.
6. **A link is not a permission.** Every screen renders from the caller's own snapshot. A URL for a group the caller is not in shows "Group unavailable" and makes no extra request.
7. **Account changes.** On sign-out or a Clerk user change the web app drops the snapshot, cached photos and object URLs before rendering anything else.
8. **Untrusted text.** Titles, names and categories render as text only. Payment links are built from server-validated handles with `encodeURIComponent` and open with `rel="noopener noreferrer"`.
9. **Receipt photos** are fetched with the bearer token and shown through object URLs, revoked on eviction and sign-out. They are never requested by `<img src>`.
10. **Tokens.** Call `session.getToken()` before each request and keep nothing in `localStorage` except the theme choice.

Existing rules stay as they are: any member may claim an item for any member, only the payer (or the author for a placeholder payer) closes a receipt, and only the author edits or deletes.

## 7. iOS plan (compact width first)

### 7.1 Routes

Add to `Split/Core` (new `Routes.swift`):

```swift
enum Route: Hashable {
    case group(String)
    case member(group: String, member: String)
    case entry(group: String, entry: String)
}
```

- `GroupsView.path` becomes `[Route]`; one shared `routeDestinations()` modifier registers `navigationDestination(for: Route.self)`.
- An `openRoute` environment action pushes a route. If the route is already in the path it pops back to it, so the stack stays bounded and Back always retraces real steps.
- `store.joinedGroupID` and `JoinGroupView` push `.group(id)` instead of a string.
- `ActivityView` uses the same destinations so its rows open the expense.

### 7.2 Screens

**Member screen** (new `Split/Views/MemberView.swift`, replaces `MemberSpending`)

- Title: member name, or "You". Subtitle badge: You / Joined / Placeholder.
- **Group picker** in the title menu: groups this person shares with the viewer, matched by `userID`. For self it lists all the viewer's groups. Choosing one replaces the top route with that group's seat. Hidden for placeholders.
- Header card: one line per currency with Owed / Owes / All square, plus "Paid · Share". A currency filter appears only when there are two or more currencies.
- Charges section, then Payments section, rows as defined in section 4. Each row is a `NavigationLink(value: .entry(…))`, minimum height 44 pt. Trailing column: share on top, full amount below; `ViewThatFits` drops to a stacked layout at large Dynamic Type.
- Actions: "Invite to claim" for a placeholder; the member's payment links when present (`PaymentActions`); "Settle up" when the current plan has a transfer between the viewer and this member.

**Expense screen** (`EntryDetails`, pushed)

- Remove its own `NavigationStack` and Done button. Keep the claim sheet, edit sheet and full-screen receipt viewer.
- Add the date under the amount.
- "Paid by" becomes a link to the payer's member screen.
- Purchases: keep tap-to-claim on the row; show claimants as tappable name chips that open the member screen.
- "Split with" (today "Individual amounts"): each row links to that member. When opened from a member screen, that member's row is listed first and marked.
- For payments: "From" and "To" rows link to members.

**Entry points**

- `SpendingCard` rows → `.member`. `GroupDetail` expense rows → `.entry` (remove the `inspecting` sheet).
- `InviteView` member rows: dismiss the sheet, then push `.member`.

### 7.3 Core and tests

- Add `Ledger.statement(member:entries:)` as a pure function returning the per-currency header and rows from section 4.
- `SplitTests`: self, placeholder, payer-only, sharer-only, converted expense, itemized bill with open items, payments in and out, two currencies; assert paid − share ± payments equals `Ledger.balances`.
- No change to `ExpenseStore`, the outbox or any request.

### 7.4 Acceptance

Group → Balances → Maya → Dinner → Jules → Coffee → Maya pops back to the existing Maya screen; Back from there returns to Balances. Works in the sample preview, offline, at Accessibility Large, in light and dark, on iPhone and iPad.

## 8. Web app

### 8.1 Layout

```
web/
  index.html, vite.config.ts, package.json, tsconfig.json
  public/            _headers, manifest.webmanifest, icons
  src/
    main.tsx         ClerkProvider (publishable key from SplitApp.swift:7 via VITE_CLERK_PUBLISHABLE_KEY), router
    api.ts           request(path, body?) with getToken(), error mapping, snapshot store
    lib/             statement.ts, money.ts, photos.ts; re-exports of worker/src ledger modules
    routes/          Groups, Group, Member, Expense, Activity, You, Invite, SignIn
    components/      AppShell, GroupPicker, ChargeRow, SplitList, ItemList, ClaimDialog,
                     ReceiptStrip, ReceiptViewer, ExpenseForm, SettleDialog, PeopleDialog
    styles/          tokens.css (light/dark), base.css
    fixtures/        the same fictional trip as Fixtures.snapshot() in ExpenseStore.swift
```

Add `web/dist/` and `web/node_modules/` coverage to `.gitignore`.

### 8.2 Routes and navigation

| URL | Screen |
| --- | --- |
| `/` | Groups, with the cross-group balance summary |
| `/g/:groupID?tab=expenses\|balances\|people` | Group |
| `/g/:groupID/m/:memberID` | Member statement |
| `/g/:groupID/e/:entryID` | Expense or payment |
| `/activity`, `/you` | Activity, account and theme |
| `/invite/:code` | Join after sign-in, then redirect to the group |
| `/sign-in` | Clerk sign-in (Apple, Google, email code) |

- Every drilldown step is a real history entry, so browser Back and Forward retrace member → expense → member exactly. The in-app Back button calls `history.back()` when there is in-app history and otherwise links up to the group.
- The link that opened an expense passes the originating member in router state, used only to pin and mark that member's share. Deep links and reloads work without it.
- **Group picker:** a header control on every group-scoped screen. On Group and Expense it lists all the viewer's groups. On Member it lists only groups shared with that person (by `userID`) and jumps to their seat there; for placeholders it is replaced by a static "Placeholder in <group>" label.
- On route change move focus to the page heading and restore scroll position on Back.

### 8.3 Responsive behaviour

| Width | Layout |
| --- | --- |
| under 720 px | One column. Top bar (Back, title, group picker), bottom tab bar (Groups, Activity, You), sticky "Add an expense" button on the group. Dialogs are bottom sheets. |
| 720–1099 px | Two panes: group on the left, member or expense on the right. |
| 1100 px and up | Three panes: group list rail, group, detail. Content width capped; dialogs centred. |

Panes are derived from the URL, so the same links and history work at every width.

### 8.4 Light and dark

- Tokens from `Split/Views/Theme.swift`: green `#1F4D3D` / `#94D9B3`, background `#F7F7F2` / `#0F1412`, card `#FFFFFF` / `#1C241F`, lime `#CCED87`, ink `#17382B`.
- `color-scheme: light dark`; follow the system by default, with System / Light / Dark in You, stored as the only `localStorage` key. Pass the matching `appearance` to Clerk components and set `theme-color` per scheme.
- Amounts use tabular figures and the iOS format (`ARS 84,000.00`), formatted from integers without floating-point maths. Targets at least 44 px, visible focus rings, text contrast at least 4.5:1 in both themes, reduced-motion respected.

### 8.5 Data layer

- One snapshot in memory. Fetch after sign-in, after every successful mutation, on window focus when older than 30 seconds, and on manual refresh. Share a single in-flight request.
- Mutations wait for the server, then refetch. No optimistic writes and no offline queue in v1; client-generated IDs make a retry safe.
- Errors: show the Worker's `{error}` message. 401 → sign-in. 409 → refetch and explain. Network failure → retry banner.
- Receipt photos load only when an expense is opened; keep at most 12 decoded images.

### 8.6 Feature scope for v1

| Area | Included | Deferred |
| --- | --- | --- |
| Groups | List, cross-group balance, create (trip, home, friend; currency), join by code or link | Archiving |
| People | Roster with badges, add Split user (search) or placeholder, group and personal invites | — |
| Expenses | Add, edit, delete; equal, exact, percent, shares; category; payer; honours group default weights; foreign currency with published rate (Frankfurter, if its API allows browser requests) or manual rate | Recurring schedules (badge shown read-only) |
| Balances | Per-currency totals, per-member paid / share / net, by category and month, suggested payments via `transferPlan` | Exhaustive minimum search above 16 balances |
| Payments | Record full or partial settle-up, recipient's payment links, edit own payment details | — |
| Receipts and claims | Photo strip and full-screen viewer, attach up to 4 photos (canvas resize to 1600 px and JPEG quality ladder, which also strips metadata), manual line items with tax and tip, claim and unclaim, close receipt | Text recognition of receipts (iOS only) |
| Other | Sample preview from fixtures without sign-in | CSV import/export, default-share editing, connected computers |

### 8.7 Acceptance

Signed in as a QA user at 390 px wide: open a group → Balances → self → an itemized expense → view a receipt photo → claim an item → open a placeholder from "Split with" → open one of their charges → Back four times returns to Balances with the claim reflected. The same path works at 1280 px and in dark mode, and a second QA account sees the claim after refresh.

## 9. Deployment on Cloudflare's free tier

- **Shape:** `npm run build --prefix web` produces `web/dist`; `wrangler deploy` on the existing `split-api` Worker uploads code and assets together. `split.yoinklabs.dev` is a second custom domain on that Worker. Nothing new is billed: static asset requests are free and unlimited, and API calls share the existing 100,000 requests per day.
- **Routing:** the paths in `run_worker_first` reach the Worker exactly as today (API, MCP, health, invitation page, device page, universal-link association). Everything else is an asset or the app shell. The app redirects to `split.yoinklabs.dev` if opened on the API hostname.
- **Clerk:** an initial environment request returned 200 for the origin. During signed-in browser verification Clerk required its subdomain allowlist entry. The release appended `split.yoinklabs.dev` and preserved the existing entries. Production keys are tied to the `yoinklabs.dev` domain, so sign-in cannot work on `workers.dev` preview URLs or plain `localhost`.
- **iOS is unaffected:** universal links and invite parsing stay on `split-api.yoinklabs.dev`.
- **Checks:** add a `web` job to `.github/workflows/checks.yml` and to `scripts/check.sh` (typecheck, unit tests, build). The Worker's Vitest setup reads `wrangler.jsonc`; build the web app first, or confirm a missing `web/dist` does not break it.
- **Release sequence**
  1. `wrangler versions upload` and smoke-test the unauthenticated behaviour on the version preview URL: app shell loads, `/health` is JSON, `/v1/snapshot` is 401, `/join/<code>` and `/.well-known/apple-app-site-association` are unchanged.
  2. Deploy the version, then attach `split.yoinklabs.dev`.
  3. Signed-in smoke test with the tagged QA accounts. Roll back with `wrangler rollback` if anything regresses for iOS or the CLI.
- No migration is required.

## 10. Testing, QA and screenshots

### 10.1 Automated

| Layer | What |
| --- | --- |
| Swift unit | `Ledger.statement` cases from section 7.3; existing suite via `ade apple test --scheme Split --text` |
| Worker (Vitest) | `azp` allowlist: absent, native, listed web origin, unlisted origin, prefix look-alike. Snapshot includes the caller's `userID`. Existing membership, purchases and group-tools suites unchanged. |
| Web unit (Vitest) | Statement helper against the same cases as Swift; money parse and format; `createdAt` format; photo size ladder; route-parameter validation |
| Web end-to-end (Playwright, fixtures, no network) | Full drilldown loop with Back; group picker for self, joined member and placeholder; unknown group URL; sign-out clears state; axe accessibility scan per screen |

### 10.2 Signed-in testing without touching production

Everything runs in this lane against a **local Worker and local D1**, with real Clerk sessions for the tagged QA users.

1. `npm run db:local --prefix worker`, build the web app, then start the local Worker with HTTPS and the Clerk secret from the vault, as the README already describes for iOS (`ade secrets exec --env CLERK_SECRET_KEY -- … wrangler dev --local --local-protocol https --port 8787`). It serves both the API and the built app.
2. Launch Playwright's Chromium with `--host-resolver-rules="MAP split.yoinklabs.dev:443 127.0.0.1:8787"` and trust only the local certificate (`--ignore-certificate-errors-spki-list`). The page origin is then `https://split.yoinklabs.dev`, which Clerk accepts, with no hosts-file edit and no deployment.
3. Create a five-minute sign-in ticket with the existing `scripts/qa/clerk-ticket.mjs alex|maya`. The test reads the ticket file and signs in through Clerk's own client API in the page (`signIn.create({strategy: 'ticket', ticket})`, then `setActive`). The ticket is never printed or placed in a URL, and the app ships no QA hook.
4. Run the section 8.7 path as Alex, then verify as Maya in a second browser context.

If step 2 does not work in practice, the fallback is a gated preview: the same Worker code under a different name with its own empty D1 database on another `yoinklabs.dev` subdomain. That creates Cloudflare resources and needs approval first.

iOS signed-in checks use the same local Worker through the existing `-splitLocalAPI` and `-splitQATicketFile` launch arguments.

### 10.3 Manual QA matrix

- **iOS** (lane simulator, `ade apple`, take a lease first): sample preview and one signed-in QA account; light and dark; default and Accessibility Large text; iPhone, plus one iPad pass. Cases: self, joined member, placeholder, member with no entries, converted expense, itemized receipt with open items, closed receipt, payment rows, group picker, pop-to-existing, offline.
- **Web:** 390×844, 768×1024, 1280×800; light and dark; keyboard-only pass; Safari on the simulator for the mobile layout. Same cases, plus reload on every route, Back/Forward, a second tab signing out, a 409 on a concurrent claim, and an oversized photo.

### 10.4 Screenshots and proof

- Fictional data only (sample preview or tagged QA groups), as in the current gallery.
- iOS: replace `screenshots/{light,dark}/member.png`; add `member-expense.png` and `member-picker.png`. Record one short video of member → expense → member → Back with `ade apple record-start` / `record-stop`.
- Web: `screenshots/web/{light,dark}/` at 390 px for groups, group balances, member (self), member (placeholder), expense with receipt and items, claim dialog, receipt viewer, settle up, add expense, group picker; plus the member and expense screens at 1280 px.
- Update `screenshots/README.md`, the README (web section, architecture row) and `docs/USABILITY.md` with a short audit entry. Attach captures with `ade proof attach`.
- Once PR #17 is on main: move roadmap changes to `ROADMAP.md` (this work is listed there under "In progress") and add the user-visible changes to `CHANGELOG.md` under Unreleased.

### 10.5 Coordination with PR #17 ("Make Split easy to contribute to")

PR #17 is open against main and should merge first. Rebase this lane onto main before step 1.

- `Split/Views/MainView.swift`: PR #17 adds an "Open source on GitHub" link in `AccountView`, next to "Visit Yoink Labs". Step 1 edits `GroupsView` and `ActivityView` in the same file. Uncommitted work now in this lane also changes the `AccountView` profile row a few lines above that link, so expect a conflict there; keep the link when resolving the rebase.
- `README.md`: the roadmap bullets move to `ROADMAP.md` and a Contributing section is added. Do not edit roadmap bullets in the README.
- Follow the new `CONTRIBUTING.md`, `AGENTS.md` / `CLAUDE.md` and the PR template once they land, and label PRs `ios`, `web` or `worker`.
- The repository is public with push protection on. Commit no secrets, QA tickets, Clerk user IDs or real account data, and keep screenshots on fictional or tagged QA data. The Clerk publishable key already in `SplitApp.swift` is public client configuration.

## 11. Work sequence

| Step | Deliverable | Depends on | Done when |
| --- | --- | --- | --- |
| 1 | iOS routes, member screen, pushed expense screen, statement tests | — | Section 7.4 passes; unit tests green |
| 2 | Worker A1–A4 with tests; `web/` scaffold building into `web/dist`; CI job | — | Worker and web checks green; local Worker serves the shell and the unchanged API |
| 3 | Web read path: sign-in, groups, group, member, expense, receipt viewer, group picker, themes, fixtures | 2 | Fixture end-to-end loop passes at three widths in both themes |
| 4 | Web write path: expense form, claims and close, settle up, payment details, create/join, people and invites, photo upload | 3 | Section 8.7 passes signed in against the local Worker |
| 5 | QA matrix, screenshots, video, docs | 1, 4 | Gallery and docs updated; proof attached |
| 6 | Release: Worker deploy with assets and `split.yoinklabs.dev`, production smoke test, TestFlight build | 5 | Web live; iOS, CLI and MCP unaffected |

Steps 1 and 2 are independent and can run in parallel. Step 1 can ship in a TestFlight build on its own.

## 12. Risks and open points

| Item | Handling |
| --- | --- |
| Local signed-in harness relies on Chromium host mapping and Clerk's ticket sign-in in the browser | Both are standard but unproven in this repo; verify first in step 3. Fallback is the gated preview in section 10.2. |
| The QA ticket script may create the tagged QA user in Clerk and uses the vault secret | Same practice as documented in `docs/TESTFLIGHT.md`; needs the vault to be available. |
| Adding `assets` changes responses for unknown paths on the API hostname (app shell instead of 401 JSON) | iOS and the CLI only use `/v1/*`, `/mcp` and `/health`, all listed in `run_worker_first`. Verify on the version preview before deploying. |
| Web and API deploy together | Acceptable for one small Worker; rollback restores both. |
| Whole-account snapshot on each refresh (up to 5,000 entries) | Refresh policy in section 8.5; add the group filter if D1 reads or latency become a problem. |
| Frankfurter may not allow browser requests | Fall back to manual rate only on web. |
| Clerk user IDs are visible to co-members in the snapshot | Already true for iOS; they are opaque and never placed in URLs. |
| Timestamps written with milliseconds would hide dates on iOS | Enforced by the wire rule and a unit test. |

Harris authorized production deployment and signed-in QA for this release.
