import { HTTPError, json, optionalDay, observeBody } from './http';
import { InputError, validID } from './ledger';

type Context = { actor: string | null; action: string; reason: string | null };

// D1 batches are atomic and serialized. The trigger context exists only inside
// the batch that owns it, including writes made by existing SQLite triggers.
export function historyDatabase(db: D1Database, context: Context): D1Database {
  const prepared = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; write: boolean }>();
  const batch = async <T>(statements: D1PreparedStatement[]) => {
    const resolved = statements.map(s => prepared.get(s) ?? { statement: s, write: true });
    const sql = resolved.map(s => s.statement);
    if (!resolved.some(s => s.write)) return db.batch<T>(sql);
    const results = await db.batch<T>([
      db.prepare('INSERT INTO history_context(id,actor,action,reason) VALUES (1,?,?,?)')
        .bind(context.actor, context.action, context.reason),
      ...sql,
      db.prepare('DELETE FROM history_context WHERE id=1'),
    ]);
    return results.slice(1, -1);
  };
  function wrap(statement: D1PreparedStatement, write: boolean): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), write);
        if (write && (key === 'run' || key === 'all')) return async () => (await batch([proxy]))[0];
        if (write && key === 'first') return async (column?: string) => {
          const row = (await batch<Record<string, unknown>>([proxy]))[0].results[0];
          return column === undefined ? row ?? null : row?.[column] ?? null;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    prepared.set(proxy, { statement, write });
    return proxy;
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), !/^\s*SELECT\b/i.test(sql));
      if (key === 'batch') return batch;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function historyEnv(request: Request, env: Env, actor: string): Env {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const context: Context = { actor, action: path.split('/').at(-1) ?? '', reason: null };
  if (method !== 'GET' && method !== 'HEAD') observeBody(request, value => {
    if (value.reason == null) return;
    if (typeof value.reason !== 'string' || value.reason.length > 500)
      throw new InputError('Use up to 500 characters for the reason.');
    context.reason = value.reason.trim() || null;
  });
  return { ...env, DB: historyDatabase(env.DB, context) };
}

type HistoryRow = {
  id: number; actor: string | null; member: string | null; actorName: string | null;
  timestamp: string; type: string; entity: string; expense: string | null; action: string;
  title: string | null; reason: string | null; previous: string | null; current: string | null;
};

function fieldsOf(payload: string | null): Record<string, unknown> {
  if (payload === null) return {};
  const fields = JSON.parse(payload);
  if (fields.kind && fields.splits) {
    delete fields.id;
    delete fields.groupID;
    delete fields.kind;
    fields.participants = fields.splits.map((split: { memberID: string }) => split.memberID);
    fields.chargedAmount = fields.exchange?.statementAmount ?? null;
    fields.chargedCurrency = fields.chargedAmount === null ? null : fields.exchange?.target;
  }
  return fields;
}

export async function readHistory(db: D1Database, group: string, user: string, query: URLSearchParams) {
  const where = ['group_id=?'];
  const args: unknown[] = [group];
  for (const key of ['expense', 'member', 'type'] as const) {
    const value = query.get(key);
    if (value === null) continue;
    if (key === 'type' ? !['expense','refund','credit','settlement','receipt','member','group'].includes(value) : !validID(value)) throw new InputError('Invalid history filter.');
    where.push(key === 'type' && value === 'receipt'
      ? "(type=? OR (type='expense' AND json_extract(previous,'$.bill') IS NOT json_extract(current,'$.bill')))"
      : key + '=?');
    args.push(value);
  }
  const from = optionalDay(query.get('from'), 'start date');
  const to = optionalDay(query.get('to'), 'end date');
  if (from && to && from > to) throw new InputError('End date must be on or after the start date.');
  if (from) { where.push('timestamp>=?'); args.push(from); }
  if (to) { where.push('timestamp<?'); args.push(to + 'T24:00:00'); }
  const cursor = query.get('before');
  if (cursor !== null) {
    if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new InputError('Invalid history cursor.');
    where.push('id<?');
    args.push(Number(cursor));
  }
  const active = 'SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL';
  const pageSize = 20;
  const [seat, records] = await db.batch<HistoryRow>([
    db.prepare(active).bind(group,user),
    db.prepare(`SELECT id,actor,COALESCE(member,(SELECT id FROM members WHERE group_id=change_history.group_id AND user_id=actor)) AS member,
      COALESCE(actor_name,(SELECT name FROM members WHERE group_id=change_history.group_id AND user_id=actor)) AS actorName,
      timestamp,type,entity,expense,action,title,reason,previous,current
      FROM change_history WHERE ${where.join(' AND ')} AND EXISTS (${active}) ORDER BY id DESC LIMIT ${pageSize + 1}`)
      .bind(...args, group, user),
  ]);
  if (!seat.results.length) throw new HTTPError(403, 'You are not an active member of this group.');
  const events = records.results.slice(0, pageSize).map(({ previous, current, ...event }) => {
    const before = fieldsOf(previous);
    const after = fieldsOf(current);
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const oldBill = before.bill as { closed?: boolean; items?: { id: string; title: string; memberIDs: string[] }[] } | undefined;
    const bill = after.bill as typeof oldBill;
    const oldItems = new Map(oldBill?.items?.map(item => [item.id, item]));
    const receiptChanges = bill?.items?.flatMap(item => {
      const oldItem = oldItems.get(item.id);
      const added = item.memberIDs.filter(id => !oldItem?.memberIDs.includes(id));
      const removed = oldItem?.memberIDs.filter(id => !item.memberIDs.includes(id)) ?? [];
      return added.length || removed.length ? [{ item: item.title, added, removed }] : [];
    }) ?? [];
    const action = oldBill?.closed && bill && !bill.closed ? 'reopen'
      : (event.action === 'claim' && receiptChanges.some(item => item.removed.length)
          && !receiptChanges.some(item => item.added.length) ? 'unclaim' : event.action);
    return { ...event, action, receiptChanges, currency: after.currency ?? before.currency ?? null,
      chargedCurrency: after.chargedCurrency ?? before.chargedCurrency ?? null, changes: Object.fromEntries(fields
      .filter(key => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
      .map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }])) };
  });
  return json({ events, next: records.results.length > pageSize ? events.at(-1)!.id : null });
}
