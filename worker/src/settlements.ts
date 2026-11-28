import { HTTPError, json } from './http';
import type { Entry } from './ledger';

type Decision = 'approve' | 'decline' | 'cancel';
type Status = 'pending' | 'approved' | 'declined' | 'cancelled';
const decisions: Record<Decision, Status> = { approve: 'approved', decline: 'declined', cancel: 'cancelled' };

export async function recordSettlement(db: D1Database, entry: Entry, user: string) {
  const payload = JSON.stringify(entry);
  const recipient = entry.splits[0].memberID;
  const request = db.prepare(`INSERT INTO settlement_requests(id,group_id,author,payer_id,recipient_id,payload,created_at,status)
    SELECT ?,payer.group_id,?,payer.id,recipient.id,?,?,
      CASE WHEN recipient.user_id=? THEN 'approved' ELSE 'pending' END
    FROM members payer JOIN members recipient ON recipient.group_id=payer.group_id
    WHERE payer.id=? AND payer.group_id=? AND payer.removed_at IS NULL
      AND recipient.id=? AND recipient.removed_at IS NULL
      AND (payer.user_id=? OR recipient.user_id=?)
      AND NOT EXISTS (SELECT 1 FROM member_aliases WHERE member_id IN (payer.id,recipient.id))
      AND NOT EXISTS (SELECT 1 FROM entries WHERE id=?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(entry.id,user,payload,new Date().toISOString(),user,entry.paidBy,entry.groupID,recipient,user,user,entry.id);
  // The recipient can confirm a received payment when recording it.
  await db.batch([request, db.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at)
    SELECT id,group_id,author,payload,created_at FROM settlement_requests
    WHERE id=? AND group_id=? AND author=? AND payload=? AND status='approved'
    ON CONFLICT(id) DO NOTHING`).bind(entry.id,entry.groupID,user,payload)]);
  const saved = await db.prepare('SELECT author,payload,status FROM settlement_requests WHERE id=? AND group_id=?')
    .bind(entry.id,entry.groupID).first<{author:string;payload:string;status:Status}>();
  if (saved?.author === user && saved.payload === payload) return json({ok:true,status:saved.status});
  if (saved) throw new HTTPError(409,'An entry already uses this ID.');
  const existing = await db.prepare('SELECT author,payload FROM entries WHERE id=? AND group_id=?')
    .bind(entry.id,entry.groupID).first<{author:string;payload:string}>();
  if (existing?.author === user && existing.payload === payload) return json({ok:true,status:'approved'});
  if (existing) throw new HTTPError(409,'An entry already uses this ID.');
  throw new HTTPError(403,'Record a payment you made to or received from an active group member.');
}

export async function pendingSettlements(db: D1Database, user: string) {
  return (await db.prepare(`SELECT DISTINCT s.payload,s.created_at AS createdAt
    FROM settlement_requests s
    JOIN members viewer ON viewer.group_id=s.group_id AND viewer.user_id=? AND viewer.removed_at IS NULL
    LEFT JOIN member_aliases alias ON alias.member_id=s.recipient_id
    WHERE s.status='pending' AND (s.author=viewer.user_id OR COALESCE(alias.canonical_id,s.recipient_id)=viewer.id)
    ORDER BY s.created_at DESC,s.id DESC`).bind(user).all<{payload:string;createdAt:string}>()).results;
}

export async function respondToSettlement(db: D1Database, id: string, action: Decision, user: string) {
  const status = decisions[action];
  const permission = action === 'cancel'
    ? 's.author=viewer.user_id'
    : 's.author<>viewer.user_id AND COALESCE(alias.canonical_id,s.recipient_id)=viewer.id';
  const select = `FROM settlement_requests s
    JOIN members viewer ON viewer.group_id=s.group_id AND viewer.user_id=? AND viewer.removed_at IS NULL
    LEFT JOIN member_aliases alias ON alias.member_id=s.recipient_id
    WHERE s.id=? AND ${permission}`;
  const canApprove = action === 'approve'
    ? `AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id=s.id)
       AND EXISTS (SELECT 1 FROM members payer WHERE payer.id=s.payer_id AND payer.group_id=s.group_id
                   AND payer.user_id=s.author AND payer.removed_at IS NULL)`
    : '';
  const update = db.prepare(`UPDATE settlement_requests SET status=?
    WHERE id IN (SELECT s.id ${select} AND s.status='pending' ${canApprove})`).bind(status,user,id);
  if (action === 'approve') {
    // The entry and the decision commit together. Retrying the same decision
    // leaves the existing ledger entry and its later history intact.
    await db.batch([update, db.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at)
      SELECT s.id,s.group_id,s.author,s.payload,s.created_at ${select} AND s.status='approved'
      ON CONFLICT(id) DO NOTHING`).bind(user,id)]);
  } else {
    await update.run();
  }
  const result = await db.prepare(`SELECT s.status ${select}`).bind(user,id).first<Status>('status');
  if (!result) throw new HTTPError(403,'Only the payment recipient can respond, and only the payer can cancel.');
  if (result === 'pending') throw new HTTPError(409,'This request can no longer be approved. Decline it to clear it.');
  if (result !== status) throw new HTTPError(409,'This payment request has already been resolved.');
  return json({ok:true,status:result});
}
