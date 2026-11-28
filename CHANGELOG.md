# Changelog

All notable changes to Split are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions match the iOS app's marketing version. The TestFlight build number
is noted next to each release. The CLI is versioned separately with
`split-v*` tags.

## [Unreleased]

### Added

- Set different check-in and check-out dates for each person on a nights split, and view daily costs in your home currency.

- The Friends page on web and iOS puts accepted friends and balances first. Manage sent and received requests, and share profile payment methods with accepted friends from your payment settings.
- Web dropdowns use a shared picker with keyboard controls, search for long lists, and a touch-friendly sheet on phones.
- Split stays by nights and spread expenses over a date range. See each person’s daily costs on web and iOS or with the CLI and MCP.
- See how expenses, payments, and linked refunds add up in a group member’s balance breakdown on web and iOS, or with `split balances --group ID --member ID`.
- Let Finance set the amount your card actually charged on a foreign expense you recorded and paid, when you approve its connection with "updates card charges". The amount becomes the expense's statement amount: original-currency shares stay as they are, everyone's converted share follows the card, and each change is kept in the charged amount history and Finance's update log. Retries with the same key never apply twice, and a change made in Split since Finance looked is refused. Existing Finance connections stay read-only.

- Open the Analytics tab on the web for spending over time, by category, by person (paid against share) and by currency in your home currency. Filter by date range and member, and select any bar or row to see its transactions.
- Record refunds and credits on web, iOS and the CLI/MCP. Refund part or all of an expense to some or all of the people who shared it, or give a standalone credit. Refunds lower the right shares and balances to the cent, and can never exceed the original expense or one person's share. Splitwise rows with a negative cost import as refunds.
- Keep receipts in a group Receipts inbox on web, iOS and the CLI/MCP. Upload a receipt before its expense exists, pair it later, or move a receipt to another expense or back to the inbox. Any expense can hold up to four receipts.
- Reopen closed itemized receipts and edit people across the receipt on web, iOS, and the CLI. The web and iOS Receipts pages group bills by assignment status and show who is sharing each receipt.
- Refund specific receipt items. Everyone who had an item gets back exactly what it cost them, tax and tip included, and each item can be refunded once.
- Every group report, including the PDF, can show consumption by person: who had each item, item totals, and how tax and tip were allocated, exact to the cent. Refunds are netted out. `split items report` gives the same breakdown.
- Mark any expense pending with an optional note while its cost may still change. Pending expenses count toward balances, balances also show the confirmed-only amount, and settle up warns while anything is pending. Resolve one by confirming it, adjusting its amount, or turning it into a refund.
- Find people on Split by full email or a 3+ letter name prefix and invite them to a group. Results show names and avatars only. A “Let people find me” setting, on by default, hides you from search.
- An invitation inbox on web and iOS, with a badge, lets you accept or decline pending invitations. Accepting claims matching placeholder history.
- Open the new Analytics tab on iOS for the same charts and totals as the web, to the cent: spending over time by day, week or month, by category, by person and by currency. Filter by group, date range and member, and tap any bar or row to list its expenses. On the iPhone Duo inner display and iPad, the charts and the transaction list sit side by side. Activity moves to Home → See all on a phone.
- Set, edit or clear a trip's fixed exchange rates from group settings on iOS, as on the web.
- Filter an iOS group ledger to expenses you're involved in or that you owe on, with a count of matching entries.
- Connected computers on iOS show whether each token is Finance (read-only), a remote MCP token, or CLI and local MCP.
- Manage group members, claim addresses, and invitations from the Members tab on web and iOS. Email or resend invitations and send sign-in reminders.
- Open the Transactions tab on web and iOS to see each expense or settlement and its payment split.
- Customize group PDFs with spending breakdowns by category, month, and person.
- Group creators can permanently delete groups on iOS and the web.
- Set preferred payment methods in your profile, override them per group, and use payment handles and provider links when settling up.

- Split CLI 0.3.0 creates personal invitations and can set, correct, or clear a placeholder member’s email for verified account linking.
- Review or import several Splitwise CSV exports in one CLI command by repeating `--file`.
- Connect Finance with read-only access to your Split expense shares and receipts.
- Delete groups you created and respond to pending payments from the CLI or MCP.
- Set trip exchange rates and payment methods, and mark expenses as handled from the CLI or MCP.
- Create remote MCP tokens and revoke AI, CLI, and Finance access from the Split web app.

### Changed

- Home on web and iOS shows your balances by person and currency, your share of spending, and a filterable feed of your transactions across groups.

- The totals at the top of web Analytics now show every figure in full at any width or zoom, moving to two columns on narrower screens.
- Long transaction lists on iOS load in pages: analytics drill-downs show 25 at a time, and friend history and member statements show 50 with Show more.

