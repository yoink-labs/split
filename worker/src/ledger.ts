import { Exchange, readExchange, settlementEntry } from './exchange';
import { Bill, itemSplit, readBill, reconcileBill } from './items';
// Active fiat currencies from the Frankfurter v2 catalog. Keep in sync with Money.currencies.
export const currencies = `
  AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF
  BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CMD CNH
  CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD
  FKP GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR
  ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR KMF KPW
  KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK
  MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD
  OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD
  SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS
  TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV
  WST XAF XCD XCG XDR XOF XPF YER ZAR ZMW ZWG
`.trim().split(/\s+/);
export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares' | 'adjustment' | 'nights';
export interface Portion { memberID: string; amount: number; nights?: number }
export interface Payer { memberID: string; amount: number }
/** kind 'refund': paidBy received the money back (from a vendor, or holds it for a credit) and splits are the credits
 * owed to each person. Its balance effect is the mirror image of an expense. refundOf links the original expense. */
export type EntryKind = 'expense' | 'settlement' | 'refund';
export interface Entry { spread?: { start: string; end: string }; combinedCount?:number; handled?: boolean; pending?: boolean; pendingNote?: string; refundOf?: string; refundItems?: string[]; exchange?:Exchange; bill?:Bill; category?:string; receiptIDs?:string[]; payers?:Payer[]; notes?:string; id: string; groupID: string; title: string; amount: number; currency: string; paidBy: string; splits: Portion[]; kind: EntryKind; splitMode: SplitMode; createdAt: string }
export class InputError extends Error {}
export function allocate(total: number, weights: number[], maximumTotal = 100_000_000_000): number[] {
  if (!Number.isSafeInteger(total) || total <= 0 || total > maximumTotal || !weights.length || weights.length > 50 || weights.some(w => !Number.isSafeInteger(w) || w < 0 || w > 100_000_000_000) || weights.every(w => w === 0)) throw new InputError('Enter valid amounts and at least one participant.');
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
export function validateEntry(value: unknown, memberIDs: string[], previous?:Bill, options?:{reconcileBill:boolean}): Entry {
  if (!value || typeof value !== 'object') throw new InputError('Invalid entry.');
  const e = value as Entry;
  if (!validID(e.id) || !validID(e.groupID) || typeof e.title !== 'string' || !e.title.trim() || e.title.length > 120 || !Number.isSafeInteger(e.amount) || e.amount <= 0 || e.amount > 100_000_000_000 || !currencies.includes(e.currency as typeof currencies[number]) || !memberIDs.includes(e.paidBy) || !['expense','settlement','refund'].includes(e.kind) || !['equal','exact','percent','shares','adjustment','nights'].includes(e.splitMode) || typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt))) throw new InputError('Check the entry amount, currency, and payer.');
  if (!Array.isArray(e.splits) || !e.splits.length || e.splits.length > memberIDs.length || new Set(e.splits.map(s=>s?.memberID)).size !== e.splits.length || e.splits.some(s=>!s || !memberIDs.includes(s.memberID) || !Number.isSafeInteger(s.amount) || s.amount < 0) || e.splits.reduce((n,s)=>n+s.amount,0) !== e.amount) throw new InputError('The split must match the total exactly.');
  if (e.kind === 'settlement' && (e.splits.length !== 1 || e.splits[0].memberID === e.paidBy)) throw new InputError('Choose two different people.');
  const extras:Partial<Entry>={};
  if (e.spread != null) {
    const count = spreadLength(e.spread);
    if (e.kind !== 'expense' || count < 1 || count > 366)
      throw new InputError('Choose a start date and a later end date, up to 366 days apart.');
    extras.spread = { start: e.spread.start, end: e.spread.end };
  }
  const usesNights = e.splitMode === 'nights' || (e.splitMode === 'shares' && e.splits.some(s => s.nights !== undefined));
  if (usesNights) {
    const nights = e.splits.map(s => s.nights);
    const limit = extras.spread ? spreadLength(extras.spread) : 366;
    if (e.kind !== 'expense' || nights.some(n => !Number.isSafeInteger(n) || n! < 1 || n! > limit))
      throw new InputError('Enter a whole number of nights per person within the stay.');
    const amounts = allocate(e.amount, nights as number[]);
    if (e.splits.some((s, i) => s.amount !== amounts[i]))
      throw new InputError('Refresh the split by nights.');
  } else if (e.splits.some(s => s.nights !== undefined)) {
    throw new InputError('Night counts require a nights split.');
  }
  if(e.handled!==undefined) {
    if(typeof e.handled!=='boolean' || e.kind!=='expense') throw new InputError('Only expenses can be marked as already handled.');
    if(e.handled) extras.handled=true;
  }
  if(e.pending!==undefined) {
    if(typeof e.pending!=='boolean' || e.kind==='settlement') throw new InputError('Only expenses and refunds can be pending.');
    if(e.pending && extras.handled) throw new InputError('An expense that was already handled cannot be pending.');
    if(e.pending) extras.pending=true;
  }
  if(e.pendingNote!=null) {
    const note=typeof e.pendingNote==='string' ? e.pendingNote.trim() : '';
    if(typeof e.pendingNote!=='string' || note.length>500) throw new InputError('Write a pending note of up to 500 characters.');
    if(note && !extras.pending) throw new InputError('Only a pending entry can have a pending note.');
    if(note) extras.pendingNote=note;
  }
  if(e.kind==='refund') {
    if(e.payers!=null || e.bill!=null) throw new InputError('A refund goes back to one person and has no receipt items.');
    if(e.refundOf!=null && !validID(e.refundOf)) throw new InputError('Choose the expense this refund belongs to.');
    if(e.refundOf===e.id) throw new InputError('A refund cannot refund itself.');
    if(e.splits.every(s=>s.memberID===e.paidBy || s.amount===0)) throw new InputError('Credit the refund to someone other than the person who received it.');
    if(e.refundOf!=null) extras.refundOf=e.refundOf;
    if(e.refundItems!=null) {
      if(e.refundOf==null || !Array.isArray(e.refundItems) || !e.refundItems.length || e.refundItems.length>50 ||
         new Set(e.refundItems).size!==e.refundItems.length || e.refundItems.some(id=>!validID(id))) throw new InputError('Choose items from the original receipt to refund.');
      extras.refundItems=[...e.refundItems];
    }
  } else if(e.refundOf!=null || e.refundItems!=null) throw new InputError('Only refunds can refer to an original expense.');
  if(e.payers!=null) extras.payers=readPayers(e.payers,memberIDs,e.amount,e.paidBy,e.kind);
  if(e.notes!=null) {
    if(typeof e.notes!=='string') throw new InputError('Write a note of up to 2,000 characters.');
    const notes=e.notes.trim();
    if(!notes || notes.length>2000) throw new InputError('Write a note of up to 2,000 characters.');
    extras.notes=notes;
  }
  if(e.exchange!=null) extras.exchange=readExchange(e);
  if(e.category!=null) {
    if(e.kind==='settlement' || typeof e.category!=='string' || !e.category.trim() || e.category.length>50) throw new InputError('Choose a valid category.');
    extras.category=e.category.trim();
  }
  if(e.bill!=null) {
    if(e.kind!=='expense' || e.splitMode!=='exact') throw new InputError('Receipt items require an exact expense split.');
    // On writes that reconcile status, accept a stale client flag so edits can reopen the bill.
    extras.bill=readBill(e.bill,memberIDs,e.amount,previous,options?.reconcileBill);
    const portions=itemSplit(extras.bill,e.paidBy);
    if(portions.length!==e.splits.length || portions.some(p=>!e.splits.some(s=>p.memberID===s.memberID && p.amount===s.amount))) throw new InputError('Refresh the item split.');
  }
  // Encode nights as weighted shares with optional counts so older clients can still decode the ledger.
  // Whitelist the wire representation so callers cannot persist extra fields.
  const entry:Entry={id:e.id,groupID:e.groupID,title:e.title.trim(),amount:e.amount,currency:e.currency,paidBy:e.paidBy,splits:e.splits.map(s=>({memberID:s.memberID,amount:s.amount,...(s.nights === undefined ? {} : {nights:s.nights})})),kind:e.kind,splitMode:usesNights ? 'shares' : e.splitMode,createdAt:e.createdAt,...extras};
  if (options?.reconcileBill) {
    if (entry.bill && previous?.closed===false && entry.bill.tax===previous.tax && entry.bill.tip===previous.tip &&
        JSON.stringify(entry.bill.items)===JSON.stringify(previous.items)) entry.bill.closed=false;
    else reconcileBill(entry);
  }
  return entry;
}
export function validID(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id); }
/** Payers in canonical form. Older entries with a single payer keep their stored shape. */
export function entryPayers(e: Entry): Payer[] { return e.payers?.length ? e.payers : [{memberID:e.paidBy, amount:e.amount}]; }
/** +1 for expenses and payments, -1 for refunds and credits, which give money back. */
export function entrySign(e: Pick<Entry,'kind'>): 1 | -1 { return e.kind==='refund' ? -1 : 1; }
/**
 * Net balance per member. Pending entries count by default: their money has already moved, and
 * resolving one (confirm, adjust or refund) only changes the balance from there. Pass
 * includePending:false for the confirmed-only view.
 */
