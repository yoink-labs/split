import { tools } from '../../../cli/lib/catalog.mjs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { HTTPError } from '../http';
import { allocate, balances, Entry, InputError, simplify, validateEntry } from '../ledger';

interface Args {
  group: string; expense: string; member: string; name: string; self: string; placeholders?: string[];
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
  if (name === 'groups_list' || (name === 'activity' && !a.group)) {
    if (name === 'groups_list') return (await env.DB.prepare(`SELECT g.id,g.name,g.kind,g.currency,g.created_at AS createdAt
      FROM groups g JOIN members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.created_at DESC`).bind(user).all()).results;
    return (await ledger<{entries:Entry[]}>('/v1/snapshot')).entries;
  }
  const row = await env.DB.prepare(`SELECT g.id,g.name,g.kind,g.currency,g.created_at AS createdAt FROM groups g
    JOIN members m ON m.group_id=g.id WHERE m.user_id=? AND g.id=?`).bind(user,a.group).first<Omit<Group,'members'>>();
  if (!row) throw new HTTPError(404,'Group not found.');
  const members = (await env.DB.prepare('SELECT id,name,user_id AS userID FROM members WHERE group_id=? ORDER BY id').bind(a.group).all<Member>()).results;
  const group = { ...row, members };
  if (name === 'groups_show') return group;
  if (name === 'members_list') return members;
  if (name === 'members_add') {
    const id = crypto.randomUUID();
    const result = await env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name)
      SELECT ?,?,NULL,? WHERE (SELECT count(*) FROM members WHERE group_id=?) < 50`).bind(id,group.id,a.name.trim(),group.id).run();
    if (!result.meta.changes) throw new InputError('This group already has 50 members.');
    return { id, name: a.name.trim(), userID: null };
  }
  if (name === 'invite') {
    const result = await ledger<{url:string}>(`/v1/groups/${group.id}/invites`, { memberID: a.member });
    return { ...result, code: new URL(result.url).pathname.slice(6) };
  }
  if (name === 'expenses_add' || name === 'settle_up') {
    const entry = name === 'expenses_add' ? makeExpense(a,group) : validateEntry({
      id: crypto.randomUUID(), groupID: group.id, title: 'Settlement', amount: minor(a.amount!), currency: a.currency ?? group.currency,
      paidBy: a.from, splits: [{ memberID: a.to, amount: minor(a.amount!) }], kind: 'settlement', splitMode: 'exact', createdAt: timestamp()
    }, members.map(m => m.id));
    await ledger('/v1/entries', entry);
    return entry;
  }
  if (name === 'expenses_edit' || name === 'expenses_delete') {
    const entry = await env.DB.prepare('SELECT payload FROM entries WHERE id=? AND group_id=? AND author=?')
      .bind(a.expense, group.id, user).first<{payload:string}>();
    if (!entry) throw new HTTPError(404,'Your expense was not found.');
    const before: Entry = JSON.parse(entry.payload);
    if (before.kind !== 'expense') throw new InputError('Select an expense.');
    const after = name === 'expenses_edit' ? makeExpense(a, group, before) : null;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name,before,after])));
    const revision = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
    if (!a.yes) return { preview: true, before, after, revision };
    if (a.revision !== revision) throw new HTTPError(409,'Review a fresh preview before confirming.');
    const statement = after ? env.DB.prepare('UPDATE entries SET payload=? WHERE id=? AND group_id=? AND author=? AND payload=?').bind(JSON.stringify(after),a.expense,group.id,user,entry.payload)
      : env.DB.prepare('DELETE FROM entries WHERE id=? AND group_id=? AND author=? AND payload=?').bind(a.expense,group.id,user,entry.payload);
    if (!(await statement.run()).meta.changes) throw new HTTPError(409,'Expense changed. Review again.');
    return { applied: true, id: a.expense };
  }
  const rows = await env.DB.prepare('SELECT payload FROM entries WHERE group_id=? ORDER BY created_at DESC LIMIT 5001').bind(group.id).all<{payload:string}>();
  if (rows.results.length > 5000) throw new HTTPError(409,'Group exceeds the 5,000-entry limit.');
  const entries:Entry[] = rows.results.map(r => JSON.parse(r.payload));
  if (name === 'expenses_list') return entries.filter(e => e.kind === 'expense');
  if (name === 'activity') return entries;
  if (name === 'balances') return [...new Set([group.currency, ...entries.map(e => e.currency)])].map(currency => {
    const net = balances(entries,currency);
    return { currency, net, settlements: simplify(net) };
  });
  throw new HTTPError(404,'Unknown Split command.');
}