- Transaction lists on the web Overview, Transactions tab and Analytics stay inside a scrolling frame with a fixed header and pages of rows, with a link to the full ledger. Large groups no longer make the page grow without limit.
- Enter web expenses with searchable pickers and a live split preview, and explore daily or monthly spending by category, person, and housing.
- Redesigned Splitwise import on the web with drag-and-drop CSV selection, clearer balance checks, and a mobile layout for matching people and reviewing entries.
- On web and iOS, claim your Splitwise history, match people to Split accounts or prepare email invites, and preview and import expenses and payments in your Home currency using historical exchange rates.
- The CLI previews Splitwise imports, including how each person maps to a Split member, and asks for confirmation in an interactive terminal.
- The CLI lists supported expense categories, shows retained receipts and recurrence in edit previews, and returns one JSON result for confirmed edits.
- CLI changes on main publish a new Homebrew release automatically.
- The web AI & CLI page shows copyable setup for the selected client.

### Changed

- Redesigned the web currency converter with 161 currency codes, charge-date rates with a latest-rate fallback, trip and expense overrides, and a comparison with the amount posted on your statement.
- Redesigned the web group ledger with expandable spending breakdowns and a filterable transaction table, and moved trip exchange rates into group Settings.

### Fixed

- Normalize whitespace in member and account names. The CLI and MCP now show who was linked, which member stayed, and how much expense history came with the link.

- Personal PDF reports use a thin outline around transactions you’re involved in and lightly shade only your own rows.

- Confirmed CLI expense edits report the saved category.
- Preview and confirm expense combinations in the CLI and MCP. The CLI supports `--dry-run` and `--yes`, and the saved result includes the full expense.

## [0.9.0] - 2026-11-27

TestFlight build 14.

### Added

- Photograph receipts, save drafts for later, and review detected line items before assigning them to the people who shared them.
- Request approval for a settlement. Balances update when the recipient confirms the payment.
- Mark an expense as already handled to include it in spending reports without adding it to balances.

### Changed

- See expenses, receipt items, spending, and balances in your home currency. The converter shows the exchange-rate source and lets you look up a past date.
- Use the same Split logo on web and iOS, with a green launch screen and clearer expense forms.

## 0.8.0 follow-up

TestFlight build 0.8.0 (12), Yoink Internal.

### Added

- CLI 0.2.0 and MCP: every web action is a command. New: `groups update`,
  `groups archive`, `groups leave`, `groups export` (ledger CSV, per-member
  summary CSV with transfers, full JSON), `members remove` (archive, restore,
  delete), `invites list`, `invites revoke`, `expenses show`, `expenses like`,
  `comments list|add|delete`, `receipts add`, `items list`, `items assign`,
  `import splitwise` and `profile avatar`. `expenses add` takes several payers
  and per-item share multipliers on itemized receipts; `items claim --share`
  makes a partial claim. `--photo PATH` (and file paths through the local MCP
  server) converts HEIC/PNG and shrinks photos to the receipt limit. The CLI
  is also installable with `npm install -g ./cli`.
- Web: approve and revoke CLI and MCP computers from Connect AI & CLI, so
  pairing no longer needs the iPhone app. Splitwise import, the currency
  converter, Connect AI & CLI and Join live in the account menu at the
  bottom of the sidebar.

- "Tip the devs": an optional tip jar on iPhone, iPad and iPhone Duo. Split
  stays free with nothing locked; a tip unlocks nothing. Three StoreKit 2
  consumables (`dev.yoinklabs.split.tip.small|medium|large`) with prices from
  the App Store, a pink heart button in the Home top bar and on the welcome
  screen, and a row on the You tab. Pending (Ask to Buy), thanks, failure and
  "Tips aren't available yet" states; transactions finished outside the sheet
  are handled from launch. A local `Split.storekit` backs the scheme and tests.
- Web: a pink "♥ Tip the devs" pill in the header and a row on You, linking to
  yoinklabs.dev/tip, which explains that tipping happens in the iPhone app.

## [0.8.0] - 2026-11-18

TestFlight build 10, Yoink Internal and Public Beta (external review).

### Added

- **Import from Splitwise** on iOS and the web. Pick one or more of Splitwise's
  per-group "Export as spreadsheet" CSVs; each becomes a group. The preview
  shows members, expenses, payments and rows left out, lets you map every
  Splitwise name to yourself, an existing member or a placeholder, and checks
  the imported balances against the file's "Total balance" rows to the cent,
  with a warning when they differ. Headers in any Splitwise language, friend
  exports, spreadsheet re-saves, multiple payers and multi-currency groups are
  handled. A group, its placeholders and up to 1,500 entries are written in one
  atomic request (`POST /v1/import/splitwise`), and re-importing the same file
  adds nothing. Entry points: Groups "+", the Groups and Home empty states,
  the Home "+" menu and Account.
- **Free currency conversion.** The composer fetches the rate for the expense
  date and shows "≈ ARS 18,624.00 at 1 USD = 1,552 ARS (BCRA official,
  Nov 17)", with Edit rate for your own (blue or card) rate; the original
  amount and frozen rate are saved. Rates are Frankfurter (ECB) or the BCRA
  official rate for pesos, with no key and no paywall.
