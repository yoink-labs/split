# Simulator usability audit

The baseline was the merged 0.1.0 (2) app on a lane-owned iPhone simulator. Two tagged Clerk accounts used the production Split API. Alex created a group with Casey as a named placeholder, recorded ARS 30 with exact shares of 10 and 20, and recorded the suggested ARS 20 payment. Both balances reached zero. Maya accepted Casey’s personal link and saw the two historical entries. Maya also created a solo group. Its invite sheet showed only her joined seat and Done.

| Flow | Rough edge in build 2 | Change in 0.2 |
| --- | --- | --- |
| Welcome | A promotional card and repeated free-tier copy push sign-in down the screen. | Short introduction with sign-in actions directly underneath. |
| Signup | Tapping the signup toggle row did not reliably expose the password field during automation. The password manager can cover the form. | Explicit Sign in / Sign up selector, stable field identifiers and native password autofill. The system password chooser can be dismissed. |
| Groups | Small plus icon, slogan and decorative summary compete with the primary action. No Join action, including in the empty state. | Named New group and Join group actions, meaningful balance summary and actionable empty-state copy. |
| Friends | Empty-state button repeats the add control. | One add action and a short explanation of the two-person tab. |
| Create | Comma-separated names cannot identify existing accounts or carry contact details. ARS is preselected regardless of locale. | Individual people picker, optional contact information and supported locale currency with a USD fallback. |
| Membership | A solo group cannot invite anyone. Fully claimed groups cannot grow. Only the first five people are visible in the group header. | Persistent People action, full roster, reusable group invitations and personal placeholder invitations. |
| Joining | No code entry. Copying an invitation takes an extra menu. Returning to an accepted link can leave the user on the group list. | Dedicated join form, direct sharing and copying, and navigation into the joined group. Legacy links still work. |
| Identity | Unregistered people must be named at creation. There is no account search, verified-email claim, or merge if someone already joined separately. | Add placeholders or privately look up existing users at creation or later. Matching verified email or a personal invite resolves old records onto the account. |
| Add expense | A description is mandatory, the total has a placeholder but no explicit amount label, and Save sits below the participant list. Adding a missing person requires leaving the form. | Amount-first form, optional description, persistent Save, named amount field and an inline Add person flow. |
| Uneven splits | Four segmented options crowd the width. The small checkmark is the only selection target. Reusing values after changing units can be confusing. | Labeled split picker, larger participant targets, mode-specific inputs and an allocation preview. |
| Balances and settlement | The suggested transfer is actionable, but the surrounding heading does not identify it as a payment. | Suggested payments, explicit debtor/recipient/amount labels and a prefilled settlement amount. |
| Corrections | Expense rows appear static. Tapping an entry exposes no breakdown, edit or delete action. An incorrect payment cannot be undone. | Entry details, author-only expense editing and confirmed deletion for expenses or payments. |
| Readability | Fixed-size headings, compressed controls and vague entry counts such as “1 shared moments.” | Semantic type styles, adaptable action layout, larger controls, explicit entry counts and matching lime/evergreen appearances. |

## Verification notes

The revised email signup used a fresh QA mailbox, the standard Clerk password flow and the emailed verification code. The two existing QA accounts exercised cross-account lookup and claiming. The Worker suite covers concurrent-safe claim transactions, combining both sides of a historical split, existing settlement history, stale edits and deletes, private name visibility, legacy data and invite expiry. See the [screenshots](../screenshots/README.md) for the app’s light and dark appearances.

On the revised simulator build, Alex joined Maya’s previously solo group by code. A new signup added Alex by exact email and added Maya as a placeholder from an expense. Maya’s next sign-in brought across the USD 28 share. The author changed the description, created an amount-only expense and deleted it. At Accessibility Large, the expense action and Add person remained reachable. Screenshot review also caught a stray title above the group detail, which was removed.

## Density, spending and receipts in 0.3

| Finding | Change and verification |
| --- | --- |
| Group cards spent a second row on repeated avatars and large titles crowded out balances. | Compact cards show the group, roster size and open-purchase badge. The balances screen shows paid, share and net together. Tap a person to inspect their expenses. |
| A blank navigation title left a stray mark in the balances and invitations flow. | The group name and **People & invites** appear as explicit titles in both appearances. |
| A receipt total alone could not explain individual purchases. | A simulator photo of a fictional café receipt produced Coffee 5.01, Toast 9.99, Soup 6.50, tax 1.50 and tip 2.00. The expense showed a 25.00 open total. Verified thumbnail and full-screen viewing. |
| A second person could change a split between preview and save. | Claim updates check the previous claimants. Worker tests cover conflicting updates, shared and placeholder claims, returning items to open status, payer close and historical rounding after member merges. |
| Shared receipts needed cross-account verification. | Two signed-in QA accounts used the production Worker. The second account retrieved the same private JPEG bytes and shared a claim with a placeholder. The payer refreshed the ledger and closed the remaining item. Tests also exercise membership checks, per-expense limits, rollback and deletion. |

The simulator exercises the photo library. The physical camera path uses the system camera picker and requires a device with a camera.

## Group tools in 0.4

