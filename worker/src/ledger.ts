import { Exchange, readExchange, settlementEntry } from './exchange';
import { Bill, itemSplit, readBill } from './items';
export const currencies = ['USD', 'ARS', 'EUR', 'GBP', 'BRL', 'CAD', 'AUD', 'MXN'] as const;
export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares' | 'adjustment';
export interface Portion { memberID: string; amount: number }
export interface Payer { memberID: string; amount: number }
export interface Entry { exchange?:Exchange; bill?:Bill; category?:string; receiptIDs?:string[]; payers?:Payer[]; notes?:string; id: string; groupID: string; title: string; amount: number; currency: string; paidBy: string; splits: Portion[]; kind: 'expense' | 'settlement'; splitMode: SplitMode; createdAt: string }
export class InputError extends Error {}
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total <= 0 || total > 100_000_000_000 || !weights.length || weights.length > 50 || weights.some(w => !Number.isSafeInteger(w) || w < 0 || w > 100_000_000_000) || weights.every(w => w === 0)) throw new InputError('Enter valid amounts and at least one participant.');
  const sum = weights.reduce((a,b) => a + BigInt(b), 0n);
  const amounts = weights.map(w => Number(BigInt(total) * BigInt(w) / sum));
  const order = weights.map((w,i) => ({i,r:BigInt(total)*BigInt(w)%sum})).sort((a,b) => a.r === b.r ? a.i-b.i : a.r>b.r ? -1:1);
  for (let i=0, left=total-amounts.reduce((a,b)=>a+b,0); i<left;i++) amounts[order[i].i]++;
  return amounts;
}
function readPayers(value: unknown, memberIDs: string[], total: number, paidBy: string, kind: Entry['kind']): Payer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new InputError('Choose one to fifty payers.');
  const seen = new Set<string>();
  let sum = 0;
  const payers = value.map(p => {
    if (!p || typeof p !== 'object' || typeof p.memberID !== 'string' || !memberIDs.includes(p.memberID) ||
        seen.has(p.memberID) || !Number.isSafeInteger(p.amount) || p.amount <= 0)
      throw new InputError('Check who paid and how much.');
    seen.add(p.memberID);
    sum += p.amount;
    return {memberID:p.memberID, amount:p.amount};
  });
  if (sum !== total) throw new InputError('The payer amounts must match the total exactly.');
  if (!seen.has(paidBy)) throw new InputError('Choose the payer who recorded this expense.');
  if (kind === 'settlement' && (payers.length !== 1 || payers[0].memberID !== paidBy)) throw new InputError('Choose two different people.');
  return payers;
}
export function validateEntry(value: unknown, memberIDs: string[], previous?:Bill): Entry {
  if (!value || typeof value !== 'object') throw new InputError('Invalid entry.');
  const e = value as Entry;
  if (!validID(e.id) || !validID(e.groupID) || typeof e.title !== 'string' || !e.title.trim() || e.title.length > 120 || !Number.isSafeInteger(e.amount) || e.amount <= 0 || e.amount > 100_000_000_000 || !currencies.includes(e.currency as typeof currencies[number]) || !memberIDs.includes(e.paidBy) || !['expense','settlement'].includes(e.kind) || !['equal','exact','percent','shares','adjustment'].includes(e.splitMode) || typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt))) throw new InputError('Check the entry amount, currency, and payer.');
  if (!Array.isArray(e.splits) || !e.splits.length || e.splits.length > memberIDs.length || new Set(e.splits.map(s=>s.memberID)).size !== e.splits.length || e.splits.some(s=>!memberIDs.includes(s.memberID) || !Number.isSafeInteger(s.amount) || s.amount < 0) || e.splits.reduce((n,s)=>n+s.amount,0) !== e.amount) throw new InputError('The split must match the total exactly.');
  if (e.kind === 'settlement' && (e.splits.length !== 1 || e.splits[0].memberID === e.paidBy)) throw new InputError('Choose two different people.');
  const extras:Partial<Entry>={};
  if(e.payers!=null) extras.payers=readPayers(e.payers,memberIDs,e.amount,e.paidBy,e.kind);
  if(e.notes!=null) {
    if(typeof e.notes!=='string') throw new InputError('Write a note of up to 2,000 characters.');
    const notes=e.notes.trim();
    if(!notes || notes.length>2000) throw new InputError('Write a note of up to 2,000 characters.');
    extras.notes=notes;
  }
  if(e.exchange!=null) extras.exchange=readExchange(e);
  if(e.category!=null) {
    if(e.kind!=='expense' || typeof e.category!=='string' || !e.category.trim() || e.category.length>50) throw new InputError('Choose a valid category.');
    extras.category=e.category.trim();
  }
  if(e.bill!=null) {
    if(e.kind!=='expense' || e.splitMode!=='exact') throw new InputError('Receipt items require an exact expense split.');
    extras.bill=readBill(e.bill,memberIDs,e.amount,previous);
    const portions=itemSplit(extras.bill,e.paidBy);
    if(portions.length!==e.splits.length || portions.some(p=>!e.splits.some(s=>p.memberID===s.memberID && p.amount===s.amount))) throw new InputError('Refresh the item split.');
  }
  // Whitelist the wire representation so callers cannot persist extra fields.
  return {id:e.id,groupID:e.groupID,title:e.title.trim(),amount:e.amount,currency:e.currency,paidBy:e.paidBy,splits:e.splits.map(s=>({memberID:s.memberID,amount:s.amount})),kind:e.kind,splitMode:e.splitMode,createdAt:e.createdAt,...extras};
}
export function validID(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id); }
/** Payers in canonical form. Older entries with a single payer keep their stored shape. */
export function entryPayers(e: Entry): Payer[] { return e.payers?.length ? e.payers : [{memberID:e.paidBy, amount:e.amount}]; }
export function balances(entries: Entry[], currency: string): Record<string,number> {
  const result: Record<string,number> = {};
  for (const e of entries.map(settlementEntry).filter(e=>e.currency===currency)) {
    for (const p of entryPayers(e)) result[p.memberID]=(result[p.memberID]??0)+p.amount;
    for (const s of e.splits) result[s.memberID]=(result[s.memberID]??0)-s.amount;
  }
  return result;
}
export { transferPlan as simplify } from './settle';
