# Importing from Splitwise

Split imports Splitwise's per-group **Export as spreadsheet** CSV on iOS and
the web. It is free and needs no Splitwise account connection.

## Exporting from Splitwise

From Splitwise's help article
[How do I export my Splitwise data?](https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data):

- **Website:** open the group or friend, select the settings (gear) icon, then
  **Export as spreadsheet**.
- **Mobile app:** open the group or friend, scroll the header buttons to the
  end and tap **Export**.

The CSV export is available on Splitwise's free plan (only the JSON backup is
listed as a Pro feature).

## The file format

Checked against real (anonymised) exports attached to
[cospend-nc#159](https://github.com/julien-nc/cospend-nc/issues/159):

- Header `Date,Description,Category,Cost,Currency`, then one column per member.
  **Splitwise translates the header, category names and the total label into
  the account language** (`Datum,Beschreibung,…`, `Zahlung`, `Gesamtbilanz`), so
  Split matches columns by position and rows by shape.
- A blank line after the header and before the totals. UTF-8, LF line endings,
  minimal quoting.
- Dates `YYYY-MM-DD`; amounts with two decimals, `.` separator, `-` for
  negatives, no symbol.
- Each member cell is that person's net change (paid minus owed). Every row sums
  to zero; Cost is the expense total.
- Payments have the `Payment` category and an "X paid Y" description.
- One **Total balance** row per currency, with blank Category and Cost.

## How rows become entries

- One positive net: that person paid the whole Cost; everyone's share follows
  from the nets exactly.
- Several positive nets (several payers): each payer paid their net plus a share
  of the remainder, allocated by largest remainder. Balances stay exact.
- Rows where every net is zero have no effect on balances and are listed as
  left out. Currencies Split doesn't support yet are left out and named.
- Multi-currency groups keep each entry's original currency, like Splitwise.
- English Splitwise categories map onto Split's (Dining out → Dining, Taxi →
  Transport, Hotel → Travel, …); other names are kept.

After parsing, Split recomputes every member's balance per currency and compares
it with the **Total balance** rows. The preview says "Matches Splitwise to the
cent" or lists each difference.

## Saving

`POST /v1/import/splitwise` creates the group (or targets one you belong to),
inserts placeholders for unmatched names and all entries in one D1 batch with a
single set-based `INSERT … SELECT FROM json_each`, so an import is all or
nothing. A new group's id is derived from your account and the file's SHA-256,
and entry ids from their content, so importing the same file again adds nothing.
Up to 1,500 entries per group, and never past the 5,000-entry account limit.

Fixtures with fictional data live in [`fixtures/splitwise`](../fixtures/splitwise).

## Why there is no "Connect Splitwise" button

Splitwise has a public OAuth 2 API (`https://secure.splitwise.com/api/v3.0`,
`/oauth/authorize`, `/oauth/token`, `get_groups`, `get_expenses`), and app
registration at <https://secure.splitwise.com/apps> appears to be free. Its
[terms](https://dev.splitwise.com/) say:

> To the extent allowed by applicable law, you may not use Splitwise Materials
> to create an application that replicates existing Splitwise functionality or
> competes with Splitwise and our Services.

Split is an expense-splitting app, so an API importer would conflict with those
terms. Split therefore uses only the CSV a person exports themselves, and has no
scraping, no unofficial endpoints and no API scaffold.
