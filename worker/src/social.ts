import { groupKind } from './tripPhases';
import { HTTPError, body, json, optionalDay } from './http';
import { requireActiveMember } from './memberEmail';
import { currencies, InputError } from './ledger';

interface EntryScope { groupID:string }
interface CommentRow { id:string; entryID:string; authorUserID:string; authorName:string; body:string; createdAt:string }

const now=()=>new Date().toISOString();

async function entryScope(env:Env,entryID:string,userID:string):Promise<EntryScope> {
  const entry=await env.DB.prepare(`SELECT group_id AS groupID FROM entries
    WHERE id=? AND id NOT IN (SELECT entry_id FROM deleted_entries)`).bind(entryID).first<EntryScope>();
  if(!entry) throw new HTTPError(404,'Expense not found.');
  const seat=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(entry.groupID,userID).first();
  if(!seat) throw new HTTPError(403,'You are not a member of this group.');
  return entry;
}

async function groupSeat(env:Env,groupID:string,userID:string):Promise<string> {
  const group=await env.DB.prepare('SELECT id FROM groups WHERE id=?').bind(groupID).first();
  if(!group) throw new HTTPError(404,'Group not found.');
  const seat=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(groupID,userID).first<{id:string}>();
  if(!seat) throw new HTTPError(403,'You are not a member of this group.');
  return seat.id;
}

function comment(row:CommentRow,userID:string) {
  return {...row,mine:row.authorUserID===userID};
}

async function comments(env:Env,entryID:string,userID:string) {
  const rows=(await env.DB.prepare(`SELECT c.id,c.entry_id AS entryID,c.author AS authorUserID,
    COALESCE(NULLIF(trim(m.name),''),c.author_name) AS authorName,c.body,c.created_at AS createdAt
    FROM entry_comments c
    LEFT JOIN members m ON m.group_id=c.group_id AND m.user_id=c.author
    WHERE c.entry_id=? ORDER BY c.created_at,c.rowid`).bind(entryID).all<CommentRow>()).results;
  return {comments:rows.map(row=>comment(row,userID))};
}

async function addComment(env:Env,scope:EntryScope,entryID:string,userID:string,value:unknown) {
  const text=(value as Record<string,unknown>).body;
  if(typeof text!=='string' || !text.trim() || text.trim().length>2000) throw new InputError('Write a comment of up to 2,000 characters.');
  const seat=await env.DB.prepare('SELECT name FROM members WHERE group_id=? AND user_id=?').bind(scope.groupID,userID).first<{name:string}>();
  if(!seat) throw new HTTPError(403,'You are not a member of this group.');
  const row:CommentRow={id:crypto.randomUUID(),entryID,authorUserID:userID,authorName:seat.name.trim()||'Split member',body:text.trim(),createdAt:now()};
  // The guarded insert keeps a comment from surviving a concurrent entry deletion.
  const saved=await env.DB.prepare(`INSERT INTO entry_comments(id,entry_id,group_id,author,author_name,body,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM entries WHERE id=? AND id NOT IN (SELECT entry_id FROM deleted_entries))
      AND EXISTS (SELECT 1 FROM members WHERE group_id=? AND user_id=?)`)
    .bind(row.id,entryID,scope.groupID,userID,row.authorName,row.body,row.createdAt,entryID,scope.groupID,userID).run();
  if(!saved.meta.changes) throw new HTTPError(404,'Expense not found.');
  return json(comment(row,userID),201);
}

async function toggleLike(env:Env,entryID:string,userID:string) {
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO entry_reactions(entry_id,user_id,created_at) VALUES (?,?,?)')
    .bind(entryID,userID,now()).run();
  const liked=Boolean(inserted.meta.changes);
  if(!liked) await env.DB.prepare('DELETE FROM entry_reactions WHERE entry_id=? AND user_id=?').bind(entryID,userID).run();
  const count=await env.DB.prepare('SELECT count(*) AS n FROM entry_reactions WHERE entry_id=?').bind(entryID).first<{n:number}>();
  return json({liked,count:Number(count?.n??0)});
}

export function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 400) throw new InputError('Keep the description under 400 characters.');
  return value.trim() || null;
}

