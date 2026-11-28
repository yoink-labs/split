// Refunds, credits and pending expenses. See docs/REFUNDS_AND_PENDING.md.
import { HTTPError, json, body } from './http';
import { Entry, entryPayers, InputError, validateEntry } from './ledger';
import { adjustedEntry, refundRoom } from './refundMath';
import { resolveEntry } from './people';
import { itemRefund } from './items';

const live = 'id NOT IN (SELECT entry_id FROM deleted_entries)';
const linked = `group_id=? AND json_extract(payload,'$.refundOf')=? AND id<>? AND ${live}`;

export async function groupAliases(db: D1Database, groupID: string) {
  return new Map((await db.prepare(`SELECT a.member_id,a.canonical_id FROM member_aliases a
    JOIN members m ON m.id=a.canonical_id WHERE m.group_id=?`).bind(groupID)
    .all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
}

/** SQL that holds only while the original and its other refunds are unchanged. */
export interface Guard { sql: string; binds: unknown[] }

async function linkedRefunds(db: D1Database, groupID: string, originalID: string, excludeID: string) {
  return (await db.prepare(`SELECT payload FROM entries WHERE ${linked} ORDER BY id`)
    .bind(groupID, originalID, excludeID).all<{payload:string}>()).results.map(r => JSON.parse(r.payload) as Entry);
}
function refundsGuard(groupID: string, originalID: string, excludeID: string, refunds: Entry[]): Guard {
  return {
    sql: `(SELECT count(*)||':'||COALESCE(sum(json_extract(payload,'$.amount')),0) FROM entries WHERE ${linked})=?`,
    binds: [groupID, originalID, excludeID, refunds.length + ':' + refunds.reduce((n, r) => n + r.amount, 0)],
  };
}

/** Every refund must fit inside the original: per person by share, and in total by amount. */
export function checkRefundsFit(original: Entry, refunds: Entry[], aliases: Map<string,string>) {
  if (original.kind !== 'expense') throw new InputError('Refunds can only refer to an expense.');
  const canonical = resolveEntry(original, aliases);
  const resolved = refunds.map(r => resolveEntry(r, aliases));
  for (const refund of resolved) {
    if (refund.currency !== original.currency) throw new InputError('Use the original expense currency for its refund.');
    if (Boolean(refund.exchange) !== Boolean(original.exchange) || (original.exchange && refund.exchange!.target !== original.exchange.target))
      throw new InputError('Convert the refund to the same settlement currency as the original expense.');
    if (refund.splits.some(s => s.amount && !canonical.splits.some(o => o.memberID === s.memberID && o.amount > 0)))
      throw new InputError('Only credit people who shared the original expense.');
  }
  const room = refundRoom(canonical, resolved);
  if (room.total < 0) throw new InputError('Refunds cannot exceed the original expense amount.');
  if (Object.values(room.members).some(left => left < 0)) throw new InputError('A refund to one person cannot exceed their share of the original expense.');
}

/** Validates a linked refund against its original and returns the guard for the write. */
export async function refundGuard(db: D1Database, refund: Entry, aliases: Map<string,string>, originalPayload?: string): Promise<Guard | undefined> {
  if (refund.kind !== 'refund' || !refund.refundOf) return undefined;
  const row = await db.prepare(`SELECT payload FROM entries WHERE id=? AND group_id=? AND ${live}`)
    .bind(refund.refundOf, refund.groupID).first<{payload:string}>();
  if (!row) throw new HTTPError(404, 'Original expense not found.');
  const payload = originalPayload ?? row.payload;
  const others = await linkedRefunds(db, refund.groupID, refund.refundOf, refund.id);
  const original: Entry = JSON.parse(payload);
  if (refund.refundItems) checkItemRefund(resolveEntry(original, aliases), resolveEntry(refund, aliases), others);
  checkRefundsFit(original, [...others, refund], aliases);
  const fit = refundsGuard(refund.groupID, refund.refundOf, refund.id, others);
  return {
    sql: `EXISTS (SELECT 1 FROM entries WHERE id=? AND group_id=? AND payload=? AND ${live}) AND ${fit.sql}`,
    binds: [refund.refundOf, refund.groupID, payload, ...fit.binds],
  };
}

/** A refund of specific items must credit exactly what those items cost each person, and each item is refunded once. */
export function checkItemRefund(original: Entry, refund: Entry, others: Entry[]) {
  const ids = refund.refundItems!;
  if (others.some(r => r.refundItems?.some(id => ids.includes(id)))) throw new InputError('One of these items has already been refunded.');
  const exact = itemRefund(original, ids);
  if (refund.amount !== exact.amount || refund.splits.filter(s => s.amount).length !== exact.splits.length ||
      exact.splits.some(p => !refund.splits.some(s => s.memberID === p.memberID && s.amount === p.amount)))
    throw new InputError('Refresh the item refund: credits must match what each person paid for these items.');
}

/** An edited expense must still cover its refunds. */
export async function refundedExpenseGuard(db: D1Database, expense: Entry, aliases: Map<string,string>): Promise<Guard | undefined> {
  if (expense.kind !== 'expense') return undefined;
  const refunds = await linkedRefunds(db, expense.groupID, expense.id, expense.id);
  if (!refunds.length) return undefined;
  if (refunds.some(r => r.refundItems?.some(id => !expense.bill?.items.some(i => i.id === id))))
    throw new InputError('This expense has item refunds. Keep the refunded items, or delete those refunds first.');
  try { checkRefundsFit(expense, refunds, aliases); }
  catch (error) {
    if (error instanceof InputError) throw new InputError('This expense has refunds. ' + error.message + ' Edit or delete the refunds first.');
    throw error;
  }
  return refundsGuard(expense.groupID, expense.id, expense.id, refunds);
}

export async function hasRefunds(db: D1Database, groupID: string, id: string) {
  return Boolean(await db.prepare(`SELECT 1 FROM entries WHERE ${linked} LIMIT 1`).bind(groupID, id, id).first());
}

async function members(db: D1Database, groupID: string) {
  return (await db.prepare('SELECT id FROM members WHERE group_id=?').bind(groupID).all<{id:string}>()).results.map(m => m.id);
}

// POST /v1/entries/:id/pending and /v1/entries/:id/resolve
export async function pendingRoute(request: Request, env: Env, user: string): Promise<Response | undefined> {
  const match = new URL(request.url).pathname.match(/^\/v1\/entries\/([\w-]+)\/(pending|resolve)$/);
  if (!match || request.method !== 'POST') return;
  const [, id, action] = match;
  const b = await body(request, 65_536);
  const row = await env.DB.prepare(`SELECT e.payload,e.author,e.group_id AS groupID,m.id AS viewer FROM entries e
    JOIN members m ON m.group_id=e.group_id AND m.user_id=? AND m.removed_at IS NULL
    WHERE e.id=? AND e.${live}`).bind(user, id).first<{payload:string;author:string;groupID:string;viewer:string}>();
  if (!row) throw new HTTPError(404, 'Expense unavailable.');
  const entry: Entry = JSON.parse(row.payload);
  if (entry.kind === 'settlement') throw new InputError('Only expenses and refunds can be pending.');
  const aliases = await groupAliases(env.DB, row.groupID);
  const viewer = aliases.get(row.viewer) ?? row.viewer;
  if (row.author !== user && !entryPayers(resolveEntry(entry, aliases)).some(p => p.memberID === viewer))
    throw new HTTPError(403, 'Only the person who recorded this entry or a payer can change whether it is pending.');
  const ids = await members(env.DB, row.groupID);
  const save = async (next: Entry, guard?: Guard) => {
    const payload = JSON.stringify(next);
    const update = env.DB.prepare(`UPDATE entries SET payload=? WHERE id=? AND payload=? AND ${live}${guard ? ' AND ' + guard.sql : ''}`)
      .bind(payload, id, row.payload, ...(guard?.binds ?? []));
    const result = await update.run();
    if (!result.meta.changes) throw new HTTPError(409, 'This entry changed. Refresh and try again.');
    return payload;
  };

  if (action === 'pending') {
    if (typeof b.pending !== 'boolean') throw new InputError('Choose whether the entry is pending.');
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') throw new InputError('Write a pending note of up to 500 characters.');
    const {pending: _p, pendingNote: _n, ...rest} = entry;
    const note = b.note === undefined ? entry.pendingNote : b.note;
    const next = validateEntry({...rest, ...(b.pending ? {pending: true, ...(note ? {pendingNote: note} : {})} : {})}, ids, entry.bill);
    if (JSON.stringify(next) === row.payload) return json({ok: true, pending: b.pending});
    await save(next);
    return json({ok: true, pending: b.pending});
  }

  if (b.action === 'confirm') {
    if (!entry.pending) return json({ok: true});
    const {pending: _p, pendingNote: _n, ...rest} = entry;
    await save(validateEntry(rest, ids, entry.bill));
    return json({ok: true});
  }
  if (b.action === 'adjust') {
    if (!Number.isSafeInteger(b.amount) || (b.amount as number) <= 0) throw new InputError('Enter the new amount in minor units.');
    if (!entry.pending) {
      if (entry.amount === b.amount) return json({ok: true});
      throw new HTTPError(409, 'This entry is no longer pending. Edit it instead.');
    }
    const next = validateEntry(adjustedEntry(entry, b.amount as number, b.statementAmount), ids);
    const guard = await refundedExpenseGuard(env.DB, next, aliases);
    await save(next, guard);
    return json({ok: true, amount: next.amount});
  }
  if (b.action === 'refund') {
    if (entry.kind !== 'expense') throw new InputError('Only an expense can be turned into a refund.');
    const refund = validateEntry(b.refund, ids);
    if (refund.kind !== 'refund' || refund.refundOf !== id || refund.groupID !== row.groupID || refund.pending)
      throw new InputError('Record a confirmed refund of this expense.');
    const existing = await env.DB.prepare('SELECT author,payload FROM entries WHERE id=?').bind(refund.id).first<{author:string;payload:string}>();
    if (existing) {
      if (existing.author === user && existing.payload === JSON.stringify(refund) && !entry.pending) return json({ok: true});
      throw new HTTPError(409, 'An entry already uses this ID.');
    }
    if (!entry.pending) throw new HTTPError(409, 'This entry is no longer pending. Record a refund instead.');
    const {pending: _p, pendingNote: _n, ...rest} = entry;
    const confirmed = validateEntry(rest, ids, entry.bill);
    // The refund is inserted against the current original and its refunds; clearing pending
    // only happens if that insert landed, so both commit or neither does.
    const guard = (await refundGuard(env.DB, refund, aliases, row.payload))!;
    const payload = JSON.stringify(refund);
    const insert = env.DB.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at) SELECT ?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM settlement_requests WHERE id=?) AND ${guard.sql} ON CONFLICT(id) DO NOTHING`)
      .bind(refund.id, row.groupID, user, payload, new Date().toISOString(), refund.id, ...guard.binds);
    const update = env.DB.prepare(`UPDATE entries SET payload=? WHERE id=? AND payload=? AND ${live}
      AND EXISTS (SELECT 1 FROM entries WHERE id=? AND author=? AND payload=?)`)
      .bind(JSON.stringify(confirmed), id, row.payload, refund.id, user, payload);
    const [inserted, updated] = await env.DB.batch([insert, update]);
    if (!inserted.meta.changes || !updated.meta.changes) throw new HTTPError(409, 'This entry changed. Refresh and try again.');
    return json({ok: true});
  }
  throw new InputError('Choose confirm, adjust or refund.');
}
