# Changelog

All notable changes to Split are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions match the iOS app's marketing version. The TestFlight build number
is noted next to each release. The CLI is versioned separately with
`split-v*` tags.

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