async function updateGroup(request:Request,env:Env,groupID:string,userID:string) {
  const b=await body(request);
  const group=await env.DB.prepare('SELECT name,kind,currency,simplify,description,start_date AS startDate,end_date AS endDate FROM groups WHERE id=?').bind(groupID).first<{name:string;kind:string;currency:string;simplify:number;description:string|null;startDate:string|null;endDate:string|null}>();
  if(!group) throw new HTTPError(404,'Group not found.');
  const currentKind=groupKind(group);
  const kind=b.kind ?? currentKind;
  if(kind!==currentKind && (currentKind==='friend' || (kind!=='trip' && kind!=='home')))
    throw new InputError('Choose Trip or Long-term / Home.');
  if(kind!==currentKind) await requireActiveMember(env,groupID,userID);
  let name=group.name,currency=group.currency,simplify=Number(group.simplify);
  let description=group.description, startDate=group.startDate, endDate=group.endDate;
  if(b.name!==undefined) {
    if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>80) throw new InputError('Give the group a name of up to 80 characters.');
    name=b.name.trim();
  }
  if(b.currency!==undefined) {
    if(typeof b.currency!=='string'||!currencies.includes(b.currency as typeof currencies[number])) throw new InputError('Choose a supported currency.');
    if(b.currency!==group.currency) {
      const used=await env.DB.prepare('SELECT count(*) AS n FROM entries WHERE group_id=?').bind(groupID).first<{n:number}>();
      if((used?.n??0)>0) throw new HTTPError(409,"Delete this group's expenses before changing its currency.");
      if(await env.DB.prepare("SELECT 1 FROM settlement_requests WHERE group_id=? AND status='pending' LIMIT 1").bind(groupID).first())
        throw new HTTPError(409,'Resolve pending payments before changing the group currency.');
      currency=b.currency;
    }
  }
  if(b.simplify!==undefined) {
    if(typeof b.simplify!=='boolean') throw new InputError('Choose whether to simplify payments.');
    simplify=b.simplify?1:0;
  }
  const nextDesc=optionalDescription(b.description);
  if(nextDesc!==undefined) description=nextDesc;
  const nextStart=optionalDay(b.startDate,'start date');
  if(nextStart!==undefined) startDate=nextStart;
  const nextEnd=optionalDay(b.endDate,'end date');
  if(nextEnd!==undefined) endDate=nextEnd;
  if(kind==='trip' && currentKind!=='trip' && (!startDate || !endDate)) throw new InputError('Choose a start and end date for the trip.');
  if(startDate && endDate && endDate < startDate) throw new InputError('End date must be on or after the start date.');
  await env.DB.prepare('UPDATE groups SET name=?,kind=?,currency=?,simplify=?,description=?,start_date=?,end_date=? WHERE id=?').bind(name,kind,currency,simplify,description,startDate,endDate,groupID).run();
  return json({ok:true});
}

async function listInvites(env:Env,groupID:string) {
  const nowMs=Date.now();
  const groupRows=(await env.DB.prepare('SELECT token_hash AS id, expires_at AS expiresAt FROM group_invites WHERE group_id=? AND expires_at>? ORDER BY expires_at DESC').bind(groupID,nowMs).all<{id:string;expiresAt:number}>()).results;
  const memberRows=(await env.DB.prepare(`SELECT i.token_hash AS id, i.member_id AS memberID, m.name AS memberName, i.expires_at AS expiresAt, i.recipient_email AS recipientEmail
    FROM invites i JOIN members m ON m.id=i.member_id LEFT JOIN member_aliases a ON a.member_id=m.id
    WHERE i.group_id=? AND i.expires_at>? AND m.removed_at IS NULL AND m.user_id IS NULL AND a.member_id IS NULL
    ORDER BY i.expires_at DESC`).bind(groupID,nowMs).all<{id:string;memberID:string;memberName:string;expiresAt:number;recipientEmail:string|null}>()).results;
  const directRows=(await env.DB.prepare(`SELECT d.id, d.member_id AS memberID, m.name AS memberName, p.name AS recipientName, d.expires_at AS expiresAt
    FROM direct_invites d JOIN split_profiles p ON p.user_id=d.recipient LEFT JOIN members m ON m.id=d.member_id AND m.group_id=d.group_id
    WHERE d.group_id=? AND d.expires_at>? AND NOT EXISTS (SELECT 1 FROM members x WHERE x.group_id=d.group_id AND x.user_id=d.recipient AND x.removed_at IS NULL)
    ORDER BY d.expires_at DESC`).bind(groupID,nowMs).all<{id:string;memberID:string|null;memberName:string|null;recipientName:string;expiresAt:number}>()).results;
  return json({
    invites:[
      ...groupRows.map(r=>({id:r.id,kind:'group' as const,memberID:null,memberName:null,expiresAt:r.expiresAt})),
      ...directRows.map(r=>({id:r.id,kind:'person' as const,memberID:r.memberID,memberName:r.memberName,recipientName:r.recipientName,expiresAt:r.expiresAt})),
      ...memberRows.map(r=>({id:r.id,kind:'member' as const,memberID:r.memberID,memberName:r.memberName,expiresAt:r.expiresAt,...(r.recipientEmail ? {recipientEmail:r.recipientEmail} : {})}))
    ]
  });
}

