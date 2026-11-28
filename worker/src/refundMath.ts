// Refund and pending math shared by the Worker and the web client, like splitwiseCsv.ts.
// Keep it free of Worker-only imports. iOS mirrors it in Split/Core/Refunds.swift, and
// fixtures/refunds/cases.json keeps the two in step. See docs/REFUNDS_AND_PENDING.md.
import { allocate, balances, entrySign, InputError, type Entry, type Portion } from './ledger';

type Member = { id: string; name: string };
export const sign = (e: Pick<Entry, 'kind'>) => entrySign(e);
export const isSpend = (e: Pick<Entry, 'kind'>) => e.kind === 'expense' || e.kind === 'refund';
export const isRefund = (e: Pick<Entry, 'kind'>) => e.kind === 'refund';

export function refundsOf<T extends Entry>(entries: T[], id: string, excludeID?: string) {
  return entries.filter((e) => e.kind === 'refund' && e.refundOf === id && e.id !== excludeID);
}

/** What is left to refund: in total, and per person (their share minus earlier credits). */
export function refundRoom(original: Entry, refunds: Entry[]) {
  const members: Record<string, number> = {};
  for (const s of original.splits) if (s.amount > 0) members[s.memberID] = (members[s.memberID] ?? 0) + s.amount;
  let total = original.amount;
  for (const r of refunds) {
    total -= r.amount;
    for (const s of r.splits) if (s.memberID in members) members[s.memberID] -= s.amount;
  }
  return { total, members };
}

/** Credits proportional to each person's remaining share. No one gets more than their room. */
export function proportionalCredits(amount: number, room: Record<string, number>, ids: string[]): Portion[] {
  const weights = ids.map((id) => Math.max(0, room[id] ?? 0));
  if (!amount || !weights.some((w) => w > 0)) return [];
  const amounts = allocate(amount, weights, Number.MAX_SAFE_INTEGER);
  return ids.map((memberID, i) => ({ memberID, amount: amounts[i] })).filter((p) => p.amount > 0);
}

/** The Worker's refund rules, checked before sending so the form can explain the problem. */
export function refundProblem(refund: Entry, original: Entry | undefined, others: Entry[], members: Member[]) {
  if (refund.amount <= 0) return 'Enter a refund greater than zero.';
  if (refund.splits.reduce((n, s) => n + s.amount, 0) !== refund.amount) return 'Credits must add up to the refund exactly.';
  if (refund.splits.every((s) => s.memberID === refund.paidBy || s.amount === 0))
    return 'Credit the refund to someone other than the person who received it.';
  if (!original) return null;
  const { total, members: room } = refundRoom(original, others);
  if (refund.amount > total)
    return total > 0 ? `Refunds can’t exceed the original expense. Up to ${(total / 100).toFixed(2)} ${original.currency} is left.`
      : 'This expense has already been fully refunded.';
  for (const s of refund.splits) {
    if (!s.amount) continue;
    if (!(s.memberID in room)) return 'Refund only people who shared the original expense.';
    if (s.amount > room[s.memberID]) {
      const name = members.find((m) => m.id === s.memberID)?.name ?? 'A member';
      return `${name} can get back at most ${(Math.max(0, room[s.memberID]) / 100).toFixed(2)} ${original.currency}, their remaining share.`;
    }
  }
  return null;
}

/** The resolve "adjust" action: every split and payer rescaled to the new amount, exact to the cent, pending cleared. */
export function adjustedEntry<T extends Entry>(entry: T, amount: number, statementAmount?: unknown): T {
  if (entry.bill) throw new InputError('Edit the receipt items to change an itemized expense.');
  const scale = <P extends {amount:number; nights?:number}>(list: P[]) => {
    const amounts = allocate(amount, list.map(p => p.nights ?? p.amount));
    return list.map((p, i) => ({...p, amount: amounts[i]}));
  };
  let exchange = entry.exchange;
  if (exchange?.source === 'Statement') {
    if (statementAmount === undefined) throw new InputError('Enter the new amount charged on your statement.');
    exchange = {...exchange, statementAmount: statementAmount as number};
  } else if (statementAmount !== undefined) throw new InputError('Only statement conversions take a statement amount.');
  const {pending: _pending, pendingNote: _note, ...rest} = entry;
  return {...rest, amount, splits: scale(entry.splits), ...(entry.payers?.length ? {payers: scale(entry.payers)} : {}), ...(exchange ? {exchange} : {})} as T;
}

export const confirmed = <T extends Entry>(entry: T): T => {
  const { pending: _p, pendingNote: _n, ...rest } = entry;
  return rest as T;
};

/** Pending entries in one currency (already converted), and the balances with and without them. */
export function pendingView(entries: Entry[], currency: string) {
  const pending = entries.filter((e) => e.pending && !e.handled && e.currency === currency);
  return {
    pending,
    total: pending.reduce((n, e) => n + sign(e) * e.amount, 0),
    withPending: balances(entries, currency),
    confirmedOnly: balances(entries, currency, { includePending: false }),
  };
}

