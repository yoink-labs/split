import { body, HTTPError, json } from './http';
import { entryPayers, InputError, type Entry } from './ledger';
import { notifyActivity } from './notifications';

export const noOpenDispute = 'NOT EXISTS (SELECT 1 FROM expense_disputes WHERE entry_id=entries.id AND closed_at IS NULL)';

const live = 'e.id NOT IN (SELECT entry_id FROM deleted_entries)';
const payer = `EXISTS (
  SELECT 1 FROM json_each(COALESCE(json_extract(e.payload,'$.payers'),
    json_array(json_object('memberID',json_extract(e.payload,'$.paidBy'))))) p
  LEFT JOIN member_aliases a ON a.member_id=json_extract(p.value,'$.memberID')
  WHERE COALESCE(a.canonical_id,json_extract(p.value,'$.memberID'))=m.id
)`;
const resolver = `(e.author=m.user_id OR ${payer})`;
export const activeDisputeResolver = `EXISTS (
  SELECT 1 FROM entries e JOIN members m ON m.group_id=e.group_id AND m.user_id=? AND m.removed_at IS NULL
  WHERE e.id=entries.id AND ${resolver}
)`;
const participant = `EXISTS (
  SELECT 1 FROM json_each(e.payload,'$.splits') s
  LEFT JOIN member_aliases a ON a.member_id=json_extract(s.value,'$.memberID')
  WHERE COALESCE(a.canonical_id,json_extract(s.value,'$.memberID'))=m.id
)`;
const scope = `FROM entries e JOIN members m ON m.group_id=e.group_id AND m.user_id=? AND m.removed_at IS NULL
  LEFT JOIN expense_disputes d ON d.entry_id=e.id AND d.closed_at IS NULL`;

export async function disputeAccess(db: D1Database, id: string, user: string) {
  return db.prepare(`SELECT e.payload,e.group_id AS groupID,e.author,m.name,
    d.id AS disputeID,d.opened_by AS openedBy,${resolver} AS canResolve,${participant} AS participant
    ${scope} WHERE e.id=? AND ${live}`).bind(user,id).first<{
      payload:string; groupID:string; author:string; name:string; disputeID:string|null; openedBy:string|null;
      canResolve:number; participant:number;
    }>();
}

export function disputeComment(value: unknown, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > 2000 || (required && !value.trim()))
    throw new InputError('Write a reply of up to 2,000 characters.');
  return value.trim();
}

export function disputeEvent(db: D1Database, id: string, action: 'opened'|'edited'|'dismissed'|'withdrawn',
  user: string, name: string, comment: string, at = new Date().toISOString(), eventID = crypto.randomUUID()) {
  return db.prepare(`INSERT INTO expense_dispute_events(id,dispute_id,action,actor,actor_name,comment,created_at)
    SELECT ?,?,?,?,?,?,? WHERE changes()>0`).bind(eventID,id,action,user,name,comment,at);
}

export async function openDisputes(db: D1Database, user: string, group: string|null = null) {
  const {results} = await db.prepare(`SELECT d.id,e.id AS entryID,e.group_id AS groupID,
    json_extract(e.payload,'$.title') AS title,d.opened_at AS openedAt,${resolver} AS canResolve,
    d.opened_by=m.user_id AS canWithdraw,v.comment,v.actor_name AS actorName
    ${scope} JOIN expense_dispute_events v ON v.dispute_id=d.id AND v.action='opened'
    WHERE ${live} AND (? IS NULL OR e.group_id=?) ORDER BY d.opened_at DESC`).bind(user,group,group).all<{id:string; entryID:string; groupID:string; title:string; openedAt:string; canResolve:number; canWithdraw:number; comment:string; actorName:string}>();
  return results.map(row => ({...row,canResolve:Boolean(row.canResolve),canWithdraw:Boolean(row.canWithdraw)}));
}

