import { body, HTTPError, json } from './http';
import { InputError, validID } from './ledger';
import { combinationSuggestions, combinedEntry } from './combinationMath';
import { resolveEntry } from './people';
import { groupAliases } from './refunds';

const live = 'e.id NOT IN (SELECT entry_id FROM deleted_entries)';
const active = 'EXISTS (SELECT 1 FROM members WHERE group_id=e.group_id AND user_id=? AND removed_at IS NULL)';
const eligible = `${live} AND json_extract(e.payload,'$.kind')='expense'
  AND json_extract(e.payload,'$.combinedCount') IS NULL
  AND NOT COALESCE(json_extract(e.payload,'$.pending'),0)
  AND NOT COALESCE(json_extract(e.payload,'$.handled'),0)
  AND json_extract(e.payload,'$.exchange') IS NULL
  AND NOT EXISTS (SELECT 1 FROM recurring WHERE entry_id=e.id)
  AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.group_id=e.group_id
    AND json_extract(r.payload,'$.refundOf')=e.id AND r.id NOT IN (SELECT entry_id FROM deleted_entries))`;

export async function combinationRoute(request: Request, env: Env, user: string) {
  const path = new URL(request.url).pathname;
  const group = path.match(/^\/v1\/groups\/([\w-]+)\/(combine|combine-suggestions|combine-activity)$/);
  const undo = path.match(/^\/v1\/entries\/([\w-]+)\/uncombine$/);
  const db = env.DB;
  if (undo && request.method === 'POST') {
    const row = await db.prepare(`SELECT e.group_id, c.sources, c.undone_at FROM expense_combinations c
      JOIN entries e ON e.id=c.entry_id WHERE e.id=? AND ${active}`).bind(undo[1], user)
      .first<{group_id: string; sources: string; undone_at: string | null}>();
    if (!row) throw new HTTPError(404, 'Combined expense not found.');
    if (!row.undone_at) {
      await db.prepare(`UPDATE expense_combinations SET undone_by=?, undone_at=? WHERE entry_id=? AND undone_at IS NULL
        AND EXISTS (SELECT 1 FROM entries e WHERE e.id=expense_combinations.entry_id AND ${live} AND ${active})`)
        .bind(user, new Date().toISOString(), undo[1], user).run();
      if (!await db.prepare('SELECT undone_at FROM expense_combinations WHERE entry_id=?').bind(undo[1]).first('undone_at'))
        throw new HTTPError(409, 'The combined expense changed. Refresh and try again.');
    }
    return json({ entryIDs: JSON.parse(row.sources) });
  }
  if (!group) return;
  const [, groupID, action] = group;
  if (!await db.prepare(`SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL`).bind(groupID, user).first())
    throw new HTTPError(403, 'You must be an active group member.');
  if (action === 'combine-activity' && request.method === 'GET') {
    const rows = (await db.prepare(`SELECT c.entry_id AS entryID, json_extract(e.payload,'$.title') AS title,
      c.combined_by AS combinedBy,c.combined_at AS combinedAt,c.undone_by AS undoneBy,c.undone_at AS undoneAt,
      json_array_length(c.sources) AS count FROM expense_combinations c JOIN entries e ON e.id=c.entry_id
      WHERE e.group_id=? AND ${active} ORDER BY COALESCE(c.undone_at,c.combined_at) DESC LIMIT 50`)
      .bind(groupID, user).all<{entryID:string; title:string; combinedBy:string; combinedAt:string; undoneBy:string|null; undoneAt:string|null; count:number}>()).results;
    return json({ events: rows.flatMap(({entryID, title, count, combinedBy, combinedAt, undoneBy, undoneAt}) => [
      {entryID, title, count, actor: combinedBy, at: combinedAt, action: 'combine'},
      ...(undoneAt ? [{entryID, title, count, actor: undoneBy, at: undoneAt, action: 'uncombine'}] : []),
    ]).sort((a, b) => b.at.localeCompare(a.at)) });
  }
  const aliases = await groupAliases(db, groupID);
  if (action === 'combine-suggestions' && request.method === 'GET') {
    const rows = (await db.prepare(`SELECT e.payload FROM entries e WHERE e.group_id=? AND ${active} AND ${eligible}
      ORDER BY julianday(json_extract(e.payload,'$.createdAt')) DESC LIMIT 300`).bind(groupID, user).all<{payload:string}>()).results;
    return json({ suggestions: combinationSuggestions(rows.reverse().map(r => resolveEntry(JSON.parse(r.payload), aliases))) });
  }
  if (action !== 'combine' || request.method !== 'POST') return;
  const b = await body(request);
  const ids = b.entryIDs;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 50 || ids.some(id => !validID(id)) || new Set(ids).size !== ids.length)
    throw new InputError('Choose two to fifty different expenses.');
  const rows = (await db.prepare(`SELECT e.id,e.payload FROM entries e WHERE e.group_id=? AND ${active} AND ${eligible}
    AND e.id IN (SELECT value FROM json_each(?)) ORDER BY julianday(json_extract(e.payload,'$.createdAt')),e.id`)
    .bind(groupID, user, JSON.stringify(ids)).all<{id:string; payload:string}>()).results;
  if (rows.length !== ids.length) throw new HTTPError(409, 'Choose available expenses without refunds, recurrence, conversion, pending status or handled status.');
  const entries = rows.map(row => resolveEntry(JSON.parse(row.payload), aliases));
  const members = (await db.prepare(`SELECT id,removed_at FROM members WHERE group_id=?
    AND id NOT IN (SELECT member_id FROM member_aliases) ORDER BY rowid`).bind(groupID).all<{id:string;removed_at:string|null}>()).results;
  const id = crypto.randomUUID();
  const entry = combinedEntry(id, entries, members, b);
  const now = new Date().toISOString();
  // Verify the originals again inside the write transaction. The trigger
  // hides them only after the new expense and its undo record both exist.
  const [saved] = await db.batch([
    db.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at)
      SELECT ?,e.group_id,?,?,? FROM entries e JOIN json_each(?) source ON e.id=json_extract(source.value,'$.id')
      WHERE e.group_id=? AND ${active} AND ${eligible} AND e.payload=json_extract(source.value,'$.payload')
      GROUP BY e.group_id HAVING count(*)=?`)
      .bind(id,user,JSON.stringify({...entry, combinedCount:ids.length}),entry.createdAt,JSON.stringify(rows),groupID,user,ids.length),
    db.prepare(`INSERT INTO expense_combinations(entry_id,sources,combined_by,combined_at)
      SELECT id,?,?,? FROM entries WHERE id=? AND group_id=?`).bind(JSON.stringify(rows.map(row => row.id)),user,now,id,groupID),
  ]);
  if (!saved.meta.changes) throw new HTTPError(409, 'An expense changed. Refresh and try again.');
  return json({ entryID:id }, 201);
}