export function balances(entries: Entry[], currency: string, { includeHandled = false, includePending = true } = {}): Record<string,number> {
  const result: Record<string,number> = {};
  for (const e of entries.filter(e=>(includeHandled || !e.handled) && (includePending || !e.pending)).map(settlementEntry).filter(e=>e.currency===currency)) {
    const sign=entrySign(e);
    for (const p of entryPayers(e)) result[p.memberID]=(result[p.memberID]??0)+sign*p.amount;
    for (const s of e.splits) result[s.memberID]=(result[s.memberID]??0)-sign*s.amount;
  }
  return result;
}
/** The signed contribution of one entry to a member’s outstanding balance. */
export function balanceLine(entry: Entry, memberID: string) {
  const settled = settlementEntry(entry);
  const paid = entryPayers(settled).filter(p => p.memberID === memberID).reduce((sum, p) => sum + p.amount, 0);
  const share = settled.splits.filter(s => s.memberID === memberID).reduce((sum, s) => sum + s.amount, 0);
  return { currency: settled.currency, amount: entry.handled ? 0 : entrySign(entry) * (paid - share) };
}
export { transferPlan as simplify } from './settle';

const millisecondsPerDay = 86_400_000;
function dayNumber(day: string): number {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? +date / millisecondsPerDay : NaN;
}
export function spreadLength(spread: NonNullable<Entry['spread']>): number {
  return dayNumber(spread.end) - dayNumber(spread.start) || 0;
}

