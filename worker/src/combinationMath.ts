import { allocate, entryPayers, InputError, validateEntry, type Entry } from './ledger';

export interface CombinationSuggestion { title:string; entryIDs:string[] }
export interface CombinationEvent { entryID:string; title:string; count:number; actor:string|null; at:string; action:'combine'|'uncombine' }
export function canCombineExpense(entry: Entry & {recurrence?:string|null}, entries: Entry[]) {
  return entry.kind === 'expense' && !entry.combinedCount && !entry.pending && !entry.handled && !entry.exchange && !entry.spread && !entry.splits.some(s => s.nights !== undefined)
    && (!entry.recurrence || entry.recurrence === 'off') && !entries.some(other => other.refundOf === entry.id);
}

function rideKey(title: string) {
  const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const destination = normalized.match(/^(uber|lyft|bolt|grab|cabify|taxi|ride share|rideshare|99)\s+(.+)$/u)?.[2]
    .replace(/^(?:ride\s+)?(?:to\s+)?/u, '').trim();
  return destination && !/^(ride|trip|transport|taxi|x|xl|comfort|black)$/u.test(destination) ? destination : undefined;
}

export function combinationSuggestions(entries: Entry[]): CombinationSuggestion[] {
  const candidates = new Map<string, Entry[][]>();
  for (const entry of [...entries].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))) {
    const key = rideKey(entry.title);
    if (!key) continue;
    const identity = JSON.stringify([entry.currency, key]);
    const trips = candidates.get(identity) ?? [];
    const trip = trips.at(-1);
    if (trip && Date.parse(entry.createdAt) - Date.parse(trip[0].createdAt) <= 2 * 3600_000 && trip.length < 50)
      trip.push(entry);
    else trips.push([entry]);
    candidates.set(identity, trips);
  }
  return [...candidates.values()].flat()
    .filter(trip => trip.length > 1 && new Set(trip.flatMap(entryPayers).map(payer => payer.memberID)).size > 1)
    .sort((a, b) => Date.parse(b[0].createdAt) - Date.parse(a[0].createdAt))
    .slice(0, 10).map(trip => ({ title: trip[0].title, entryIDs: trip.map(entry => entry.id) }));
}

export function combinedEntry(id: string, entries: Entry[], members: {id:string; removed_at?:unknown}[], b: Record<string, unknown>) {
  const first = entries[0];
  if (entries.some(entry => entry.currency !== first.currency)) throw new InputError('Choose expenses in the same currency.');
  const memberIDs = members.map(m => m.id);
  const payerAmounts = new Map<string, number>();
  for (const payer of entries.flatMap(entryPayers))
    payerAmounts.set(payer.memberID, (payerAmounts.get(payer.memberID) ?? 0) + payer.amount);
  const amount = entries.reduce((total, entry) => total + entry.amount, 0);
  const mode = b.splitMode ?? 'equal';
  if (mode !== 'equal' && mode !== 'shares' && mode !== 'exact' && mode !== 'percent' && mode !== 'adjustment')
    throw new InputError('Choose a supported split mode.');
  const parts = b.parts ?? members.filter(m => !m.removed_at).map(m => ({memberID:m.id, amount:1}));
  if (!Array.isArray(parts) || !parts.length || parts.length > 50 || parts.some(p => !p || !memberIDs.includes(p.memberID)
    || (mode !== 'equal' && (!Number.isSafeInteger(p.amount) || Math.abs(p.amount) > 100_000_000_000))))
    throw new InputError('Choose group members.');
  if (mode === 'percent' && parts.reduce((total, p) => total + p.amount, 0) !== 10_000)
    throw new InputError('Percentages in basis points must add up to 10,000.');
  let amounts: number[];
  if (mode === 'adjustment') {
    if (parts.reduce((total, p) => total + p.amount, 0) !== 0) throw new InputError('Adjustments must add up to zero.');
    amounts = allocate(amount, parts.map(() => 1)).map((base, index) => base + parts[index].amount);
    if (amounts.some(value => value < 0)) throw new InputError('An adjustment cannot take a share below zero.');
  } else {
    amounts = mode === 'exact' ? parts.map(p => p.amount)
      : allocate(amount, parts.map(p => mode === 'equal' ? 1 : p.amount));
  }
  return validateEntry({
    id, groupID:first.groupID, kind:'expense', currency:first.currency, amount, paidBy:first.paidBy, createdAt:first.createdAt,
    title:b.title ?? first.title, category:first.category, splitMode:mode,
    payers:[...payerAmounts].map(([memberID, amount]) => ({memberID, amount})),
    splits:parts.map((p, i) => ({memberID:p.memberID, amount:amounts[i]})),
  }, memberIDs);
}