export async function disputeRoute(request: Request, env: Env, user: string) {
  const url = new URL(request.url);
  if (request.method==='GET' && (url.pathname==='/v1/disputes' || url.pathname==='/v1/disputes/activity')) {
    const group = url.searchParams.get('group');
    if (url.pathname.endsWith('/activity')) {
      const {results} = await env.DB.prepare(`SELECT v.id,e.id AS entryID,e.group_id AS groupID,
        json_extract(e.payload,'$.title') AS title,v.action,v.comment,v.created_at AS at,v.actor_name AS actorName
        FROM expense_dispute_events v JOIN expense_disputes d ON d.id=v.dispute_id JOIN entries e ON e.id=d.entry_id
        JOIN members m ON m.group_id=e.group_id AND m.user_id=? AND m.removed_at IS NULL
        WHERE (? IS NULL OR e.group_id=?) ORDER BY v.created_at DESC,v.rowid DESC LIMIT 100`)
        .bind(user,group,group).all();
      return json({events:results});
    }
    return json({disputes:await openDisputes(env.DB,user,group)});
  }
  const match = url.pathname.match(/^\/v1\/entries\/([\w-]+)\/dispute$/);
  if (!match || (request.method!=='GET' && request.method!=='POST')) return;
  const [,id] = match;
  const row = await disputeAccess(env.DB,id,user);
  if (!row) throw new HTTPError(404,'Expense unavailable.');
  const entry = JSON.parse(row.payload) as Entry;
  const eligible = entry.kind==='expense' && !entry.combinedCount;
  if (request.method==='GET') {
    const {results} = await env.DB.prepare(`SELECT v.id,v.action,v.actor_name AS actorName,v.comment,v.created_at AS at
      FROM expense_dispute_events v JOIN expense_disputes d ON d.id=v.dispute_id
      WHERE d.entry_id=? ORDER BY v.created_at,v.rowid`).bind(id).all();
    return json({open:Boolean(row.disputeID),canDispute:eligible && Boolean(row.participant) && !row.disputeID,
      canResolve:Boolean(row.disputeID && row.canResolve),canWithdraw:Boolean(row.disputeID && row.openedBy===user),history:results});
  }
  const b = await body(request);
  const action = b.action ?? 'open';
  if (!eligible) throw new InputError('Choose an individual expense.');
  const now = new Date().toISOString();
  const eventID = crypto.randomUUID();
  const entryGuard = `e.id=? AND e.payload=? AND ${live}`;
  if (action==='open') {
    if (!row.participant) throw new HTTPError(403,'Only a participant can dispute this expense.');
    if (row.disputeID) throw new HTTPError(409,'This expense already has an open dispute.');
    const comment = disputeComment(b.comment);
    const disputeID = crypto.randomUUID();
    const insert = env.DB.prepare(`INSERT INTO expense_disputes(id,entry_id,opened_by,opened_at)
      SELECT ?,e.id,?,? ${scope} WHERE ${entryGuard} AND ${participant} AND d.id IS NULL`)
      .bind(disputeID,user,now,user,id,row.payload);
    const [result] = await env.DB.batch([insert,disputeEvent(env.DB,disputeID,'opened',user,row.name,comment,now,eventID)]);
    if (!result.meta.changes) throw new HTTPError(409,'This expense changed. Refresh and try again.');
    const recorder = await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?')
      .bind(row.groupID,row.author).first<string>('id');
    await notifyActivity(env,{groupID:row.groupID,kind:'disputes',refID:eventID,actorUserID:user,
      recipients:[...entryPayers(entry),...(recorder ? [{memberID:recorder}] : [])],title:entry.title});
    return json({ok:true,id:disputeID},201);
  }
  if (action!=='dismiss' && action!=='withdraw') throw new InputError('Choose open, dismiss or withdraw.');
  if (!row.disputeID) throw new HTTPError(409,'This expense has no open dispute.');
  if (action==='dismiss' ? !row.canResolve : row.openedBy!==user)
    throw new HTTPError(403,action==='dismiss' ? 'Only a payer or the recorder can dismiss this dispute.' : 'Only the disputer can withdraw it.');
  const comment = disputeComment(b.comment,action==='dismiss');
  const result = await env.DB.prepare(`INSERT INTO expense_dispute_events(id,dispute_id,action,actor,actor_name,comment,created_at)
    SELECT ?,d.id,?,?,m.name,?,? ${scope}
    WHERE ${entryGuard} AND d.id=? AND ${action==='dismiss' ? resolver : 'd.opened_by=m.user_id'}`)
    .bind(eventID,action==='dismiss'?'dismissed':'withdrawn',user,comment,now,user,id,row.payload,row.disputeID).run();
  if (!result.meta.changes) throw new HTTPError(409,'This dispute changed. Refresh and try again.');
  return json({ok:true});
}