/** Display rate in minor units rounded to the nearest cent. Portions keep their exact allocation. */
export function nightRate(entry: Entry): number {
  const nights = entry.splits.reduce((sum, s) => sum + (s.nights ?? 0), 0);
  return nights ? Number((BigInt(entry.amount) + BigInt(nights) / 2n) / BigInt(nights)) : 0;
}

export interface DailyCost {
  day: string;
  currency: string;
  amount: number;
  items: { id: string; title: string; amount: number }[];
}

/** Keep the original currencies and attribute refunds to the day they were received. */
export function dailyCosts(entries: Entry[], memberID: string): DailyCost[] {
  const days = new Map<string, DailyCost>();
  for (const entry of entries) {
    if (entry.kind === 'settlement') continue;
    const portion = entry.splits.find(s => s.memberID === memberID);
    if (!portion) continue;
    const range = entry.spread && spreadLength(entry.spread);
    const count = range ? Math.min(portion.nights ?? range, range) : 1;
    const remainder = portion.amount % count;
    const unit = (portion.amount - remainder) / count;
    for (let index = 0; index < count; index++) {
      const day = range
        ? new Date((dayNumber(entry.spread!.start) + index) * millisecondsPerDay).toISOString().slice(0, 10)
        : entry.createdAt.slice(0, 10);
      const amount = entrySign(entry) * (unit + Number(index < remainder));
      const key = day + ':' + entry.currency;
      let daily = days.get(key);
      if (!daily) {
        daily = {day, currency: entry.currency, amount: 0, items: []};
        days.set(key, daily);
      }
      daily.amount += amount;
      daily.items.push({id: entry.id, title: entry.title, amount});
    }
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day) || a.currency.localeCompare(b.currency));
}
