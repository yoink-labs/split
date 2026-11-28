# Refunds, credits and pending expenses

Split records money that comes back to a group as a **refund** and marks
expenses whose cost may still change as **pending**. Amounts stay in integer
minor units and every allocation uses largest remainder, so balances stay
exact to the cent.

## Refunds and credits

A refund is a ledger entry with `kind: "refund"`. Its fields mean:

| Field | Meaning |
| --- | --- |
| `paidBy` | The member who **received** the money back: the card the vendor refunded, or the person giving a credit. |
| `splits` | The credit each person gets. They add up to `amount` exactly. |
| `refundOf` | Optional ID of the original expense. Without it the entry is a standalone credit. |
| `title`, `currency`, `createdAt`, `splitMode`, `category`, `notes`, `exchange` | As for an expense. |

A refund has no `payers`, no `bill`, cannot be `handled`, and must credit at
least one person other than the receiver.

**Balance effect.** A refund is the mirror image of an expense: the receiver's
balance goes down by `amount` (they hold money that belongs to others), and
each credited member's balance goes up by their credit. In code this is
`entrySign(entry) === -1` (`worker/src/ledger.ts`). Spending reports subtract
refunds: a member's *share* goes down by their credit, the receiver's *paid*
goes down by the amount received, and group totals are net of refunds.

**Linked refunds** (`refundOf` set). The Worker checks, for the original and
every other non-deleted refund linked to it:

- the original is a non-deleted expense in the same group (otherwise 404);
- the refund uses the original's currency, and the original's settlement
  currency when it was converted;
- only people with a share of the original are credited;
- each person's credits across all refunds are at most their share;
- all refunds together are at most the original amount.

Inserts and edits are guarded in SQL by the original's payload and the count
and total of its refunds, so two concurrent refunds cannot overshoot. While an
expense has refunds, an edit must keep each share at or above what was
refunded, and the expense cannot be deleted until its refunds are.

## Pending expenses

Any expense or refund can carry `pending: true` and an optional
`pendingNote` (up to 500 characters). Payments cannot be pending, and a
handled expense cannot be pending.

**Default: pending entries count toward balances.** The money already moved,
so the payer is owed it until something changes. Excluding pending entries
would leave the payer under-reimbursed whenever the refund never comes. Every
client also shows the balance **without** pending entries (confirmed only),
marks pending rows, and warns before settling up while a group has pending
entries in that currency. `balances(entries, currency, {includePending:false})`
gives the confirmed-only view.

## Routes

All routes require an active member of the entry's group.

| Route | Body | Who |
| --- | --- | --- |
| `POST /v1/entries` | entry with `kind: "refund"` and optional `refundOf`, `pending`, `pendingNote` | any member |
| `POST /v1/entries/:id/edit` / `delete` | as before; refund rules apply | author |
| `POST /v1/entries/:id/pending` | `{pending: boolean, note?: string}` | author or payer (receiver for a refund) |
| `POST /v1/entries/:id/resolve` | `{action: "confirm"}` | author or payer |
| | `{action: "adjust", amount, statementAmount?}`: rescales every split and payer to the new amount by largest remainder and clears pending | author or payer |
| | `{action: "refund", refund: Entry}`: clears pending and records the linked refund in one transaction | author or payer |

Itemized expenses cannot be adjusted through `resolve`; edit their items.

## Splitwise

Splitwise exports a refund as a row with a negative cost. The importer turns a
negative-cost row with a single receiver into a Split refund: the receiver is
the member with the negative net, and the credits are the positive nets plus
the receiver's own share. Rows with several receivers keep the earlier
expense mapping, which has the same balance effect. Imported balances still
match Splitwise's Total balance rows to the cent. Ledger CSV exports list
refunds with type `refund`, signed per-member nets, and `Pending` with its
note in the status column.
