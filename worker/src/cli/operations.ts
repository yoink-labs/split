import {settlementEntry} from '../exchange';
import { breakdown, grossItems, itemSplit, type Bill } from '../items';
import { exportGroup } from './export';
import { importGroupID, parseSplitwise } from '../splitwiseCsv';
import { tools } from '../../../cli/lib/catalog.mjs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { HTTPError, optionalDay } from '../http';
import { allocate, balances, Entry, InputError, simplify, validateEntry } from '../ledger';

interface Args {
  cadence:string; weights:number[];rate?:string; group: string; expense: string; member: string; name: string; self: string; placeholders?: string[];
  query: string; user?: string; email?: string; phone?: string;
  invite: string; kind?: string; title?: string; amount?: string; payer?: string; currency?: string;
  notes?: string; date?: string;
  bill?: { items: { title: string; amount: string; memberIDs?: string[]; shares?: number[] }[]; tax?: string; tip?: string };
  share?: string; shares?: number[];
  payers?: { member: string; amount: string }[];
  description?: string; start?: string; end?: string; simplify?: 'on'|'off'; format?: 'ledger'|'summary'|'json';
  text?: string; comment?: string; avatar?: string;
  csv?: string; file?: string; me?: string; mapping?: Record<string,string>;
  photos?: string[];
  from: string; to: string; category?:string; item:string; photo:string; action?:string; mode?: 'equal'|'exact'|'percent'|'shares'|'archive'|'restore'|'delete'; participants?: string[]; values?: string[];
  yes?: boolean; revision?: string;
}
interface Member { id: string; userID: string|null; name: string; removed?: boolean }
interface Group { defaultWeights?:Record<string,number>; id: string; name: string; currency: string; members: Member[] }
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
  if (!old && a.bill) {
    bill = {
      closed: false,
      tax: a.bill.tax ? minor(a.bill.tax) : 0,
      tip: a.bill.tip ? minor(a.bill.tip) : 0,
      items: a.bill.items.map(i => {
        const memberIDs = i.memberIDs ?? [];
        const shares = shareMap(memberIDs, i.shares);
        return { id: crypto.randomUUID(), title: i.title, amount: minor(i.amount), memberIDs, ...(shares ? { shares } : {}) };
      })
    };
  }
  const amount = bill && !old
    ? bill.items.reduce((s, i) => s + i.amount, bill.tax + bill.tip)
    : (a.amount === undefined ? old?.amount : minor(a.amount));
  if (!amount) throw new InputError('Enter a positive expense amount.');
  let splits = old?.splits;
  const defaults=!old && !bill && !a.mode && !a.values && !a.participants ? group.defaultWeights : undefined;
  const weighted=defaults && Object.keys(defaults).length>0;
  const mode = bill ? 'exact' : ((a.mode as 'equal'|'exact'|'percent'|'shares'|undefined) ?? old?.splitMode ?? (weighted ? 'shares' : 'equal'));
  if (bill && !old) {
    if (!payer) throw new InputError('Choose a payer.');
    if (a.amount !== undefined && minor(a.amount) !== amount) throw new InputError('The amount must match the items, tax and tip.');
    if (a.mode || a.participants || a.values) throw new InputError('Use the bill’s item claimants to split an itemized expense.');
    splits = itemSplit(bill, payer);
  } else if (!old || a.mode || a.participants || a.values || amount !== old.amount) {
    const participants = a.participants ?? old?.splits.map(s => s.memberID) ?? (weighted ? activeIDs.filter(id=>defaults[id]>0) : activeIDs);
    if (a.values && a.values.length !== participants.length) throw new InputError('Supply one value per participant.');
    let portions: number[];
    if (mode === 'equal') {
      if (a.values) throw new InputError('Equal splits use participants only.');
      portions = allocate(amount, participants.map(() => 1));
    } else {
      const inputs=a.values ?? (weighted ? participants.map(id=>String(defaults[id])) : undefined);
      if (!inputs) throw new InputError('Supply one allocation value per participant.');
      const values = inputs.map(minor);
      if (mode === 'percent' && values.reduce((n,v) => n+v,0) !== 10000) throw new InputError('Percentages must sum to 100.');
      portions = mode === 'exact' ? values : allocate(amount, values);
    }
    splits = participants.map((memberID,i) => ({ memberID, amount: portions[i] }));
  }
  const date = optionalDay(a.date, 'expense date');
  const createdAt = old?.createdAt ?? (date ? date + 'T12:00:00Z' : timestamp());
  if(old?.exchange && a.currency && a.currency!==old.currency && !a.rate) throw new InputError('Supply a new rate when changing a converted currency.');
  const exchange=a.rate ? {target:group.currency,rateE8:Math.round(Number(a.rate)*1e8),source:'Manual' as const,date:createdAt.slice(0,10)} : old?.exchange;
  let payers=old?.payers?.length ? (amount===old.amount ? old.payers
    : allocate(amount,old.payers.map(p=>p.amount)).map((value,i)=>({memberID:old.payers![i].memberID,amount:value}))) : undefined;
  if (a.payers) {
    payers = a.payers.map(p => ({ memberID: p.member, amount: minor(p.amount) }));
    if (payers.reduce((n, p) => n + p.amount, 0) !== amount) throw new InputError('The payer amounts must match the total exactly.');
    if (payers.length === 1) payers = undefined;
  }
  return validateEntry({ id: old?.id ?? crypto.randomUUID(), groupID: group.id, title: a.title ?? old?.title,
    amount, currency: a.currency ?? old?.currency ?? group.currency, paidBy: a.payers && !a.payer ? a.payers[0].member : payer,
    exchange, bill, category:a.category??old?.category, splits, kind: 'expense', splitMode: mode, createdAt,
    payers, notes: a.notes ?? old?.notes, handled: old?.handled }, ids,old?.bill);
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
    if (!a.me && !a.group) return { preview: true, group: parsed.name, members: names, rows: parsed.rows.length, skipped: parsed.skipped, next: 'Run again with me set to your name in this file.' };
    if (a.me && !names.includes(a.me)) throw new InputError('Choose your name from: ' + names.join(', ') + '.');
    for (const n of Object.keys(a.mapping ?? {})) if (!names.includes(n)) throw new InputError(n + ' is not in this file.');
    const people = names.map(n => n === a.me ? { name: n, me: true } : a.mapping?.[n] ? { name: n, memberID: a.mapping[n] } : { name: n });
    const counts = new Map<string, number>();
    for (const r of parsed.rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
    const currency = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'USD';
    const body = a.group ? { groupID: a.group, people, rows: parsed.rows }
      : { group: { id: await importGroupID(parsed.fingerprint, user), name: (a.name ?? parsed.name).slice(0, 80), kind: a.kind ?? 'trip', currency }, people, rows: parsed.rows };
    return ledger('/v1/import/splitwise', body);
  }
  if (name === 'members_lookup') return ledger('/v1/people/search', { query: a.query });
  if (name === 'groups_list') {
    return (await env.DB.prepare(`SELECT g.id,g.name,g.kind,g.currency,g.created_at AS createdAt FROM groups g
      JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC`).bind(user).all()).results;
  }
  const snapshot = await ledger<{groups: Group[]; entries: (Entry & {editable: boolean})[]}>('/v1/snapshot');
  if (name === 'activity' && !a.group) return snapshot.entries;
  const group = snapshot.groups.find(g => g.id === a.group);
  if (!group) throw new HTTPError(404, 'Group not found.');
  const { members } = group;
  if(name==='groups_default_split') {
    if(a.weights.length!==a.participants?.length) throw new InputError('Supply one weight per member.');
    return ledger('/v1/groups/'+group.id+'/default-split',{weights:Object.fromEntries(a.participants.map((id,i)=>[id,a.weights[i]]))});
  }
  if(name==='members_payment') return ledger('/v1/groups/'+group.id+'/payment-profile',a);
  if(name==='expenses_repeat') return ledger('/v1/groups/'+group.id+'/repeat',{entryID:a.expense,cadence:a.cadence});
  if (name === 'groups_show') return group;
  if (name === 'groups_update') return ledger('/v1/groups/'+group.id+'/update', {
    name: a.name, description: clearable(a.description), startDate: clearable(a.start), endDate: clearable(a.end),
    simplify: a.simplify === undefined ? undefined : a.simplify === 'on', currency: a.currency });
  if (name === 'groups_archive') return ledger('/v1/groups/'+group.id+'/archive', { archived: a.action !== 'restore' });
  if (name === 'groups_leave') {
    if (!a.yes) return { preview: true, action: 'Leave ' + group.name, deletesGroup: members.filter(m => m.userID).length <= 1 };
    return ledger('/v1/groups/'+group.id+'/leave', {});
  }
  if (name === 'members_remove') return ledger('/v1/groups/'+group.id+'/members/'+a.member+'/remove', { mode: a.mode ?? 'archive' });
  if (name === 'invites_list') return ledger('/v1/groups/'+group.id+'/invites');
  if (name === 'invites_revoke') return ledger('/v1/groups/'+group.id+'/invites/'+a.invite+'/revoke', {});
  if (name === 'members_list') return members;
  if (name === 'members_add') {
    return ledger(`/v1/groups/${group.id}/members`, {
      id: crypto.randomUUID(), name: a.name, userID: a.user, email: a.email, phone: a.phone
    });
  }
  if (name === 'invite') return ledger(`/v1/groups/${group.id}/invites`, { memberID: a.member });
  if (name === 'expenses_add' || name === 'settle_up') {
    const entry = name === 'expenses_add' ? makeExpense(a,group) : validateEntry({
      id: crypto.randomUUID(), groupID: group.id, title: 'Settlement', amount: minor(a.amount!), currency: a.currency ?? group.currency,
      paidBy: a.from, splits: [{ memberID: a.to, amount: minor(a.amount!) }], kind: 'settlement', splitMode: 'exact', createdAt: timestamp()
    }, members.map(m => m.id));
    const photos = name === 'expenses_add' && a.photos?.length
      ? a.photos.map(data => ({ id: crypto.randomUUID(), data }))
      : undefined;
    const result = await ledger<{status?: string}>(name === 'settle_up' ? '/v1/settlements' : '/v1/entries', photos ? { ...entry, photos } : entry);
    if (name === 'settle_up') return { ...entry, status: result.status };
    return photos ? { ...entry, receiptIDs: photos.map(p => p.id) } : entry;
  }
  if (name === 'expenses_edit' || name === 'expenses_delete') {
    const before = snapshot.entries.find(e => e.groupID === group.id && e.id === a.expense && e.editable);
    if (!before) throw new HTTPError(404,'Your expense was not found.');
    if (before.kind !== 'expense') throw new InputError('Select an expense.');
    const after = name === 'expenses_edit' ? makeExpense(a, group, before) : null;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name,before,after])));
    const revision = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
    if (!a.yes) return { preview: true, before, after, revision };
    if (a.revision !== revision) throw new HTTPError(409,'Review a fresh preview before confirming.');
    const action = after ? 'edit' : 'delete';
    await ledger(`/v1/entries/${before.id}/${action}`, { original: before, entry: after });
    return { applied: true, id: a.expense };
  }
  const entries = snapshot.entries.filter(e => e.groupID === group.id);
  if (name === 'groups_export') {
    const comments = a.format === 'json' ? Object.fromEntries(await Promise.all(entries.filter(e => (e as {commentCount?:number}).commentCount)
      .map(async e => [e.id, (await ledger<{comments:unknown[]}>('/v1/entries/'+e.id+'/comments')).comments]))) : {};
    return exportGroup(group, entries, a.format ?? 'ledger', comments);
  }
  if (['expenses_show','expenses_like','comments_list','comments_add','comments_delete','receipts_add'].includes(name)) {
    const e = entries.find(e => e.id === a.expense);
    if (!e) throw new HTTPError(404, 'Expense not found.');
    const path = '/v1/entries/' + e.id;
    if (name === 'expenses_show') {
      const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? id;
      return { ...e, payerNames: (e.payers?.length ? e.payers : [{ memberID: e.paidBy, amount: e.amount }]).map(p => ({ ...p, name: nameOf(p.memberID) })),
        splitNames: e.splits.map(p => ({ ...p, name: nameOf(p.memberID) })),
        items: e.bill ? grossItems(e.bill).map(i => ({ id: i.id, title: i.title, gross: i.gross, members: i.memberIDs.map(nameOf), shares: multipliers(i.shares), open: !i.memberIDs.length })) : undefined,
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
  if(name==='groups_breakdown') {
    if(a.member && !members.some(m=>m.id===a.member)) throw new InputError('Choose a group member.');
    return [...new Set([group.currency,...entries.map(e=>e.exchange?.target??e.currency)])].map(currency=>{
      const report=breakdown(entries.map(settlementEntry),members,currency);
      return a.member ? {...report,members:report.members.filter(m=>m.id===a.member),expenses:entries.filter(e=>(e.exchange?.target??e.currency)===currency && e.kind==='expense' && (e.paidBy===a.member || e.splits.some(s=>s.memberID===a.member)))} : report;
    });
  }
  if(name==='items_open') return entries.filter(e=>e.bill).flatMap(e=>grossItems(e.bill!).filter(i=>!i.memberIDs.length).map(i=>({expense:e.id,expenseTitle:e.title,currency:e.currency,...i})));
  if(name.startsWith('receipts_') || name.startsWith('items_')) {
    const e=entries.find(e=>e.id===a.expense);
    if(!e) throw new HTTPError(404,'Expense not found.');
    const path='/v1/entries/'+e.id;
    if(name==='receipts_list') return e.receiptIDs??[];
    if(name==='items_list') {
      if(!e.bill) throw new InputError('This expense has no itemized receipt.');
      return {expense:e.id,title:e.title,currency:e.currency,payer:e.paidBy,closed:e.bill.closed,tax:e.bill.tax,tip:e.bill.tip,receiptIDs:e.receiptIDs??[],
        items:grossItems(e.bill).map(i=>({id:i.id,title:i.title,amount:i.amount,gross:i.gross,memberIDs:i.memberIDs,shares:multipliers(i.shares),open:!i.memberIDs.length}))};
    }
    if(name==='receipts_get') {
      const res=await handle(new Request(env.APP_URL+path+'/receipts/'+a.photo),env,user);
      const bytes=new Uint8Array(await res.arrayBuffer());
      let raw='';
      for(const byte of bytes) raw+=String.fromCharCode(byte);
      return {mimeType:'image/jpeg',data:btoa(raw)};
    }
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
  if (name === 'expenses_list') return entries.filter(e => e.kind === 'expense');
  if (name === 'activity') return entries;
  if (name === 'balances') return [...new Set([group.currency, ...entries.map(e=>e.exchange?.target??e.currency)])].map(currency => {
    const net = balances(entries,currency);
    return { currency, net, settlements: simplify(net) };
  });
  throw new HTTPError(404,'Unknown Split command.');
}
