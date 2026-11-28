import {settlementEntry} from '../exchange';
import {convert, FxCache, impliedRate, rateE8 as parseRate, type Exchange} from '../fx';
import { breakdown, consumptionReport, entryItems, grossItems, itemRefund, itemSplit, type Bill } from '../items';
import { exportGroup } from './export';
import { refundRoom, refundsOf } from '../refundMath';
import { deleteGroup } from '../social';
import { importGroupID, parseSplitwise, type SplitwiseGroup } from '../splitwiseCsv';
import { tools } from '../../../cli/lib/catalog.mjs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { fingerprint, HTTPError, optionalDay } from '../http';
import { allocate, balanceLine, balances, dailyCosts, Entry, entryPayers, InputError, nightRate, readStay, spreadLength, simplify, type StayDates, validateEntry } from '../ledger';


interface Args {
  cadence:string; weights:number[];rate?:string; chargedAmount?:string; group: string; expense: string; member: string; name: string; self: string; placeholders?: string[];
  query: string; user?: string; email?: string; phone?: string; invitation?: string; discoverable?: 'on'|'off';
  invite: string; kind?: string; title?: string; amount?: string; payer?: string; currency?: string;
  notes?: string; date?: string; spreadStart?: string; spreadEnd?: string; stays?: {member: string; start?: string; end?: string}[];
  bill?: { items: { title: string; amount: string; memberIDs?: string[]; shares?: number[] }[]; tax?: string; tip?: string };
  share?: string; shares?: number[];
  payers?: { member: string; amount: string }[];
  description?: string; start?: string; end?: string; simplify?: 'on'|'off'; format?: 'ledger'|'summary'|'json';
  text?: string; comment?: string; avatar?: string;
  csv?: string; file?: string; me?: string; mapping?: Record<string,string>;
  photos?: string[]; items?: string[]; expenses?: string[];
  from: string; to: string; category?:string; item:string; photo:string; action?:string; mode?: 'equal'|'exact'|'percent'|'shares'|'nights'|'adjustment'|'archive'|'restore'|'delete'; participants?: string[]; values?: string[];
  yes?: boolean; revision?: string; preview?: boolean; settlement?: string; state?: 'handled'|'unhandled'|'pending'|'confirmed'; reset?: boolean;
  pending?: boolean; pendingNote?: string; receiver?: string; note?: string;
  methods?: { platform: string; handle: string; preferred?: boolean }[]; paypal?: string; venmo?: string; mercado?: string; alias?: string;
}
interface Member { id: string; userID: string|null; name: string; removed?: boolean }
interface Group { defaultWeights?:Record<string,number>; tripRates?:Record<string,number>; id: string; name: string; currency: string; members: Member[]; canDelete?: boolean }
type SnapshotEntry = Entry & { editable: boolean; recurrence: string | null; commentCount: number; likeCount: number; likedByMe: boolean };
export type LedgerHandler = (r: Request, env: Env, user: string) => Promise<Response>;
const provider = new CfWorkerJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, provider.getValidator<Args>(tool.inputSchema as JsonSchemaType)]));
// Share multipliers travel as decimals; the ledger stores integer weights where 100 is one share.
function weight(value: number|string) {
  const w = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(w) || w < 1 || w > 100_000) throw new InputError('Use share multipliers between 0.01 and 1000.');
  return w;
}
function shareMap(ids: string[], shares?: number[]) {
  if (!shares) return undefined;
  if (shares.length !== ids.length) throw new InputError('Supply one share per claimant.');
  const weights = Object.fromEntries(ids.map((id, i) => [id, weight(shares[i])]));
  return Object.values(weights).some(w => w !== 100) ? weights : undefined;
}
const multipliers = (shares?: Record<string,number>) => shares ? Object.fromEntries(Object.entries(shares).map(([id, w]) => [id, w / 100])) : undefined;
const clearable = (v?: string) => v === undefined ? undefined : v === 'none' ? null : v;
const nameKey = (s: string) => s.trim().toLowerCase();
const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function minor(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
}
function makeExpense(a: Args, group: Group, old?: Entry): Entry {
  const ids = group.members.map(m => m.id);
  const activeIDs = group.members.filter(m => !m.removed).map(m => m.id);
  const payer = a.payer ?? old?.paidBy;
  let bill: Bill | undefined = old?.bill;
  if (a.bill) {
    if (old?.bill) throw new InputError('Use the item commands to edit an itemized receipt.');
    bill = {
      closed: false,
      tax: a.bill.tax ? minor(a.bill.tax) : 0,
      tip: a.bill.tip ? minor(a.bill.tip) : 0,
      items: a.bill.items.map((i, index) => {
        const memberIDs = i.memberIDs ?? [];
        const shares = shareMap(memberIDs, i.shares);
        return { id: old ? `item-${old.id.slice(0, 65)}-${index + 1}` : crypto.randomUUID(), title: i.title, amount: minor(i.amount), memberIDs, ...(shares ? { shares } : {}) };
      })
    };
  }
  const amount = bill && a.bill
    ? bill.items.reduce((s, i) => s + i.amount, bill.tax + bill.tip)
    : (a.amount === undefined ? old?.amount : minor(a.amount));
  if (!amount) throw new InputError('Enter a positive expense amount.');
  const start = a.spreadStart === 'none' ? null : optionalDay(a.spreadStart, 'spread start');
  const end = a.spreadEnd === 'none' ? null : optionalDay(a.spreadEnd, 'spread end');
  const spreadStart = start ?? old?.spread?.start;
  const spreadEnd = end ?? old?.spread?.end;
  const spread = start === null || end === null ? undefined : spreadStart && spreadEnd
    ? {start: spreadStart, end: spreadEnd} : undefined;
  if ((start || end) && !spread) throw new InputError('Supply both spread dates.');
  let splits = old?.splits;
  const defaults=!old && !bill && !a.mode && !a.values && !a.participants && !a.stays ? group.defaultWeights : undefined;
  const weighted=defaults && Object.keys(defaults).length>0;
  const mode = bill ? 'exact' : ((a.mode as 'equal'|'exact'|'percent'|'shares'|'nights'|undefined) ?? (old?.splits.some(s => s.nights !== undefined) ? 'nights' : old?.splitMode) ?? (a.stays ? 'nights' : weighted ? 'shares' : 'equal'));
  if (a.stays && mode !== 'nights') throw new InputError('Use stay dates with a nights split.');
  if (bill && a.bill) {
    if (!payer) throw new InputError('Choose a payer.');
    if ((a.amount !== undefined && minor(a.amount) !== amount) || (old && a.amount === undefined && old.amount !== amount)) throw new InputError('The amount must match the items, tax and tip.');
    if (a.mode || a.participants || a.values) throw new InputError('Use the bill’s item claimants to split an itemized expense.');
    splits = itemSplit(bill, payer);
  } else if (!old || a.mode || a.participants || a.values || a.stays || amount !== old.amount) {
    const participants = a.participants ?? old?.splits.map(s => s.memberID) ?? (weighted ? activeIDs.filter(id=>defaults[id]>0) : activeIDs);
    if (a.values && a.values.length !== participants.length) throw new InputError('Supply one value per participant.');
    let portions: number[];
    let nights: number[] | undefined;
    let stays: (StayDates | undefined)[] = [];
    if (mode === 'equal') {
      if (a.values) throw new InputError('Equal splits use participants only.');
      portions = allocate(amount, participants.map(() => 1));
    } else {
      let values: number[];
      if (mode === 'nights') {
        const changes = new Map<string, StayDates | undefined>();
        for (const stay of a.stays ?? []) {
          if (!participants.includes(stay.member) || changes.has(stay.member))
            throw new InputError('Choose each participating group member at most once.');
          changes.set(stay.member, stay.start === undefined && stay.end === undefined
            ? undefined : readStay({start: stay.start ?? '', end: stay.end ?? ''}, spread));
        }
        stays = participants.map(id => changes.has(id) ? changes.get(id) : old?.splits.find(s => s.memberID === id)?.stay);
        nights = participants.map((id, index) => {
          const stay = stays[index];
          if (stay) return spreadLength(readStay(stay, spread));
          const input = a.values?.[index] ?? String(old?.splits.find(s => s.memberID === id)?.nights ?? '');
          if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > 366)
            throw new InputError('Supply dates or a whole night count from 1 through 366 for each participant.');
          return Number(input);
        });
        values = nights;
      } else {
        const inputs = a.values ?? (weighted ? participants.map(id=>String(defaults[id])) : undefined);
        if (!inputs) throw new InputError('Supply one allocation value per participant.');
        values = inputs.map(minor);
      }
      if (mode === 'percent' && values.reduce((n,v) => n+v,0) !== 10000) throw new InputError('Percentages must sum to 100.');
      portions = mode === 'exact' ? values : allocate(amount, values);
    }
    splits = participants.map((memberID,i) => ({ memberID, amount: portions[i], ...(nights ? { nights: nights[i] } : {}), ...(stays[i] ? {stay: stays[i]} : {}) }));
  }
  const date = optionalDay(a.date, 'expense date');
  const createdAt = old?.createdAt ?? (date ? date + 'T12:00:00Z' : timestamp());
  const currency = a.currency ?? old?.currency ?? group.currency;
  const previous = currency === old?.currency ? old.exchange : undefined;
  const clearing = a.chargedAmount === 'none';
  if (clearing && !old) throw new InputError('Use "none" only when editing an expense.');
  const charged = clearing ? undefined : a.chargedAmount === undefined ? previous?.statementAmount : minor(a.chargedAmount);
  const target = previous?.target ?? group.currency;
  if (charged !== undefined && currency === target) throw new InputError('A charged amount override requires a foreign expense.');
  const tripRate = currency !== group.currency && target === group.currency ? group.tripRates?.[currency] : undefined;
  const useTripRate = (!previous && (!old || charged !== undefined || currency !== old.currency))
    || (clearing && previous?.source === 'Statement');
  const rate = a.rate ? parseRate(a.rate) : useTripRate ? tripRate : undefined;
  if (a.rate && !rate) throw new InputError('Enter a positive exchange rate.');
  const day = createdAt.slice(0,10);
  let exchange: Exchange | undefined = rate ? {target,rateE8:rate,source:a.rate ? 'Manual' : 'Trip',date:day} : previous && {...previous};
  if (!exchange && charged !== undefined) {
    const implied = impliedRate(amount, charged);
    if (!implied) throw new InputError('Check the amount charged on your statement.');
    exchange = {target,rateE8:implied,date:day,source:'Statement'};
  }
  if (old?.exchange && currency !== old.currency && currency !== group.currency && !exchange)
    throw new InputError('Supply a new rate when changing a converted currency.');
  if (exchange) {
    if (clearing && exchange.source === 'Statement') exchange.source = 'Manual';
    exchange.statementAmount = charged;
  }
  let payers=old?.payers?.length ? (amount===old.amount ? old.payers
    : allocate(amount,old.payers.map(p=>p.amount)).map((value,i)=>({memberID:old.payers![i].memberID,amount:value}))) : undefined;
  if (a.payers) {
    payers = a.payers.map(p => ({ memberID: p.member, amount: minor(p.amount) }));
    if (payers.reduce((n, p) => n + p.amount, 0) !== amount) throw new InputError('The payer amounts must match the total exactly.');
    if (payers.length === 1) payers = undefined;
  }
  return validateEntry({ id: old?.id ?? crypto.randomUUID(), groupID: group.id, title: a.title ?? old?.title,
    amount, currency, paidBy: a.payers && !a.payer ? a.payers[0].member : payer,
    exchange, bill, spread, category:a.category??old?.category, splits, kind: 'expense', splitMode: mode, createdAt,
    payers, notes: a.notes ?? old?.notes, handled: old?.handled,
    ...pendingFields(a, old) }, ids,old?.bill,{reconcileBill:true});
}
async function dailyEntriesInCurrency(entries: Entry[], currency: string): Promise<Entry[]> {
  const today = timestamp().slice(0, 10);
  const cache = new FxCache({ get: () => null, set: () => {} }, Date.now,
    url => fetch(url, {signal: AbortSignal.timeout(5000)}));
  const sources = entries.map(entry => entry.exchange?.statementAmount === undefined ? entry : settlementEntry(entry));
  const pairs = new Map<string, {base: string; date: string}>();
  const key = (entry: Entry) => entry.currency + ':' + entry.createdAt.slice(0, 10);
  for (const entry of sources) {
    if (entry.currency !== currency && entry.exchange?.target !== currency)
      pairs.set(key(entry), {base: entry.currency, date: entry.createdAt.slice(0, 10)});
  }
  if (pairs.size > 50) throw new InputError('Too many exchange rates for this report. Choose a member or use original currencies.');
  const rates = new Map<string, number>();
  const quotes = [...pairs];
  for (let i = 0; i < quotes.length; i += 8) {
    await Promise.all(quotes.slice(i, i + 8).map(async ([id, {base, date}]) => {
      try {
        rates.set(id, (await cache.forDate(base, currency, date, today)).rateE8);
      } catch {
        throw new InputError('An exchange rate is unavailable. Try again or use original currencies.');
      }
    }));
  }
  return sources.map(entry => {
    if (entry.currency === currency) return entry;
    if (entry.exchange?.target === currency) return settlementEntry(entry);
    const amount = convert(entry.amount, rates.get(key(entry))!);
    const shares = amount === 0 ? entry.splits.map(() => 0)
      : allocate(amount, entry.splits.map(s => s.amount), Number.MAX_SAFE_INTEGER);
    return {...entry, amount, currency, splits: entry.splits.map((s, i) => ({...s, amount: shares[i]}))};
  });
}
function pendingFields(a: Args, old?: Entry) {
  const pending = a.pending ?? old?.pending;
  return pending ? { pending: true, pendingNote: a.pendingNote ?? old?.pendingNote } : {};
}
function makeRefund(a: Args, group: Group, entries: Entry[], original?: Entry, id = crypto.randomUUID(), refundItems?: string[]): Entry {
  if (a.items) {
    if (!original) throw new InputError('Choose the itemized expense whose items were refunded.');
    if (a.amount || a.participants || a.values) throw new InputError('An item refund credits each person for their items. Omit amount, participants and values.');
    const exact = itemRefund(original, a.items);
    const receiver = a.receiver ?? original.paidBy;
    const names = a.items.map(id => original.bill!.items.find(i => i.id === id)!.title).join(', ');
    return makeRefund({ ...a, items: undefined, amount: (exact.amount / 100).toFixed(2), participants: exact.splits.map(s => s.memberID),
      values: exact.splits.map(s => (s.amount / 100).toFixed(2)), title: a.title ?? ('Refund: ' + names).slice(0, 120), receiver }, group, entries, original, id, a.items);
  }
  if (!a.amount) throw new InputError('Enter a positive refund amount, or choose items to refund.');
  const amount = minor(a.amount!);
  if (!amount) throw new InputError('Enter a positive refund amount.');
  const receiver = a.receiver ?? original?.paidBy;
  if (!receiver) throw new InputError('Choose who received the money or is giving the credit.');
  const room = original ? refundRoom(original, refundsOf(entries, original.id)).members : undefined;
  const left = room ? new Map(Object.entries(room)) : undefined;
  const participants = a.participants ?? (left ? [...left].filter(([, n]) => n > 0).map(([m]) => m)
    : group.members.filter(m => !m.removed && m.id !== receiver).map(m => m.id));
  if (!participants.length) throw new InputError(original ? 'This expense has been fully refunded.' : 'Choose who gets the credit.');
  if (a.values && a.values.length !== participants.length) throw new InputError('Supply one value per participant.');
  const weights = participants.map(m => left ? Math.max(left.get(m) ?? 0, 0) : 1);
  const portions = a.values ? a.values.map(minor) : allocate(amount, weights.some(w => w > 0) ? weights : participants.map(() => 1));
  const date = optionalDay(a.date, 'refund date');
  const createdAt = date ? date + 'T12:00:00Z' : timestamp();
  const x = original?.exchange;
  const exchange = x ? { target: x.target, rateE8: x.rateE8, date: x.date <= createdAt.slice(0,10) ? x.date : createdAt.slice(0,10),
    source: x.source === 'Statement' ? 'Manual' as const : x.source } : undefined;
  return validateEntry({ id, groupID: group.id, kind: 'refund', title: a.title ?? (original ? 'Refund: ' + original.title : 'Credit').slice(0, 120),
    amount, currency: original?.currency ?? group.currency, paidBy: receiver, splitMode: a.values ? 'exact' : 'shares',
    splits: participants.map((memberID, i) => ({ memberID, amount: portions[i] })), createdAt,
    ...(original ? { refundOf: original.id } : {}), ...(refundItems ? { refundItems } : {}), ...(exchange ? { exchange } : {}), ...(original?.category ? { category: original.category } : {}),
    ...(a.notes ? { notes: a.notes } : {}), ...pendingFields(a) }, group.members.map(m => m.id));
}

