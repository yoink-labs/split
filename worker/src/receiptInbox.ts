// Group receipts inbox: upload a receipt before its expense exists, pair it later, or move an
// attached receipt to another expense in the same group (or back to the inbox). Every route checks
// group membership; writes need an active membership, and both ends of a pair or move must be in
// the viewer's group.
import { body, HTTPError, json } from './http';
import { InputError, validID } from './ledger';
import { jpegBytes, jpegResponse } from './receipts';

const MAX_PER_EXPENSE = 4;
const liveExpense = `SELECT id FROM entries WHERE id=? AND group_id=? AND json_extract(payload,'$.kind')='expense'
  AND id NOT IN (SELECT entry_id FROM deleted_entries)`;

async function seat(env: Env, groupID: string, userID: string, active: boolean) {
  const row = await env.DB.prepare(`SELECT id FROM members WHERE group_id=? AND user_id=?${active ? ' AND removed_at IS NULL' : ''}`)
    .bind(groupID, userID).first<{ id: string }>();
  if (!row) throw new HTTPError(403, active ? 'You are not a member of this group or your membership is archived.' : 'You are not a member of this group.');
  return row.id;
}

async function targetExpense(env: Env, entryID: unknown, groupID: string) {
  if (!validID(entryID)) throw new InputError('Choose an expense.');
  if (!await env.DB.prepare(liveExpense).bind(entryID, groupID).first()) throw new HTTPError(404, 'Expense not found in this group.');
  const count = await env.DB.prepare('SELECT count(*) AS n FROM receipts WHERE entry_id=?').bind(entryID).first<number>('n');
  if ((count ?? 0) >= MAX_PER_EXPENSE) throw new HTTPError(409, 'An expense can hold up to four receipts.');
  return entryID;
}

