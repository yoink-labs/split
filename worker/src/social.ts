import { HTTPError, body, json } from './http';
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
    COALESCE(NULLIF(trim(p.name),''),c.author_name) AS authorName,c.body,c.created_at AS createdAt
    FROM entry_comments c LEFT JOIN split_profiles p ON p.user_id=c.author
    WHERE c.entry_id=? ORDER BY c.created_at,c.rowid`).bind(entryID).all<CommentRow>()).results;
  return {comments:rows.map(row=>comment(row,userID))};
}

async function addComment(env:Env,scope:EntryScope,entryID:string,userID:string,value:unknown) {
  const text=(value as Record<string,unknown>).body;
  if(typeof text!=='string' || !text.trim() || text.trim().length>2000) throw new InputError('Write a comment of up to 2,000 characters.');
  const profile=await env.DB.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(userID).first<{name:string}>();
  const row:CommentRow={id:crypto.randomUUID(),entryID,authorUserID:userID,authorName:profile?.name?.trim()||'Split member',body:text.trim(),createdAt:now()};
  // The guarded insert keeps a comment from surviving a concurrent entry deletion.
  const saved=await env.DB.prepare(`INSERT INTO entry_comments(id,entry_id,group_id,author,author_name,body,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM entries WHERE id=? AND id NOT IN (SELECT entry_id FROM deleted_entries))`)
    .bind(row.id,entryID,scope.groupID,userID,row.authorName,row.body,row.createdAt,entryID).run();
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

async function updateGroup(request:Request,env:Env,groupID:string) {
  const b=await body(request);
  const group=await env.DB.prepare('SELECT name,currency,simplify FROM groups WHERE id=?').bind(groupID).first<{name:string;currency:string;simplify:number}>();
  if(!group) throw new HTTPError(404,'Group not found.');
  let name=group.name,currency=group.currency,simplify=Number(group.simplify);
  if(b.name!==undefined) {
    if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>80) throw new InputError('Give the group a name of up to 80 characters.');
    name=b.name.trim();
  }
  if(b.currency!==undefined) {
    if(typeof b.currency!=='string'||!currencies.includes(b.currency as typeof currencies[number])) throw new InputError('Choose a supported currency.');
    if(b.currency!==group.currency) {
      const used=await env.DB.prepare('SELECT count(*) AS n FROM entries WHERE group_id=?').bind(groupID).first<{n:number}>();
      if((used?.n??0)>0) throw new HTTPError(409,"Delete this group's expenses before changing its currency.");
      currency=b.currency;
    }
  }
  if(b.simplify!==undefined) {
    if(typeof b.simplify!=='boolean') throw new InputError('Choose whether to simplify payments.');
    simplify=b.simplify?1:0;
  }
  await env.DB.prepare('UPDATE groups SET name=?,currency=?,simplify=? WHERE id=?').bind(name,currency,simplify,groupID).run();
  return json({ok:true});
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
  const remaining=await env.DB.prepare('SELECT count(*) AS n FROM members WHERE group_id=?').bind(groupID).first<{n:number}>();
  if(!remaining?.n) await env.DB.batch([
    env.DB.prepare('DELETE FROM entry_comments WHERE entry_id IN (SELECT id FROM entries WHERE group_id=?)').bind(groupID),
    env.DB.prepare('DELETE FROM entry_reactions WHERE entry_id IN (SELECT id FROM entries WHERE group_id=?)').bind(groupID),
    env.DB.prepare('DELETE FROM receipts WHERE entry_id IN (SELECT id FROM entries WHERE group_id=?)').bind(groupID),
    env.DB.prepare('DELETE FROM recurring WHERE entry_id IN (SELECT id FROM entries WHERE group_id=?)').bind(groupID),
    env.DB.prepare('DELETE FROM deleted_entries WHERE entry_id IN (SELECT id FROM entries WHERE group_id=?)').bind(groupID),
    env.DB.prepare('DELETE FROM entries WHERE group_id=?').bind(groupID),
    env.DB.prepare('DELETE FROM invites WHERE group_id=?').bind(groupID),
    env.DB.prepare('DELETE FROM group_invites WHERE group_id=?').bind(groupID),
    env.DB.prepare('DELETE FROM group_splits WHERE group_id=?').bind(groupID),
    env.DB.prepare('DELETE FROM members WHERE group_id=?').bind(groupID),
    env.DB.prepare('DELETE FROM groups WHERE id=?').bind(groupID)
  ]);
  return json({ok:true});
}

export async function socialRoute(request:Request,env:Env,userID:string):Promise<Response|undefined> {
  const path=new URL(request.url).pathname;
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
  const groupMatch=path.match(/^\/v1\/groups\/([\w-]+)\/(update|archive|leave)$/);
  if(groupMatch) {
    if(request.method!=='POST') throw new HTTPError(404,'Not found.');
    const [,groupID,action]=groupMatch;
    const seat=await groupSeat(env,groupID,userID);
    if(action==='update') return updateGroup(request,env,groupID);
    if(action==='archive') return archiveGroup(request,env,groupID);
    return leaveGroup(env,groupID,seat);
  }
  return undefined;
}
