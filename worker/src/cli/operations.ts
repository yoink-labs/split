import { tools } from '../../../cli/lib/catalog.mjs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { HTTPError } from '../http';
import { allocate, balances, Entry, InputError, simplify, validateEntry } from '../ledger';

interface Args {
  group: string; expense: string; member: string; name: string; self: string; placeholders?: string[];
  query: string; user?: string; email?: string; phone?: string;
  invite: string; kind?: string; title?: string; amount?: string; payer?: string; currency?: string;
  from: string; to: string; mode?: 'equal'|'exact'|'percent'; participants?: string[]; values?: string[];
  yes?: boolean; revision?: string;
}
interface Member { id: string; userID: string|null; name: string }
interface Group { id: string; name: string; currency: string; members: Member[] }
export type LedgerHandler = (r: Request, env: Env, user: string) => Promise<Response>;
const provider = new CfWorkerJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, provider.getValidator<Args>(tool.inputSchema as JsonSchemaType)]));
const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function minor(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
}
function makeExpense(a: Args, group: Group, old?: Entry): Entry {
  const ids = group.members.map(m => m.id);
  const amount = a.amount === undefined ? old?.amount : minor(a.amount);
  if (!amount) throw new InputError('Enter a positive expense amount.');
  let splits = old?.splits;
  const mode = a.mode ?? old?.splitMode ?? 'equal';
  if (!old || a.mode || a.participants || a.values || amount !== old.amount) {
    const participants = a.participants ?? old?.splits.map(s => s.memberID) ?? ids;
    if (a.values && a.values.length !== participants.length) throw new InputError('Supply one value per participant.');
    let portions: number[];
    if (mode === 'equal') {
      if (a.values) throw new InputError('Equal splits use participants only.');
      portions = allocate(amount, participants.map(() => 1));
    } else {
      if (!a.values || mode === 'shares') throw new InputError('Choose exact or percent and supply the allocation values.');
      const values = a.values.map(minor);
      if (mode === 'percent' && values.reduce((n,v) => n+v,0) !== 10000) throw new InputError('Percentages must sum to 100.');
      portions = mode === 'exact' ? values : allocate(amount, values);
    }
    splits = participants.map((memberID,i) => ({ memberID, amount: portions[i] }));
  }
  return validateEntry({ id: old?.id ?? crypto.randomUUID(), groupID: group.id, title: a.title ?? old?.title,
    amount, currency: a.currency ?? old?.currency ?? group.currency, paidBy: a.payer ?? old?.paidBy,
    splits, kind: 'expense', splitMode: mode, createdAt: old?.createdAt ?? timestamp() }, ids);
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
    await ledger('/v1/groups', { id: groupID, name: a.name, kind: a.kind ?? 'trip', currency: a.currency ?? 'USD', members });
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
  if (name === 'groups_show') return group;
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
    await ledger('/v1/entries', entry);
    return entry;
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
  if (name === 'expenses_list') return entries.filter(e => e.kind === 'expense');
  if (name === 'activity') return entries;
  if (name === 'balances') return [...new Set([group.currency, ...entries.map(e => e.currency)])].map(currency => {
    const net = balances(entries,currency);
    return { currency, net, settlements: simplify(net) };
  });
  throw new HTTPError(404,'Unknown Split command.');
}