On the simulator, a signed-in QA account opened group settings, changed a default weight, exported a three-entry CSV through Files, and selected that file for import. The preview matched its existing members. Confirmation reported zero inserted entries and three duplicates. A USD expense in an ARS group displayed the BCRA source and observation date. Entering a manual rate of 1,200 on a USD 12.00 expense produced an ARS 14,400.00 settlement amount and retained the original USD amount.

Authenticated production checks covered saved payment details, shared weights, schedule creation/cancellation, and repeat import. Worker tests cover concurrent cron invocations, month-end dates, historical conversion, membership permissions, atomic import rollback, claim merging and deterministic transfer ordering. No money was sent. [Screenshots](../screenshots/README.md)

## Splitwise parity, Liquid Glass and iPhone Duo in 0.7

The 0.7 baseline is the Splitwise web client at `secure.splitwise.com` as seen on
17 November 2026, plus the iPhone Duo simulator in Xcode 27.2. The app builds
against the iOS 27.2 SDK, keeps iOS 18 as the deployment target, and uses system
containers only for navigation and bars.

| Flow | Result on the simulator |
| --- | --- |
| Home dashboard | Per-currency totals, person balances, group cards, a nudge share link and the recent ledger render in one column on the outer display and two columns on the inner display. The glass action cluster stays intrinsic; no button consumes a row. |
| Groups | On the inner display the sidebar shows full group names with balances stacked under each name; the detail column keeps the action cluster to three compact pills and a vertical Liquid Glass toolbar. |
| Friends | Aggregated people names stay full-width, with each currency on its own small line. A person without a one-to-one tab offers Add expense, which creates the tab and opens the composer. |
| Activity | Month sections, All/Expenses/Payments filters, group filter, search, likes and comment counts work. Likes and comments were added and persisted in demo mode; live behaviour is covered by Worker tests. |
| Expense composer | Amount, description, category, notes, payers, five split modes, receipt line items, save and save-another are present. A saved ARS 45.50 expense updated the group ledger and balances. |
| Expense detail | Receipt totals, item claims, shares, notes, likes and comments render as cards. Claiming the open provoleta changed the item's claimants and removed it from the open total. |
| Settle up | A suggested transfer prefilled the amount and recorded a settlement; the ledger incremented and the group balance updated. |
| Group settings | Group name, currency lock, simplify toggle, people, default shares, payment handles, CSV import/export, archive and leave are present. Saving details reports "Group details saved." |
| Group balances | Per-currency balances, suggested payments and the Settle action work; ARS and USD are shown separately. |
| Search | Searching "Harris" returns both shared groups, the person result and matching expenses. It works pushed from You and as a sheet from Activity/Home. |
| Insights | The all-groups total, largest category, average, daily bars for a single month, category shares, paid/share/net rows and the six-month chart when data spans months render correctly. |
| Dark mode | All pages were checked in dark appearance; the hero stays dark evergreen with lime/coral values and glass cards remain legible. |
| Dynamic Type | Accessibility Extra Large was checked on the inner display. Display and amount fonts scale up to a capped factor, body copy uses semantic styles, and content scrolls rather than clipping. |
| iPhone Duo poses | Outer portrait, open-wide, open-tall and book/tabletop folds were checked. The system moves the tab bar between the 84 pt vertical bar and the horizontal bottom bar; groups and friends use two panes when regular width is available and collapse on the cover. |

Verification commands:

```sh
npm run typecheck --prefix worker
npm test --prefix worker          # 6 files, 39 tests
node --test cli/test/*.test.mjs   # 2 tests
xcodegen generate
xcodebuild build -project Split.xcodeproj -scheme Split \
  -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO
ade apple test --scheme Split     # 25 tests
```

The simulator does not render the fold's curved division region, so fold
avoidance for custom headers is confirmed by layout inspection rather than a
visible curve. No physical iPhone Duo was available; pose-dependent behaviour is
reported as simulator-verified, not device-verified.

### Design pass and receipt chips

The final 0.7 pass tightened every screen around the same hierarchy: one ink
hero, glass secondary surfaces, compact intrinsic actions, and a single
drifting background. The person-balance sign bug found in the pass is fixed:
the Home and Friends screens now show what you owe and what you are owed from
the same perspective as the group totals. A group that turns off "Simplify
payments" uses the direct transfer plan instead of the minimised plan.

Receipt review was exercised with a synthetic café receipt on the simulator.
On-device Vision recognized four items, tax and tip, and the new composer chips
were used to mark who shared an item. Saving the receipt produced three open
items and an exact split; after saving, the Purchases section showed claimant
chips and the Claim sheet changed the split by ARS 24,250.00, with the open
total clearing. The invite screen builds a QR and short-code card; demo mode
correctly shows the signed-out error instead of generating a fake link.

The system TabView is kept (no `.id(size)` workaround). Folding with an open
expense sheet preserved the sheet and the selected group in simulator checks;
the custom navigation shell was discarded because it covered the system
toolbar. The new suite runs 25 iOS tests, 39 Worker tests and 2 CLI tests.
## Member activity on iOS

From You, Alex opened a receipt-sharing group, checked the original charge, opened its attached café receipt and selected Guest from Split with. Guest's statement showed the same charge and Guest's own share. Back returned to Guest after reopening the expense. The account group picker also exposed Alex's other shared trips at Accessibility Large.