async function revokeInvite(env:Env,groupID:string,hash:string) {
  const [a,b,c]=await env.DB.batch([
    env.DB.prepare('DELETE FROM group_invites WHERE group_id=? AND token_hash=?').bind(groupID,hash),
    env.DB.prepare('DELETE FROM invites WHERE group_id=? AND token_hash=?').bind(groupID,hash),
    env.DB.prepare('DELETE FROM direct_invites WHERE group_id=? AND id=?').bind(groupID,hash)
  ]);
  if(!a.meta.changes && !b.meta.changes && !c.meta.changes) throw new HTTPError(404,'Invite not found.');
  return json({ok:true});
}

async function removeMember(request:Request,env:Env,groupID:string,targetID:string,callerSeat:string) {
  if(targetID===callerSeat) throw new InputError('Use Leave group to remove yourself.');
  const target=await env.DB.prepare('SELECT id FROM members WHERE id=? AND group_id=?').bind(targetID,groupID).first<{id:string}>();
  if(!target) throw new HTTPError(404,'Member not found.');
  const b=await body(request);
  const mode=b.mode===undefined ? 'archive' : b.mode;
  if(mode!=='archive' && mode!=='delete' && mode!=='restore') throw new InputError('Choose archive, delete, or restore.');
  if(mode==='restore') {
    await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=? AND group_id=?').bind(targetID,groupID).run();
    return json({ok:true,mode:'restore'});
  }
  if(mode==='archive') {
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET removed_at=? WHERE id=? AND group_id=?').bind(now(),targetID,groupID),
      env.DB.prepare('DELETE FROM invites WHERE member_id=? AND group_id=?').bind(targetID,groupID)
    ]);
    return json({ok:true,mode:'archive'});
  }
  const aliases=(await env.DB.prepare('SELECT member_id FROM member_aliases WHERE canonical_id=?').bind(targetID).all<{member_id:string}>()).results;
  const seats=new Set([targetID,...aliases.map(a=>a.member_id)]);
  const rows=(await env.DB.prepare(`SELECT payload FROM entries WHERE group_id=? AND
    (id NOT IN (SELECT entry_id FROM deleted_entries) OR id IN (SELECT source_id FROM active_expense_combination_sources))`).bind(groupID).all<{payload:string}>()).results;
  const used=rows.some(r=>{
    const e=JSON.parse(r.payload) as {paidBy:string;payers?:{memberID:string}[];splits:{memberID:string}[];bill?:{items:{memberIDs:string[]}[]}};
    return seats.has(e.paidBy) || e.payers?.some(p=>seats.has(p.memberID)) || e.splits.some(s=>seats.has(s.memberID)) || e.bill?.items.some(i=>i.memberIDs.some(id=>seats.has(id)));
  });
  if(used) throw new HTTPError(409,'This person has expenses in the group. Retain them as an archived entity to keep balances accurate.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM member_aliases WHERE member_id=? OR canonical_id=?').bind(targetID,targetID),
    env.DB.prepare('DELETE FROM member_contacts WHERE member_id=?').bind(targetID),
    env.DB.prepare('DELETE FROM payment_profiles WHERE member_id=?').bind(targetID),
    env.DB.prepare('DELETE FROM invites WHERE member_id=?').bind(targetID),
    env.DB.prepare('DELETE FROM members WHERE id=? AND group_id=?').bind(targetID,groupID)
  ]);
  return json({ok:true,mode:'delete'});
}

