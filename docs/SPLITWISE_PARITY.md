# Splitwise parity plan (0.7)

Split is a native SwiftUI app, not an Ionic project. There is no Ionic runtime or
web view in this repository. “Update Ionic” therefore maps to keeping the iOS
shell, SwiftUI target and deployment settings current. The app builds against
the iOS 27.2 SDK and keeps an iOS 18 deployment target.

The reference is the signed-in Splitwise web client at `secure.splitwise.com`,
reviewed on 17 November 2026. This document records the product surface we are
copying, the pieces Split already has, and the contract for the 0.7 port.

## Feature audit

| Splitwise surface | Split before 0.7 | 0.7 |
| --- | --- | --- |
| Dashboard totals (“you owe”, “you are owed”), per-person balances | Group list only | Home dashboard with per-currency totals and per-person balances |
| Groups list, group balances, month-grouped expense ledger | Partial | Full group list + list/detail group ledger, month sections, per-member balances |
| Friends and one-to-one tabs | Friend groups exist, no friend balance view | Friends list aggregated across groups, friend detail, non-group expense flow |
| Expense composer: amount, description, paid by, date, category, notes, receipt, repeat, split equally / unequally / percent / shares / adjustment | Partial | Full composer, including multiple payers and adjustment mode |
| Settle up suggestions, full/partial payment, payment links | Partial | Settle-up sheet with suggestions, member picker and payment handles |
| Activity feed | Flat list | Month-grouped feed, filters, likes, comments |
| Expense detail: breakdown, notes, comments, receipt, edit/delete/repeat | Partial | Full detail with social actions |
| Search (a Splitwise Pro feature) | None | Free global search across groups, people and expenses |
| Charts (a Splitwise Pro feature) | Text breakdowns | Free Insights with monthly and category charts |
| Notifications/reminders | None | In-app balance reminders and activity badges (no push in 0.7) |
| CSV import/export, exchange rates, recurring expenses, default shares | Present | Preserved |
| Account, connected computers, sign out | Present | Redesigned account screen, data export, free-everything promise |

Everything Splitwise puts behind Pro is free in Split: search, charts, currency
conversion, receipts and reminders. There is no paywall, ad or subscription.

## iPhone Duo

The target is iOS 27.1+ on the inner display and iOS 18 on everything else.

- Build against the iOS 27.2 SDK; keep deployment at iOS 18. Use availability
  checks for any 27.1-only API.
- Use system containers only: `TabView`, `NavigationStack`,
  `NavigationSplitView`, `List`, `ScrollView`. Never hand-roll a tab or
  navigation bar.
- The shell is a five-tab `TabView` (Home, Groups, Friends, Activity, You). The
  system moves it to the 84 pt vertical bar on the inner display; we do not
  override it.
- Groups and Friends use `NavigationSplitView`; it collapses to a stack on the
  outer display and shows list + detail on the inner display.
- Home, group detail and Insights use an adaptive `LazyVGrid` (320 pt minimum)
  so one column becomes two on regular width without stretching content.
- Support every orientation on iPhone and iPad. Do not branch on device or
  orientation; branch on size class and available width.
- Every toolbar item has a title and an image. Sheet content uses detents and
  avoids the fold through system presentation.

## Data contract

Swift models (`Split/Core/Ledger.swift`):

- `LedgerEntry.payers: [Payer]?` – split a payment across payers; absent means
  `paidBy` paid the total.
- `LedgerEntry.notes: String?` – free-form note, up to 2,000 characters.
- `LedgerEntry.commentCount`, `.likeCount`, `.likedByMe` – snapshot counters.
- `SplitMode.adjustment` – equal base split plus signed per-person adjustments.
- `ExpenseGroup.simplify: Bool?`, `.archived: Bool?` – group preferences.

Store (`Split/Core/ExpenseStore.swift`):

- `comments(for:)`, `loadComments`, `addComment`, `deleteComment`,
  `toggleLike`.
- `updateGroup`, `setArchived`, `leaveGroup`.
- `globalPeople`, `dashboard`, `search` live in `Split/Core/Analytics.swift`.

Worker (`worker/`):

- `POST /v1/entries/:id/comments` `{body}` → comment.
- `GET /v1/entries/:id/comments` → `{comments:[...]}`.
- `DELETE /v1/entries/:id/comments/:commentID` (author only).
- `POST /v1/entries/:id/like` → `{liked,count}` (toggle).
- `POST /v1/groups/:id/update` `{name?,currency?,simplify?}`.
- `POST /v1/groups/:id/archive` `{archived}`.
- `POST /v1/groups/:id/leave`.
- Snapshot groups include `simplify` and `archived`; snapshot entries include
  `commentCount`, `likeCount`, `likedByMe`.
- `validateEntry` whitelists `payers`, `notes` and the `adjustment` split mode.
- Migration `0013_social_and_polish.sql` adds `groups.simplify`,
  `groups.archived_at`, `entry_comments`, `entry_comments_fts`-free indexes and
  `entry_reactions`.

## Design direction

A shared paper ledger, not a generic card dashboard. Warm paper, evergreen ink,
lime for the money you are owed, coral for money you owe. Rounded SF for
display and amounts; SF Pro for prose. Hairline rules and month stamps instead of
a shadowed card on every row. One ink hero per screen carries the balance; the
rest is quiet.

The app sits on a slowly drifting aurora background in mint, sky, lime, coral and
lavender. Content surfaces are Liquid Glass on iOS 26+, with an
`ultraThinMaterial` fallback on iOS 18–25, so the background stays alive under
lists, cards and sheets. Actions are compact intrinsic glass capsules in a
cluster, never a single full-width button alone on a row; only sign-in, save and
other primary form actions span a column. Groups and friends use a two-pane
list/detail on regular width and collapse to a stack; Account becomes two columns;
Insights uses a daily chart for one-month data and a six-month chart otherwise.
Every screen works in light and dark, at accessibility sizes, and with VoiceOver
labels that read as sentences.

## Verification

- `npm run typecheck --prefix worker && npm test --prefix worker`
- `xcodegen generate && xcodebuild build` on iPhone 17 and iPhone Duo
- `node --test cli/test/*.test.mjs`
- Simulator flows: demo dashboard, group ledger, add expense (all five split
  modes), settle up, activity like/comment, search, insights, account.
- iPhone Duo: outer portrait, inner landscape, book/tabletop poses where the
  simulator exposes them; no letterboxing and nothing tappable in the fold.
- TestFlight internal build to Yoink Internal after the PR lands.