function base64(bytes:Uint8Array) {
  let raw='';
  for(const byte of bytes) raw+=String.fromCharCode(byte);
  return btoa(raw);
}
export async function operate(name: string, input: unknown, env: Env, user: string, handle: LedgerHandler) {
  const validate = validators.get(name);
  if (!validate) throw new HTTPError(404, 'Unknown Split command.');
  const checked = validate(input);
  if (!checked.valid) throw new InputError(checked.errorMessage);
  const a = checked.data;
  async function ledger<T>(path: string, data?: unknown): Promise<T> {
    const req = new Request(env.APP_URL + path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return (await handle(req, env, user)).json<T>();
  }
  async function importPlan(a: Args, parsed: SplitwiseGroup, people: { name: string; me?: boolean; memberID?: string }[],
    currencies: Record<string, number>, currency: string) {
    const days = parsed.rows.map(r => r.day).sort();
    const base = {
      preview: true, group: parsed.name, members: parsed.members, rows: parsed.rows.length, skipped: parsed.skipped,
      expenses: parsed.rows.filter(r => !r.payment).length, payments: parsed.rows.filter(r => r.payment).length,
      currencies, dates: days.length ? { from: days[0], to: days[days.length - 1] } : undefined
    };
    let target: { id: string; name: string; currency: string; members: Member[] } | undefined;
    if (a.group) {
      const snap = await ledger<{ groups: Group[] }>('/v1/snapshot');
      target = snap.groups.find(g => g.id === a.group);
      if (!target) throw new HTTPError(404, 'Group not found.');
    }
    const roster = target?.members ?? [];
    const mine = roster.find(m => m.userID === user);
    for (const p of people) if (p.memberID && !roster.some(m => m.id === p.memberID))
      throw new InputError(target ? 'Map ' + p.name + ' to a member ID from members list for ' + target.name + '.' : 'Mapping needs an existing group. Add group, or omit mapping to create placeholders.');
    if (!a.me) return { ...base, target: target ? { id: target.id, name: target.name } : 'new group',
      next: 'Tell Split which name is you: run this again with me set to one of ' + parsed.members.join(', ') + '.' };
    // Suggestions are exact, unique name matches against members nobody else maps to. They are never applied for you.
    const taken = new Set(people.flatMap(p => p.memberID ? [p.memberID] : []));
    const suggestions: Record<string, string> = {}, ambiguous: Record<string, string[]> = {};
    for (const p of people) {
      if (p.me || p.memberID || !target) continue;
      const matches = roster.filter(m => !m.removed && m.id !== mine?.id && !taken.has(m.id) && nameKey(m.name) === nameKey(p.name));
      if (matches.length === 1) suggestions[p.name] = matches[0].id;
      else if (matches.length > 1) ambiguous[p.name] = matches.map(m => m.id);
    }
    const nameOf = (id: string) => roster.find(m => m.id === id)?.name ?? id;
    const plan = people.map(p => p.me ? { name: p.name, becomes: target ? 'you (' + (mine?.name ?? 'your seat') + ')' : 'you' }
      : p.memberID ? { name: p.name, becomes: 'existing member ' + nameOf(p.memberID), memberID: p.memberID }
      : { name: p.name, becomes: 'new placeholder' + (suggestions[p.name] ? ' (possible match: ' + nameOf(suggestions[p.name]) + ')' : ambiguous[p.name] ? ' (several members share this name)' : '') });
    const mismatch = target && Object.keys(currencies).some(c => c !== target!.currency);
    return { ...base, target: target ? { id: target.id, name: target.name } : { name: (a.name ?? parsed.name).slice(0, 80), kind: a.kind ?? 'trip', currency },
      people: plan,
      ...(Object.keys(suggestions).length ? { suggestedMapping: { ...a.mapping, ...suggestions } } : {}),
      ...(Object.keys(ambiguous).length ? { ambiguous } : {}),
      ...(mismatch ? { note: 'Some entries are not in ' + target!.currency + '. They keep their own currency.' } : {}),
      next: 'Nothing is saved yet. To import, run the same request without preview.' +
        (Object.keys(suggestions).length ? ' To link possible matches instead of creating placeholders, pass suggestedMapping as mapping.' : '') };
  }
  if (name === 'groups_create') {
    const groupID = crypto.randomUUID();
    const members = [a.self, ...(a.placeholders ?? [])].map((label,i) => ({
      id: crypto.randomUUID(), groupID, name: label, userID: i === 0 ? user : null
    }));
    await ledger('/v1/groups', { id: groupID, name: a.name, kind: a.kind ?? 'trip', currency: a.currency ?? 'USD', members,
      description: clearable(a.description) ?? undefined, startDate: clearable(a.start) ?? undefined, endDate: clearable(a.end) ?? undefined });
    return { id: groupID, members };
  }
  if (name === 'join') {
    let token = a.invite;
    if (token.includes('/')) {
      let url;
      try { url = new URL(token); } catch { throw new InputError('Enter a Split invitation link.'); }
      if (url.origin !== new URL(env.APP_URL).origin || !/^\/join\/[^/]+$/.test(url.pathname)) throw new InputError('Enter a link from this Split server.');
      token = url.pathname.slice(6);
    }
    return ledger('/v1/join', { token });
  }
  if (name === 'profile_avatar') return ledger('/v1/profile/avatar', { avatarURL: a.avatar === 'none' ? null : a.avatar });
  if (name === 'import_splitwise') {
    let parsed;
    try { parsed = await parseSplitwise(a.csv!, a.file ?? 'splitwise.csv'); } catch (e) { throw new InputError(e instanceof Error ? e.message : 'Could not read this Splitwise file.'); }
    const names = parsed.members;
    if (a.me && !names.includes(a.me)) throw new InputError('Choose your name from: ' + names.join(', ') + '.');
    for (const n of Object.keys(a.mapping ?? {})) if (!names.includes(n)) throw new InputError(n + ' is not in this file.');
    // The plan and the import share this list, so the preview shows exactly what will be saved.
    const people = names.map(n => n === a.me ? { name: n, me: true } : a.mapping?.[n] ? { name: n, memberID: a.mapping[n] } : { name: n });
    const counts = new Map<string, number>();
    for (const r of parsed.rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
    const currency = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'USD';
    // Released clients import as soon as they name themselves or a group; keep that, and plan on request.
    if (a.preview || (!a.me && !a.group)) return importPlan(a, parsed, people, Object.fromEntries(counts), currency);
    const body = a.group ? { groupID: a.group, people, rows: parsed.rows }
      : { group: { id: await importGroupID(parsed.fingerprint, user), name: (a.name ?? parsed.name).slice(0, 80), kind: a.kind ?? 'trip', currency }, people, rows: parsed.rows };
    return ledger('/v1/import/splitwise', body);
  }
  if (name === 'members_known') return ledger('/v1/people/known');
  if (name === 'friends_shared') return ledger('/v1/people/shared');
  if (name === 'friends_list') return ledger('/v1/friends');
  if (name === 'friends_request') return ledger('/v1/friends/requests', { email: a.email, userID: a.user });
  if (name === 'friends_remove') return ledger('/v1/friends/' + encodeURIComponent(a.user!) + '/remove', {});
  if (name === 'invitations_list') return ledger('/v1/invitations');
  if (name === 'invitations_accept' || name === 'invitations_decline')
    return ledger(`/v1/invitations/${a.invitation}/${name === 'invitations_accept' ? 'accept' : 'decline'}`, {});
  if (name === 'profile_discoverable') return a.discoverable === undefined
    ? ledger('/v1/profile/discoverable') : ledger('/v1/profile/discoverable', { discoverable: a.discoverable === 'on' });
  if (name === 'groups_list') {
    return (await env.DB.prepare(`SELECT g.id,g.name,g.kind,g.currency,g.created_at AS createdAt FROM groups g
      JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC`).bind(user).all()).results;
  }
  const snapshot = await ledger<{groups: Group[]; entries: SnapshotEntry[]; settlementRequests?: Entry[]; paymentMethods?: unknown[]}>('/v1/snapshot');
  if (name === 'profile_payment') {
    if (a.methods === undefined) return { methods: snapshot.paymentMethods ?? [] };
    await ledger('/v1/profile/payment-methods', { methods: a.methods });
    return { methods: a.methods };
  }
  if (name === 'activity') {
    if (a.group && !snapshot.groups.some(g => g.id === a.group)) throw new HTTPError(404, 'Group not found.');
    const pending = (snapshot.settlementRequests ?? []).map(e => ({...e, status:'pending'}));
    return [...snapshot.entries, ...pending].filter(e => !a.group || e.groupID === a.group)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  const group = snapshot.groups.find(g => g.id === a.group);
  if (!group) throw new HTTPError(404, 'Group not found.');
  const { members } = group;
  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? id;
  const expenseDetails = (entry: Entry) => ({
    date: new Date(entry.createdAt).toISOString().slice(0,10),
    payerNames: entryPayers(entry).map(p => ({...p, name: nameOf(p.memberID)})),
    ...(entry.splits.some(s => s.nights !== undefined) ? {splitMode: 'nights', nightRate: nightRate(entry)} : {}),
    ...(entry.exchange ? { settlementAmount: settlementEntry(entry).amount } : {})
  });
  if(name==='groups_default_split') {
    if(a.weights.length!==a.participants?.length) throw new InputError('Supply one weight per member.');
    return ledger('/v1/groups/'+group.id+'/default-split',{weights:Object.fromEntries(a.participants.map((id,i)=>[id,a.weights[i]]))});
  }
  if(name==='members_payment') {
    if(a.reset && (a.methods || a.paypal || a.venmo || a.mercado || a.alias)) throw new InputError('Use reset on its own to go back to your account payment methods.');
    return ledger('/v1/groups/'+group.id+'/payment-profile',a.reset ? {methods:null} : a);
  }
  if(name==='groups_rate') {
    let rateE8: number|null = null;
    if(a.rate!=='none') {
      const [whole, fraction=''] = a.rate!.split('.');
      rateE8 = Number(whole)*1e8 + Number(fraction.padEnd(8,'0'));
    }
    await ledger('/v1/groups/'+group.id+'/trip-rate',{currency:a.currency,target:group.currency,rateE8});
    return { group: group.id, currency: a.currency, target: group.currency, rate: rateE8 === null ? null : a.rate };
  }
  if(name==='expenses_handled') {
    const e = snapshot.entries.find(x => x.groupID === group.id && x.id === a.expense);
    if(!e) throw new HTTPError(404,'Expense not found.');
    const handled = a.state !== 'unhandled';
    await ledger('/v1/entries/'+e.id+'/handled',{handled});
    return { id: e.id, handled };
  }
  if(name==='expenses_pending') {
    const e = snapshot.entries.find(x => x.groupID === group.id && x.id === a.expense);
    if(!e) throw new HTTPError(404,'Expense not found.');
    const pending = a.state !== 'confirmed';
    await ledger('/v1/entries/'+e.id+'/pending',{pending,...(a.note!==undefined?{note:a.note}:{})});
    return { id: e.id, pending, ...(pending && (a.note ?? e.pendingNote) ? { note: a.note ?? e.pendingNote } : {}) };
  }
  if(name==='expenses_resolve' || name==='refunds_add') {
    const groupEntries = snapshot.entries.filter(x => x.groupID === group.id);
    const original = a.expense ? groupEntries.find(x => x.id === a.expense) : undefined;
    if(a.expense && (!original || original.kind !== 'expense')) throw new HTTPError(404,'Expense not found.');
    if(name==='refunds_add') {
      const refund = makeRefund(a, group, groupEntries, original);
      await ledger('/v1/entries', refund);
      return { ...refund, receiverName: nameOf(refund.paidBy), credits: refund.splits.map(s => ({ ...s, name: nameOf(s.memberID) })) };
    }
    if(!original!.pending && a.action !== 'confirm') throw new InputError('This expense is not pending. Use refunds add or expenses edit.');
    if(a.action==='confirm') { await ledger('/v1/entries/'+original!.id+'/resolve',{action:'confirm'}); return { id: original!.id, pending: false }; }
    if(!a.amount) throw new InputError(a.action==='adjust' ? 'Enter the new total.' : 'Enter the refunded amount.');
    if(a.action==='adjust') {
      const result = await ledger<{amount:number}>('/v1/entries/'+original!.id+'/resolve',{action:'adjust',amount:minor(a.amount)});
      return { id: original!.id, pending: false, amount: result.amount };
    }
    const refund = makeRefund(a, group, groupEntries, original);
    await ledger('/v1/entries/'+original!.id+'/resolve',{action:'refund',refund});
    return { id: original!.id, pending: false, refund: { ...refund, receiverName: nameOf(refund.paidBy) } };
  }
  if (name === 'expenses_combine') {
    const mode = a.mode ?? 'equal';
    const participants = a.participants ?? members.filter(m => !m.removed).map(m => m.id);
    if (mode === 'equal' ? a.values !== undefined : a.values?.length !== participants.length)
      throw new InputError('Supply one value per participant for a custom split.');
    const values = a.values?.map(value => {
      if (mode !== 'adjustment' && /^[+-]/.test(value)) throw new InputError('Use unsigned values for this split mode.');
      return value.startsWith('-') ? -minor(value.slice(1)) : minor(value.replace(/^\+/, ''));
    });
    if (a.yes && !a.revision) throw new InputError('Review a combine preview and supply its revision before confirming.');
    const result = await ledger<{expense: Entry}>('/v1/groups/'+group.id+'/combine', {
      preview: !a.yes, revision: a.yes ? a.revision : undefined,
      entryIDs:a.expenses, title:a.title, splitMode:mode,
      parts:participants.map((memberID, index) => ({memberID, amount:values?.[index] ?? 1})),
    });
    return { ...result, payerNames: entryPayers(result.expense).map(p => ({...p, name:nameOf(p.memberID)})),
      splitNames: result.expense.splits.map(p => ({...p, name:nameOf(p.memberID)})) };
  }
  if (name === 'expenses_uncombine') {
    if (!snapshot.entries.some(e => e.id === a.expense && e.groupID === group.id && e.combinedCount))
      throw new HTTPError(404, 'Combined expense not found.');
    return ledger('/v1/entries/'+a.expense+'/uncombine', {});
  }
  if (name === 'expenses_suggestions') return ledger('/v1/groups/'+group.id+'/combine-suggestions');
  if (name === 'expenses_combination_activity') return ledger('/v1/groups/'+group.id+'/combine-activity');
  if(name==='expenses_repeat') return ledger('/v1/groups/'+group.id+'/repeat',{entryID:a.expense,cadence:a.cadence});
  if (name === 'groups_show') return group;
  if (name === 'groups_update') return ledger('/v1/groups/'+group.id+'/update', {
    name: a.name, description: clearable(a.description), startDate: clearable(a.start), endDate: clearable(a.end),
    simplify: a.simplify === undefined ? undefined : a.simplify === 'on', currency: a.currency });
  if (name === 'groups_archive') return ledger('/v1/groups/'+group.id+'/archive', { archived: a.action !== 'restore' });
  if (name === 'groups_delete') {
    // Preview and confirm with the same creator rule the delete route enforces.
    if (!group.canDelete) throw new HTTPError(403, 'Only the active group creator can delete this group.');
    const history = snapshot.entries.filter(e => e.groupID === group.id)
      .map(e => { const { likeCount, likedByMe, commentCount, ...rest } = e as Entry & { editable: boolean; likeCount?: number; likedByMe?: boolean; commentCount?: number }; return rest; });
    const revision = await fingerprint(['groups_delete', group, history]);
    const preview = { preview: true, action: 'Delete ' + group.name + ' and its history for every member. This cannot be undone.',
      group: group.id, name: group.name, members: members.filter(m => !m.removed).map(m => m.name),
      expenses: history.filter(e => e.kind === 'expense').length, settlements: history.filter(e => e.kind === 'settlement').length,
      receipts: history.reduce((n, e) => n + (e.receiptIDs?.length ?? 0), 0), revision,
      next: 'Export the group first if you want a copy. Confirm with yes and this revision.' };
    if (!a.yes) return preview;
    if (a.revision !== revision) throw new HTTPError(409, 'This group changed or the preview is missing. Review a fresh preview before deleting.');
    await deleteGroup(env, group.id, user, { name: group.name, members: members.filter(m => !m.removed).map(m => ({ id: m.id, name: m.name })),
      expenses: preview.expenses, settlements: preview.settlements, receipts: preview.receipts });
    return { deleted: true, id: group.id, name: group.name };
  }
  if (name === 'settlements_pending' || name === 'settlements_respond') {
    const seat = members.find(m => m.userID === user)?.id;
    const pending = (snapshot.settlementRequests ?? []).filter(e => e.groupID === group.id).map(e => ({
      id: e.id, amount: e.amount, currency: e.currency, createdAt: e.createdAt,
      from: { id: e.paidBy, name: nameOf(e.paidBy) }, to: { id: e.splits[0]?.memberID, name: nameOf(e.splits[0]?.memberID) },
      youAre: e.paidBy === seat ? 'payer' : 'recipient', canDo: e.paidBy === seat ? ['cancel'] : ['approve', 'decline']
    }));
    if (name === 'settlements_pending') return pending;
    const request = pending.find(p => p.id === a.settlement);
    if (!request) throw new HTTPError(404, 'Pending payment not found. Run settlements pending.');
    if (!request.canDo.includes(a.action!)) throw new InputError(request.youAre === 'payer' ? 'You made this payment. You can cancel it.' : 'Approve or decline this payment.');
    return ledger('/v1/settlements/' + request.id + '/' + a.action, {});
  }
  if (name === 'groups_leave') {
    if (!a.yes) return { preview: true, action: 'Leave ' + group.name, deletesGroup: members.filter(m => m.userID).length <= 1 };
    return ledger('/v1/groups/'+group.id+'/leave', {});
  }
  if (name === 'members_remove') return ledger('/v1/groups/'+group.id+'/members/'+a.member+'/remove', { mode: a.mode ?? 'archive' });
  if (name === 'members_update') return ledger(`/v1/groups/${group.id}/members/${a.member}/email`, { email: clearable(a.email) });
  if (name === 'invites_list') return ledger('/v1/groups/'+group.id+'/invites');
  if (name === 'invites_revoke') return ledger('/v1/groups/'+group.id+'/invites/'+a.invite+'/revoke', {});
  if (name === 'members_list') return members;
  if (name === 'members_add') {
    return ledger(`/v1/groups/${group.id}/members`, {
      id: crypto.randomUUID(), name: a.name, userID: a.user, email: a.email, phone: a.phone
    });
  }
  if (name === 'members_link') return ledger(`/v1/groups/${group.id}/members/${a.member}/link`, { userID: a.user });
  if (name === 'members_links') return ledger(`/v1/groups/${group.id}/member-links`);
  if (name === 'members_invite') return ledger(`/v1/groups/${group.id}/invites/direct`, { userID: a.user, memberID: a.member });
  if (name === 'invite') return ledger(`/v1/groups/${group.id}/invites`, { memberID: a.member, name: a.name, email: a.email });
  if (name === 'expenses_add' || name === 'settle_up') {
    const entry = name === 'expenses_add' ? makeExpense(a,group) : validateEntry({
      id: crypto.randomUUID(), groupID: group.id, title: 'Settlement', amount: minor(a.amount!), currency: a.currency ?? group.currency,
      paidBy: a.from, splits: [{ memberID: a.to, amount: minor(a.amount!) }], kind: 'settlement', splitMode: 'exact', createdAt: timestamp()
    }, members.map(m => m.id));
    const photos = name === 'expenses_add' && a.photos?.length
      ? a.photos.map(data => ({ id: crypto.randomUUID(), data }))
      : undefined;
    const result = await ledger<{status?: string}>(name === 'settle_up' ? '/v1/settlements' : '/v1/entries', photos ? { ...entry, photos } : entry);
    if (name === 'settle_up') {
      const pending = snapshot.entries.filter(e => e.groupID === group.id && e.pending && (e.exchange?.target ?? e.currency) === entry.currency);
      return { ...entry, status: result.status, ...(pending.length ? { warning: `${pending.length} pending ${pending.length === 1 ? 'entry' : 'entries'} in ${entry.currency} may still change. Balances include them.` } : {}) };
    }
    const warning = !entry.exchange && entry.currency !== group.currency
      ? `Saved in ${entry.currency} with a separate balance. Use --rate to convert to ${group.currency}.`
      : undefined;
    return { ...entry, exchange: entry.exchange ?? null, ...expenseDetails(entry), warning,
      ...(photos ? { receiptIDs: photos.map(p => p.id) } : {}) };
  }
  if (name === 'expenses_edit' || name === 'expenses_delete') {
    const before = snapshot.entries.find(e => e.groupID === group.id && e.id === a.expense && e.editable);
    if (!before) throw new HTTPError(404,'Your expense was not found.');
    if (before.kind === 'settlement' || (before.kind === 'refund' && name === 'expenses_edit')) throw new InputError(before.kind === 'refund' ? 'Delete the refund and record it again to change it.' : 'Select an expense.');
    const after = name === 'expenses_edit' ? makeExpense(a, group, before) : null;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name,before,after])));
    const revision = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
    if (!a.yes) {
      // These fields are stored outside the editable entry payload.
      const { receiptIDs, recurrence, editable, commentCount, likeCount, likedByMe } = before;
      return { preview: true, before,
        after: after && { ...after, receiptIDs, recurrence, editable, commentCount, likeCount, likedByMe }, revision };
    }
    if (a.revision !== revision) throw new HTTPError(409,'Review a fresh preview before confirming.');
    const action = after ? 'edit' : 'delete';
    await ledger(`/v1/entries/${before.id}/${action}`, { original: before, entry: after });
    return { applied: true, id: a.expense, category: after?.category };
  }
  const entries = snapshot.entries.filter(e => e.groupID === group.id);
  if (name === 'groups_export') {
    const comments = a.format === 'json' ? Object.fromEntries(await Promise.all(entries.filter(e => (e as {commentCount?:number}).commentCount)
      .map(async e => [e.id, (await ledger<{comments:unknown[]}>('/v1/entries/'+e.id+'/comments')).comments]))) : {};
    return exportGroup(group, entries, a.format ?? 'ledger', comments);
  }
  if (['expenses_show','expenses_like','comments_list','comments_add','comments_delete','receipts_add'].includes(name)) {
    let e = entries.find(e => e.id === a.expense);
    if (!e && name === 'expenses_show') {
      const matches = entries.filter(entry => entry.kind === 'expense' && entry.id.startsWith(a.expense));
      if (matches.length > 1) throw new InputError('This expense ID prefix matches multiple expenses. Use a longer prefix or the full ID.');
      [e] = matches;
    }
    if (!e) throw new HTTPError(404, 'Expense not found.');
    const path = '/v1/entries/' + e.id;
    if (name === 'expenses_show') {
      return { ...e, ...expenseDetails(e),
        splitNames: e.splits.map(p => ({ ...p, name: nameOf(p.memberID) })),
        items: entryItems(e).map(i => ({ id: i.id, title: i.title, gross: i.gross, members: i.portions.filter(p => !i.open).map(p => nameOf(p.memberID)), shares: multipliers(e.bill?.items.find(item => item.id === i.id)?.shares), open: i.open, portions: i.portions })),
        comments: (await ledger<{comments:unknown[]}>(path + '/comments')).comments };
    }
    if (name === 'expenses_like') return ledger(path + '/like', {});
    if (name === 'comments_list') return (await ledger<{comments:unknown[]}>(path + '/comments')).comments;
    if (name === 'comments_add') return ledger(path + '/comments', { body: a.text });
    if (name === 'comments_delete') return ledger(path + '/comments/' + a.comment, {});
    const before = entries.find(x => x.id === e.id && x.editable);
    if (!before) throw new HTTPError(403, 'Only the person who recorded this expense can attach photos.');
    if ((before.receiptIDs?.length ?? 0) + a.photos!.length > 4) throw new InputError('An expense can hold up to four receipt photos.');
    const photos = a.photos!.map(data => ({ id: crypto.randomUUID(), data }));
    await ledger(path + '/edit', { original: before, entry: before, photos });
    return { attached: photos.map(p => p.id) };
  }
  if (name === 'groups_daily') {
    if (a.member && !members.some(m => m.id === a.member)) throw new InputError('Choose a group member.');
    const people = members.filter(m => !a.member || m.id === a.member);
    const selected = entries.filter(e => e.kind !== 'settlement' && (!a.member || e.splits.some(s => s.memberID === a.member)));
    const report = a.currency ? await dailyEntriesInCurrency(selected, a.currency) : selected;
    return people.map(m => ({memberID: m.id, name: m.name, ...(a.currency ? {convertedTo: a.currency} : {}),
      days: dailyCosts(report, m.id)}));
  }
  if(name==='groups_breakdown') {
    if(a.member && !members.some(m=>m.id===a.member)) throw new InputError('Choose a group member.');
    return [...new Set([group.currency,...entries.map(e=>e.exchange?.target??e.currency)])].map(currency=>{
      const report=breakdown(entries.map(settlementEntry),members,currency);
      return a.member ? {...report,members:report.members.filter(m=>m.id===a.member),expenses:entries.filter(e=>(e.exchange?.target??e.currency)===currency && e.kind==='expense' && (e.paidBy===a.member || e.splits.some(s=>s.memberID===a.member)))} : report;
    });
  }
  if(name==='receipts_inbox') return (await ledger<{receipts:{uploadedBy:string}[]}>('/v1/groups/'+group.id+'/receipts')).receipts
    .map(r=>({...r,uploadedByName:nameOf(r.uploadedBy)}));
  if(name==='receipts_upload') {
    const uploaded:string[]=[];
    for(const data of a.photos!) {
      const id=crypto.randomUUID();
      await ledger('/v1/groups/'+group.id+'/receipts',{id,data,...(a.note?{note:a.note}:{})});
      uploaded.push(id);
    }
    return {uploaded};
  }
  if(name==='receipts_pair') return ledger('/v1/groups/'+group.id+'/receipts/'+a.photo+'/pair',{entryID:a.expense});
  if(name==='receipts_delete') return ledger('/v1/groups/'+group.id+'/receipts/'+a.photo+'/delete',{});
  if(name==='receipts_get' && !a.expense) {
    const res=await handle(new Request(env.APP_URL+'/v1/groups/'+group.id+'/receipts/'+a.photo),env,user);
    return {mimeType:'image/jpeg',data:base64(new Uint8Array(await res.arrayBuffer()))};
  }
  if(name==='items_report') {
    if(a.member && !members.some(m=>m.id===a.member)) throw new InputError('Choose a group member.');
    return [...new Set([group.currency,...entries.map(e=>e.exchange?.statementAmount===undefined ? e.currency : e.exchange.target)])].map(currency=>consumptionReport(entries,currency)).filter(r=>r.people.length)
      .map(r=>({...r,people:r.people.filter(p=>!a.member || p.memberID===a.member).map(p=>({...p,name:nameOf(p.memberID),
        lines:p.lines.map(l=>({...l,expenseTitle:entries.find(e=>e.id===l.entryID)?.title}))}))}));
  }
  if(name==='items_open') return entries.filter(e=>e.bill).flatMap(e=>grossItems(e.bill!).filter(i=>!i.memberIDs.length).map(i=>({expense:e.id,expenseTitle:e.title,currency:e.currency,...i})));
  if(name.startsWith('receipts_') || name.startsWith('items_')) {
    const e=entries.find(e=>e.id===a.expense);
    if(!e) throw new HTTPError(404,'Expense not found.');
    const path='/v1/entries/'+e.id;
    if(name==='receipts_list') return e.receiptIDs??[];
    if(name==='items_list') {
      return {expense:e.id,title:e.title,currency:e.currency,payer:e.paidBy,closed:e.bill?.closed ?? true,tax:e.bill?.tax ?? 0,tip:e.bill?.tip ?? 0,receiptIDs:e.receiptIDs??[],
        items:entryItems(e).map(i=>({id:i.id,title:i.title,amount:i.amount,gross:i.gross,memberIDs:i.open ? [] : i.portions.map(p=>p.memberID),shares:multipliers(e.bill?.items.find(item=>item.id===i.id)?.shares),open:i.open,portions:i.portions}))};
    }
    if(name==='receipts_get') {
      const res=await handle(new Request(env.APP_URL+path+'/receipts/'+a.photo),env,user);
      return {mimeType:'image/jpeg',data:base64(new Uint8Array(await res.arrayBuffer()))};
    }
    if(name==='receipts_move') return ledger(path+'/receipts/'+a.photo+'/move',{entryID:a.to==='inbox' ? null : a.to});
    if(name==='items_close') return ledger(path+'/close',{memberIDs:a.participants??members.filter(m=>!m.removed).map(m=>m.id)});
    const item=e.bill?.items.find(i=>i.id===a.item);
    if(!item) throw new HTTPError(404,'Item not found.');
    if(name==='items_assign') {
      const ids=a.participants ?? [];
      const shares=shareMap(ids,a.shares);
      const reset=Object.fromEntries(ids.map(id=>[id,100]));
      return ledger(path+'/claim',{itemID:item.id,original:item.memberIDs,memberIDs:ids,shares:shares??reset});
    }
    const claimant=a.member??members.find(m=>m.userID===user)!.id;
    const ids=a.action==='remove' ? item.memberIDs.filter(id=>id!==claimant) : [...new Set([...item.memberIDs,claimant])];
    if(a.action==='remove' && a.share!==undefined) throw new InputError('Shares apply when adding a claimant.');
    const shares=a.action!=='remove' && a.share!==undefined ? {[claimant]:weight(a.share)} : undefined;
    return ledger(path+'/claim',{itemID:item.id,original:item.memberIDs,memberIDs:ids,mergeEdits:true,...(shares?{shares}:{})});
  }
  if (name === 'expenses_list') {
    const expenses = entries.filter(e => e.kind === 'expense' || e.kind === 'refund');
    const prefixes = new Map<string,number>();
    for (const e of expenses) {
      const prefix = e.id.slice(0,8);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    return expenses.map(e => {
      const prefix = e.id.slice(0,8);
      return { ...e, ...expenseDetails(e), shortID: prefixes.get(prefix) === 1 ? prefix : e.id };
    });
  }
  if (name === 'balances' && a.member) {
    if (!members.some(m => m.id === a.member)) throw new InputError('Choose a group member.');
    const titles = new Map(entries.map(e => [e.id, e.title]));
    const people = (ids: string[]) => [...new Set(ids)].map(id => ({ id, name: nameOf(id) }));
    const lines = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).flatMap(e => {
      const line = balanceLine(e, a.member);
      if (!line.amount) return [];
      return [{
        id: e.id, title: e.title, kind: e.kind, ...line, date: e.createdAt,
        from: people((e.kind === 'refund' || e.kind === 'settlement' ? entryPayers(e) : e.splits).map(p => p.memberID)),
        to: people((e.kind === 'refund' || e.kind === 'settlement' ? e.splits : entryPayers(e)).map(p => p.memberID)),
        ...(e.refundOf ? { refundOf: e.refundOf, originalTitle: titles.get(e.refundOf) } : {}),
        ...(e.pending ? { pending: true } : {}),
      }];
    });
    return [...new Set([group.currency, ...entries.map(e => settlementEntry(e).currency)])].map(currency => ({
      currency, member: { id: a.member, name: nameOf(a.member) },
      net: balances(entries, currency)[a.member] ?? 0, lines: lines.filter(line => line.currency === currency),
    }));
  }
  if (name === 'balances') return [...new Set([group.currency, ...entries.map(e=>e.exchange?.target??e.currency)])].map(currency => {
    const net = balances(entries,currency);
    const pending = entries.filter(e => e.pending && !e.handled && (e.exchange?.target ?? e.currency) === currency);
    if (!pending.length) return { currency, net, settlements: simplify(net) };
    const confirmedNet = balances(entries,currency,{includePending:false});
    return { currency, net, settlements: simplify(net), confirmedNet, confirmedSettlements: simplify(confirmedNet),
      pending: pending.map(e => ({ id: e.id, title: e.title, kind: e.kind, amount: e.amount, currency: e.currency, ...(e.pendingNote ? { note: e.pendingNote } : {}) })) };
  });
  throw new HTTPError(404,'Unknown Split command.');
}
