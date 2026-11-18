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