async function updateAvatar(request:Request,env:Env,userID:string) {
  const b=await body(request,200_000);
  const avatar=b.avatarURL===null || b.avatarURL==='' ? null : typeof b.avatarURL==='string' ? b.avatarURL.trim() : undefined;
  if(avatar===undefined) throw new InputError('Provide an avatar URL or empty value to reset.');
  if(avatar!==null) {
    const validPreset=/^preset:[a-z0-9-]{2,32}$/.test(avatar);
    const validHttps=/^https:\/\/[^\s]{5,500}$/.test(avatar);
    const validData=/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]{16,180000}$/.test(avatar);
    if(!validPreset && !validHttps && !validData) throw new InputError('Choose a valid avatar image or preset.');
  }
  await env.DB.prepare(`INSERT INTO user_avatars(user_id,avatar_url,updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`)
    .bind(userID,avatar,now()).run();
  return json({ok:true,avatarURL:avatar});
}

async function archiveGroup(request:Request,env:Env,groupID:string) {
  const b=await body(request);
  if(typeof b.archived!=='boolean') throw new InputError('Choose whether to archive this group.');
  await env.DB.prepare('UPDATE groups SET archived_at=? WHERE id=?').bind(b.archived?now():null,groupID).run();
  return json({ok:true});
}

async function leaveGroup(env:Env,groupID:string,seatID:string) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM member_aliases WHERE member_id=? OR canonical_id=?').bind(seatID,seatID),
    env.DB.prepare('DELETE FROM member_contacts WHERE member_id=?').bind(seatID),
    env.DB.prepare('DELETE FROM payment_profiles WHERE member_id=?').bind(seatID),
    env.DB.prepare('DELETE FROM invites WHERE member_id=?').bind(seatID),
    env.DB.prepare('DELETE FROM members WHERE id=? AND group_id=?').bind(seatID,groupID)
  ]);
  await env.DB.prepare('DELETE FROM groups WHERE id=? AND NOT EXISTS (SELECT 1 FROM members WHERE group_id=?)').bind(groupID,groupID).run();
  return json({ok:true});
}

export interface DeleteExpectation { name: string; members: { id: string; name: string }[]; expenses: number; settlements: number; receipts: number }

// The HTTP route passes no expectation. The CLI passes what its preview showed, checked in the same statement as the delete.
export async function deleteGroup(env:Env,groupID:string,userID:string,expected?:DeleteExpectation) {
  const creator=`id=? AND creator=? AND EXISTS (
    SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL
  )`;
  const args:unknown[]=[groupID,userID,groupID,userID];
  let guard='';
  if(expected) {
    const live='SELECT id,payload FROM entries WHERE group_id=? AND id NOT IN (SELECT entry_id FROM deleted_entries)';
    guard=` AND name=?
      AND (SELECT json_group_array(json_array(id,name)) FROM (SELECT id,name FROM members WHERE group_id=? AND removed_at IS NULL
        AND id NOT IN (SELECT member_id FROM member_aliases) ORDER BY rowid))=json(?)
      AND (SELECT count(*) FROM (${live}) WHERE json_extract(payload,'$.kind')='expense')=?
      AND (SELECT count(*) FROM (${live}) WHERE json_extract(payload,'$.kind')='settlement')=?
      AND (SELECT count(*) FROM expense_receipts WHERE entry_id IN (SELECT id FROM (${live})))=?`;
    args.push(expected.name,groupID,JSON.stringify(expected.members.map(m=>[m.id,m.name])),
      groupID,expected.expenses,groupID,expected.settlements,groupID,expected.receipts);
  }
  const result=await env.DB.prepare(`DELETE FROM groups WHERE ${creator}${guard}`).bind(...args).run();
  if(result.meta.changes) return json({ok:true});
  if(guard && await env.DB.prepare(`SELECT 1 FROM groups WHERE ${creator}`).bind(groupID,userID,groupID,userID).first())
    throw new HTTPError(409,'This group changed since you reviewed it. Review a fresh preview before deleting.');
  throw new HTTPError(403,'Only the active group creator can delete this group.');
}