- **Show in.** Home, group headers, group balances, member statements and
  people rows show an approximate total in your home currency (set in Account)
  at today's rate, labelled with the source and date.
- **Settle up in any currency.** Paying in a currency the group has no balance
  in converts the payment to the group currency at a frozen rate.
- A standalone currency converter from Home, Account and the composer, with
  per-pair manual rates for the ARS blue dollar.
- Rates are cached with a timestamp for six hours and keep working offline.

### Changed

- Home currency replaces "Default currency" and also sets new groups' currency.
- Non-ARS rates now pin the ECB provider, so weekend and holiday dates return
  the previous business day's rate.

## [0.7.1] - 2026-11-18

TestFlight build 9, Yoink Internal only.

### Changed

- One header pattern on every tab: a system large title with actions in the
  top trailing toolbar. Groups uses a single "+" menu for **New group** and
  **Join with code or link**. On the web, the left-aligned buttons are replaced
  by the same "+" menu.
- Add expense and Settle up share one row at equal widths, and stack at
  accessibility text sizes.
- Member statements show the avatar, name and net balance, group chips
  including **All groups**, a Charges/Payments switch, charges grouped by trip,
  and rows with the date, their share and the total. The same layout is on the web.
- Empty lists show a centred state with one primary action.
- Shared spacing, radius, row, balance, header and empty-state components
  (`DesignSystem.swift`, and matching CSS variables on the web). See
  [the audit](docs/design/ui-audit.md).

### Fixed

- Pull-to-refresh now waits for a sync already in flight instead of ending
  early, and one sync runs at a time.
- A cancelled refresh no longer shows an error, and the error banner no longer
  flickers between attempts.
- Refreshes that return the same data no longer redraw every list. Rows are
  deduplicated by id and keep a stable order when timestamps match.
- Lists show a spinner instead of an empty state until the first sync finishes.

## [0.7.0] - 2026-11-18

TestFlight build 8 (pending).

### Added

- Group-scoped member statements and linked receipt participants on iOS, including placeholders.
- A mobile web app for shared groups, expense entry, photographed receipts, item claims, balances and payments.
- The Splitwise-parity iOS surface: a cross-group dashboard, friends and
  one-to-one tabs, comments and likes, global search, Insights charts, multiple
  payers, five split modes, archived groups and a shareable balance reminder.
- Receipt claimant chips in the composer and saved expense, with on-device
  Vision item review, tax/tip allocation and a chip-based claim sheet.
- QR-code and short-code invite cards, with personal placeholder links.
- Liquid Glass hierarchy over a drifting aurora background, compact intrinsic
  action clusters, and two-column layouts on regular width.
- iPhone Duo cover, open-wide and open-tall layouts through the system tab and
  split containers.

### Fixed

- Home and Friends balances now agree with the user’s own group totals instead
  of showing a person’s group balance as money owed to the user.
- “Simplify payments” off now uses a direct transfer plan.
- A compact phone group list no longer leaves a large hole above its first row,
  and compact expense rows keep both title and amount visible.

- Split is open source under the MIT license, with contributing guide, code
  of conduct, security policy, issue and pull request templates
  ([#7](https://github.com/yoink-labs/split/pull/7)).
- iOS: **You** links to the source code on GitHub, and `split --help` points
  to the repository.

## [0.4.0] - 2026-11-18

TestFlight build 5 ([#5](https://github.com/yoink-labs/split/pull/5)).

### Added

- Settlement currency per group, with historical exchange rates from
  Frankfurter (BCRA for ARS) or a manual rate frozen on each expense.
- Minimum-transfer settlement for up to 16 open balances.
- CSV import from Splitwise, Splid, Settle Up and Tricount, and CSV export.
- Recurring expenses (daily, weekly, monthly, yearly), checked every 15
  minutes by the Worker.
- Payment links (PayPal.Me, Venmo, Mercado Pago, Argentine alias/CVU) and
  default per-member shares in group settings.

## [0.3.0] - 2026-11-18

TestFlight build 4 ([#4](https://github.com/yoink-labs/split/pull/4)).

### Added

- Receipt photos read on the device, with item claims shared across members
  and a payer action to close remaining items.
- Spending breakdowns by category, month and person under **Balances**.

### Changed

- Denser group cards and ledger.

## [0.2.0] - 2026-11-18

TestFlight build 3 ([#3](https://github.com/yoink-labs/split/pull/3)).

### Added

- Reusable group invites by link or code, and a Join group form.
- Placeholders that can be claimed by invite or verified email, and account
  lookup by exact email or username.
- Editing and deleting expenses and payments.

## [0.1.0] - 2026-11-17

TestFlight builds 1 and 2 ([#1](https://github.com/yoink-labs/split/pull/1)).

### Added

- The iOS shared-expense app: groups, equal and uneven splits, settle-up
  suggestions and payments, Clerk sign-in, offline outbox and a sample
  preview.
- Cloudflare Worker API on D1.
- CLI 0.1.0 and MCP server via Homebrew
  ([#2](https://github.com/yoink-labs/split/pull/2)).
