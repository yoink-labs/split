# Splitwise export fixtures

Fictional data in the layout of Splitwise's per-group **Export as spreadsheet** CSV:
`Date, Description, Category, Cost, Currency`, one net column per member (paid minus
owed), a blank line after the header, a blank line before the totals and one
**Total balance** row per currency. Splitwise translates the header, the category
names and the total label into the account language, so `wg-kasse` uses the German
labels. Amounts always have two decimals and a `.` separator.

| File | Covers |
| --- | --- |
| `buenos-aires-trip_2026-11-18_export.csv` | ARS and USD in one group, a multi-payer expense, payments, a zero-effect row, a comma and quotes in descriptions |
| `piso-compartido_2026-11-18_export.csv` | Non-ASCII names and descriptions, CRLF line endings |
| `wg-kasse_2026-11-18_export.csv` | German headers, `Zahlung` payments and the `Gesamtbilanz` total |
| `friend-maya_2026-11-18_export.csv` | A friend export with the "does not include group expenses" preamble |
| `excel-resaved.csv` | A file re-saved by a spreadsheet: CR line endings, `M/D/YY` dates, whole numbers, empty-comma rows |
| `edited-totals_export.csv` | Totals that don't match the rows, which must show a mismatch warning |

No real exports or personal data belong here.
