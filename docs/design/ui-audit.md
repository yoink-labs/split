# UI consistency audit (0.7)

Captured on an iPhone 17 Pro simulator in light and dark mode, using the
fictional demo data (Buenos Aires Trip with Harris, Maya, Alex and Sam). The web
client was checked at 1280 px and at iPhone width. Reference material:
Apple's Human Interface Guidelines, the vendored
[`swiftui-pro`](../../.agents/skills/swiftui-pro/SKILL.md) skill (MIT) and
Anthropic's [`frontend-design`](../../.agents/skills/frontend-design/SKILL.md)
skill (Apache 2.0). Before and after captures are in
[`screenshots/ui-pass`](../../screenshots/ui-pass/README.md).

## How comparable apps place primary actions

- **Apple Wallet, Find My, Reminders:** a large title with one "+" in the top
  trailing corner. Secondary choices live in that button's menu.
- **Splitwise:** one prominent "Add expense" action. Creating or joining a
  group is a secondary create action in the navigation bar.
- **Venmo:** Pay and Request share one row at equal width.
- **Airbnb:** an empty list shows a centred message with a single primary
  button.

Split now follows the same rules. Each tab has a large title, and create
actions sit in a top-right "+" or menu. Paired actions fill one row at equal
widths, and an empty list shows a centred state with one primary button.

## Findings

| Area | Before | After |
| --- | --- | --- |
| **Headers** | Each tab had its own header. Home used a custom greeting with a hidden navigation bar. Activity used a custom title and round icon buttons. Groups and Friends put the title as a list row under the search field. You used a system large title. | All five tabs use a system large title, with actions in the top trailing toolbar. |
| **Primary actions** | Group creation lived in three places: a toolbar "+", a third icon on Home, and left-aligned New group and Join group buttons on the iPad and web placeholders. Action rows were left-aligned with empty space on the right. | Groups uses a single "+" menu with **New group** and **Join with code or link**. On Home, the "+" menu also offers expense and payment shortcuts. Add expense and Settle up fill one row at equal widths and stack at accessibility text sizes. |
| **Empty states** | Inline `EmptyPanel` rows inside lists, sometimes with no action. An empty list could flash before the first sync. | A centred `EmptyStateView` (`ContentUnavailableView`) with one primary button, the system search-results state when a search has no matches, and a spinner until the first data has loaded. |
| **Member breakdown** | Repeated the name in the title and the header. The Paid/Share figures ran together. Dates were raw ISO strings (`2026-11-17`). The chevron sat under the amount. Payments were a separate list, and the group switcher was an oversized capsule. | The header shows the avatar, name, group and **net balance**, with Paid, Share and Charge counts. Group chips include **All groups**, and a Charges/Payments segmented control appears when there are payments. Charges are grouped by trip, and every row shows the merchant, date, payer, **their share** and **of total**. Rows open the receipt, where the people list is now titled **Split with**. |
| **Rows** | Group, friend and charge rows used different title sizes (`subheadline`/`caption2`), different badge sizes (32–40 pt) and inline amounts. | One `LedgerRow` pattern: a 40 pt badge, a `body` semibold title, a `subheadline` detail, and a trailing amount with a caption. Balances use `BalanceLabel`, whose caption ("you owe", "gets back") means colour is never the only signal. |
| **Type scale** | Heavy use of `caption2`, which the HIG review rules flag as too small. | Row details use `subheadline` and captions use `caption`. `caption2` was removed from the redesigned rows. |
| **Spacing and radii** | Hard-coded 9, 10, 11, 14, 15 and 18 pt gaps; corner radii of 12, 13, 14, 15, 18 and 24. | `Spacing` (4 pt scale) and `Radius` (badge 12, card 18, header 22) tokens in `DesignSystem.swift`. Web CSS variables use the same values. |
| **Cards** | The hero cards on Group, Friend and Member each had their own copy of the gradient and stroke. | A shared `HeroHeader`, `HeroBalances` and `HeroStats`. |
| **Refresh** | Pull-to-refresh returned immediately if a sync was already running, so the spinner vanished early. Cancelling a refresh showed a "cancelled" error. The error banner cleared and reappeared on every attempt. Every sync republished an identical snapshot (redrawing every list), and entries with the same timestamp could swap places. | A single-flight sync that callers wait on, with one follow-up pass. The request runs in its own task, so cancelling a refresh does not cancel it, and cancellation errors are ignored. The error clears only after a success. Snapshots are deduplicated by id, merged with pending local work, and published only when they change. Order uses the timestamp, then the id. The web client uses the same rules. |
| **Web** | Left-aligned **Join group** and **New group** buttons, a plain-text empty state, a member page with a select element and no balance, and an instant refresh button with no busy state. | A "+" menu, a centred empty state, and the same member header, chips, segmented control and rows as iOS. The refresh button shows a busy state, and dark mode is supported. |

## Remaining notes

- Group detail and Activity still use the richer `EntryRow` (likes, comments,
  open purchases). It shares the badge and type sizes but not the two-line
  `LedgerRow` layout, because it carries social metadata.
- iPad and iPhone Duo keep the existing split view. The placeholder detail is
  now the same centred empty state.