export async function receiptInboxRoute(req: Request, env: Env, userID: string): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  const inbox = path.match(/^\/v1\/groups\/([\w-]+)\/receipts(?:\/([\w-]+)(?:\/(delete|pair))?)?$/);
  if (inbox) {
    const [, groupID, receiptID, action] = inbox;
    if (!receiptID && req.method === 'GET') {
      await seat(env, groupID, userID, false);
      const { results } = await env.DB.prepare(`SELECT id,group_id AS groupID,uploaded_by AS uploadedBy,created_at AS createdAt,note,length(image) AS bytes
        FROM inbox_receipts WHERE group_id=? ORDER BY created_at DESC, id`).bind(groupID)
        .all<{ id: string; groupID: string; uploadedBy: string; createdAt: string; note: string | null; bytes: number }>();
      return json({ receipts: results.map(({ note, ...r }) => ({ ...r, ...(note ? { note } : {}) })) });
    }
    if (!receiptID && req.method === 'POST') {
      const memberID = await seat(env, groupID, userID, true);
      const b = await body(req, 400_000);
      if (!validID(b.id)) throw new InputError('Invalid receipt.');
      const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note.trim() : undefined;
      if (note === undefined || (note !== null && note.length > 200)) throw new InputError('Write a note of up to 200 characters.');
      const bytes = jpegBytes(b.data);
      const attached = await env.DB.prepare(`SELECT 1 FROM receipts r JOIN entries e ON e.id=r.entry_id WHERE e.group_id=? AND r.id=?`).bind(groupID, b.id).first();
      if (attached) return json({ id: b.id }, 200);
      const saved = await env.DB.prepare(`INSERT INTO inbox_receipts(group_id,id,uploaded_by,user_id,note,created_at,image) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(group_id,id) DO NOTHING`).bind(groupID, b.id, memberID, userID, note || null, new Date().toISOString(), bytes.buffer).run();
      if (!saved.meta.changes && !await env.DB.prepare('SELECT 1 FROM inbox_receipts WHERE group_id=? AND id=? AND user_id=?').bind(groupID, b.id, userID).first())
        throw new HTTPError(409, 'A receipt already uses this ID.');
      return json({ id: b.id }, saved.meta.changes ? 201 : 200);
    }
    if (receiptID && !action && req.method === 'GET') {
      await seat(env, groupID, userID, false);
      const image = await env.DB.prepare('SELECT image FROM inbox_receipts WHERE group_id=? AND id=?').bind(groupID, receiptID).first<number[] | ArrayBuffer>('image');
      if (!image) throw new HTTPError(404, 'Receipt not found.');
      return jpegResponse(image);
    }
    if (receiptID && action === 'delete' && req.method === 'POST') {
      await seat(env, groupID, userID, true);
      const row = await env.DB.prepare('SELECT user_id FROM inbox_receipts WHERE group_id=? AND id=?').bind(groupID, receiptID).first<string>('user_id');
      if (!row) return json({ ok: true });
      if (row !== userID) throw new HTTPError(403, 'Only the person who uploaded this receipt can delete it.');
      await env.DB.prepare('DELETE FROM inbox_receipts WHERE group_id=? AND id=? AND user_id=?').bind(groupID, receiptID, userID).run();
      return json({ ok: true });
    }
    if (receiptID && action === 'pair' && req.method === 'POST') {
      await seat(env, groupID, userID, true);
      const entryID = await targetExpense(env, (await body(req)).entryID, groupID);
      if (!await env.DB.prepare('SELECT 1 FROM inbox_receipts WHERE group_id=? AND id=?').bind(groupID, receiptID).first()) {
        if (await env.DB.prepare('SELECT 1 FROM receipts WHERE entry_id=? AND id=?').bind(entryID, receiptID).first())
          return json({ ok: true, entryID, receiptID });
        throw new HTTPError(404, 'Receipt not found in this group’s inbox.');
      }
      if (await env.DB.prepare('SELECT 1 FROM receipts WHERE entry_id=? AND id=?').bind(entryID, receiptID).first())
        throw new HTTPError(409, 'This expense already has a receipt with this ID.');
      // Copy then remove in one transaction; the delete only runs once the copy exists.
      const [copied] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO receipts(entry_id,id,image) SELECT ?,id,image FROM inbox_receipts
          WHERE group_id=? AND id=? AND EXISTS (${liveExpense})`).bind(entryID, groupID, receiptID, entryID, groupID),
        env.DB.prepare(`DELETE FROM inbox_receipts WHERE group_id=? AND id=? AND EXISTS (SELECT 1 FROM receipts WHERE entry_id=? AND id=?)`)
          .bind(groupID, receiptID, entryID, receiptID)
      ]);
      if (!copied.meta.changes) throw new HTTPError(409, 'This receipt or expense changed. Refresh and try again.');
      return json({ ok: true, entryID, receiptID });
    }
    return;
  }
  const move = path.match(/^\/v1\/entries\/([\w-]+)\/receipts\/([\w-]+)\/move$/);
  if (!move || req.method !== 'POST') return;
  const [, sourceID, receiptID] = move;
  const source = await env.DB.prepare(`SELECT e.group_id AS groupID FROM entries e JOIN receipts r ON r.entry_id=e.id
    JOIN members m ON m.group_id=e.group_id AND m.user_id=?
    WHERE e.id=? AND r.id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries)`).bind(userID, sourceID, receiptID).first<{ groupID: string }>();
  if (!source) throw new HTTPError(404, 'Receipt not found.');
  const memberID = await seat(env, source.groupID, userID, true);
  const b = await body(req);
  if (b.entryID === null) {
    if (await env.DB.prepare('SELECT 1 FROM inbox_receipts WHERE group_id=? AND id=?').bind(source.groupID, receiptID).first())
      throw new HTTPError(409, 'The inbox already has a receipt with this ID.');
    const [copied] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO inbox_receipts(group_id,id,uploaded_by,user_id,note,created_at,image)
        SELECT ?,id,?,?,NULL,?,image FROM receipts WHERE entry_id=? AND id=?`)
        .bind(source.groupID, memberID, userID, new Date().toISOString(), sourceID, receiptID),
      env.DB.prepare(`DELETE FROM receipts WHERE entry_id=? AND id=? AND EXISTS (SELECT 1 FROM inbox_receipts WHERE group_id=? AND id=?)`)
        .bind(sourceID, receiptID, source.groupID, receiptID)
    ]);
    if (!copied.meta.changes) throw new HTTPError(409, 'This receipt changed. Refresh and try again.');
    return json({ ok: true, entryID: null, receiptID });
  }
  if (b.entryID === sourceID) return json({ ok: true, entryID: sourceID, receiptID });
  const entryID = await targetExpense(env, b.entryID, source.groupID);
  if (await env.DB.prepare('SELECT 1 FROM receipts WHERE entry_id=? AND id=?').bind(entryID, receiptID).first())
    throw new HTTPError(409, 'That expense already has a receipt with this ID.');
  const moved = await env.DB.prepare(`UPDATE receipts SET entry_id=? WHERE entry_id=? AND id=? AND EXISTS (${liveExpense})`)
    .bind(entryID, sourceID, receiptID, entryID, source.groupID).run();
  if (!moved.meta.changes) throw new HTTPError(409, 'This receipt or expense changed. Refresh and try again.');
  return json({ ok: true, entryID, receiptID });
}