export async function socialRoute(request:Request,env:Env,userID:string):Promise<Response|undefined> {
  const path=new URL(request.url).pathname;
  const chargeHistory=path.match(/^\/v1\/entries\/([\w-]+)\/charged-amount-history$/);
  if(chargeHistory && request.method==='GET') {
    const entryID=chargeHistory[1];
    await entryScope(env,entryID,userID);
    const {results}=await env.DB.prepare(`SELECT id,previous_currency AS previousCurrency,previous_amount AS previousAmount,
      charged_currency AS chargedCurrency,charged_amount AS chargedAmount,changed_at AS changedAt
      FROM charged_amount_history WHERE entry_id=? ORDER BY id DESC LIMIT 100`).bind(entryID).all();
    return json({history:results});
  }
  const commentMatch=path.match(/^\/v1\/entries\/([\w-]+)\/comments(?:\/([\w-]+))?$/);
  if(commentMatch) {
    const [,entryID,commentID]=commentMatch;
    const scope=await entryScope(env,entryID,userID);
    if(!commentID && request.method==='GET') return json(await comments(env,entryID,userID));
    if(!commentID && request.method==='POST') return addComment(env,scope,entryID,userID,await body(request));
    if(commentID && (request.method==='DELETE'||request.method==='POST')) {
      const saved=await env.DB.prepare('SELECT author FROM entry_comments WHERE id=? AND entry_id=?').bind(commentID,entryID).first<{author:string}>();
      if(!saved) throw new HTTPError(404,'Comment not found.');
      if(saved.author!==userID) throw new HTTPError(403,'Only the author can delete this comment.');
      await env.DB.prepare('DELETE FROM entry_comments WHERE id=? AND entry_id=?').bind(commentID,entryID).run();
      return json({ok:true});
    }
    throw new HTTPError(404,'Not found.');
  }
  const likeMatch=path.match(/^\/v1\/entries\/([\w-]+)\/like$/);
  if(likeMatch) {
    if(request.method!=='POST') throw new HTTPError(404,'Not found.');
    await entryScope(env,likeMatch[1],userID);
    return toggleLike(env,likeMatch[1],userID);
  }
  if(path==='/v1/profile/avatar' && request.method==='POST') {
    return updateAvatar(request,env,userID);
  }
  const inviteListMatch=path.match(/^\/v1\/groups\/([\w-]+)\/invites$/);
  if(inviteListMatch && request.method==='GET') {
    await requireActiveMember(env,inviteListMatch[1],userID);
    return listInvites(env,inviteListMatch[1]);
  }
  const inviteRevokeMatch=path.match(/^\/v1\/groups\/([\w-]+)\/invites\/([a-f0-9]{64})\/revoke$/);
  if(inviteRevokeMatch && request.method==='POST') {
    await requireActiveMember(env,inviteRevokeMatch[1],userID);
    return revokeInvite(env,inviteRevokeMatch[1],inviteRevokeMatch[2]);
  }
  const memberRemoveMatch=path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/remove$/);
  if(memberRemoveMatch && request.method==='POST') {
    const callerSeat=await groupSeat(env,memberRemoveMatch[1],userID);
    return removeMember(request,env,memberRemoveMatch[1],memberRemoveMatch[2],callerSeat);
  }
  const groupMatch=path.match(/^\/v1\/groups\/([\w-]+)\/(update|archive|leave|delete)$/);
  if(groupMatch) {
    if(request.method!=='POST') throw new HTTPError(404,'Not found.');
    const [,groupID,action]=groupMatch;
    if(action==='delete') return deleteGroup(env,groupID,userID);
    const seat=await groupSeat(env,groupID,userID);
    if(action==='update') return updateGroup(request,env,groupID,userID);
    if(action==='archive') return archiveGroup(request,env,groupID);
    return leaveGroup(env,groupID,seat);
  }
  return undefined;
}
