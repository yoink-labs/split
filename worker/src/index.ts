import { createRemoteJWKSet, jwtVerify } from 'jose';
import { currencies, InputError, validID, validateEntry } from './ledger';
const jwks = createRemoteJWKSet(new URL('https://clerk.yoinklabs.dev/.well-known/jwks.json'));
class HTTPError extends Error { constructor(public status: number, message: string) { super(message); } }
interface Member {id:string; groupID:string; userID:string|null; name:string}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function body(request:Request):Promise<Record<string,unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HTTPError(415,'Send JSON.');
  const reader=request.body?.getReader(); if(!reader) throw new InputError('Missing body.');
  let size=0; const chunks:Uint8Array[]=[];
  while(true){ const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>32_768){await reader.cancel();throw new HTTPError(413,'Request too large.');} chunks.push(value); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try { const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value; } catch {throw new InputError('Invalid JSON.');}
}
async function member(env:Env,groupID:string,userID:string) {
  const row=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(groupID,userID).first();
  if(!row) throw new HTTPError(403,'You are not a member of this group.');
}
async function members(env:Env,groupID:string):Promise<Member[]> {return (await env.DB.prepare('SELECT id, group_id AS groupID, user_id AS userID, name FROM members WHERE group_id=? ORDER BY id').bind(groupID).all<Member>()).results;}
const hash=async(token:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
export async function handle(request:Request,env:Env,userID:string):Promise<Response> {
  const url=new URL(request.url), path=url.pathname;
  if(path==='/v1/snapshot' && request.method==='GET') {
    const groups=(await env.DB.prepare('SELECT g.id,g.name,g.kind,g.currency,g.created_at AS createdAt FROM groups g JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC LIMIT 101').bind(userID).all()).results;
    if(groups.length>100) throw new HTTPError(409,'This beta supports up to 100 groups.');
    const all=await Promise.all(groups.map(async g=>({...g,members:await members(env,String(g.id))})));
    const entries=(await env.DB.prepare('SELECT e.payload FROM entries e JOIN members m ON m.group_id=e.group_id WHERE m.user_id=? ORDER BY e.created_at DESC LIMIT 5001').bind(userID).all<{payload:string}>()).results;
    if(entries.length>5000)throw new HTTPError(409,'This beta supports up to 5,000 entries. Export support is coming.');
    return json({groups:all,entries:entries.map(e=>JSON.parse(e.payload))});
  }
  if(path==='/v1/groups' && request.method==='POST') {
    const b=await body(request);
    const m=b.members as Member[];
    if(!validID(b.id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['trip','home','friend'].includes(String(b.kind))||!currencies.includes(b.currency as typeof currencies[number])||!Array.isArray(m)||m.length<1||m.length>50||new Set(m.map(x=>x.id)).size!==m.length||m.some(x=>!validID(x.id)||typeof x.name!=='string'||!x.name.trim()||x.name.length>60)||m.filter(x=>x.userID===userID).length!==1||m.some(x=>x.userID && x.userID!==userID)) throw new InputError('Check the group and its members.');
    const existing=await env.DB.prepare('SELECT creator FROM groups WHERE id=?').bind(b.id).first<{creator:string}>();
    if(existing){ if(existing.creator!==userID)throw new HTTPError(409,'Group ID already used.'); return json({ok:true}); }
    const count=await env.DB.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').bind(userID).first<{n:number}>();if((count?.n??0)>=100)throw new HTTPError(409,'Group limit reached.');
    await env.DB.batch([env.DB.prepare('INSERT INTO groups VALUES (?,?,?,?,?,?)').bind(b.id,b.name.trim(),b.kind,b.currency,userID,new Date().toISOString()),...m.map(x=>env.DB.prepare('INSERT INTO members VALUES (?,?,?,?)').bind(x.id,b.id,x.userID||null,x.name.trim()))]);
    return json({ok:true},201);
  }
  if(path==='/v1/entries' && request.method==='POST') {
    const b=await body(request); if(!validID(b.groupID)) throw new InputError('Invalid group.');
    await member(env,b.groupID,userID);
    const e=validateEntry(b,(await members(env,b.groupID)).map(m=>m.id)), payload=JSON.stringify(e);
    // DO NOTHING is safe under concurrent retries; compare after insertion.
    await env.DB.prepare('INSERT INTO entries VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(e.id,e.groupID,userID,payload,new Date().toISOString()).run();
    const saved=await env.DB.prepare('SELECT author,payload FROM entries WHERE id=?').bind(e.id).first<{author:string;payload:string}>();
    if(saved?.author!==userID||saved.payload!==payload)throw new HTTPError(409,'An entry already uses this ID.');
    return json({ok:true});
  }
  const inviteMatch=path.match(/^\/v1\/groups\/([\w-]+)\/invites$/);
  if(inviteMatch && request.method==='POST') {
    const groupID=inviteMatch[1];await member(env,groupID,userID);const b=await body(request);
    const seat=(await members(env,groupID)).find(m=>m.id===b.memberID && m.userID===null);
    if(!seat)throw new InputError('Choose an unclaimed member to invite.');
    const token=crypto.randomUUID()+crypto.randomUUID(), digest=await hash(token);
    await env.DB.batch([env.DB.prepare('DELETE FROM invites WHERE member_id=?').bind(seat.id),env.DB.prepare('INSERT INTO invites VALUES (?,?,?,?)').bind(digest,groupID,seat.id,Date.now()+7*86400000)]);
    return json({url:`${env.APP_URL}/join/${token}`});
  }
  if(path==='/v1/join' && request.method==='POST') {
    const b=await body(request);if(typeof b.token!=='string'||b.token.length>100)throw new InputError('Invalid invite.');
    const invite=await env.DB.prepare('SELECT group_id,member_id FROM invites WHERE token_hash=? AND expires_at>?').bind(await hash(b.token),Date.now()).first<{group_id:string;member_id:string}>();
    if(!invite)throw new HTTPError(404,'This invite expired. Ask for a new link.');
    const already=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(invite.group_id,userID).first<{id:string}>();
    if(already){if(already.id===invite.member_id)return json({ok:true});throw new HTTPError(409,'You already belong to this group.');}
    const update=await env.DB.prepare('UPDATE members SET user_id=? WHERE id=? AND user_id IS NULL').bind(userID,invite.member_id).run();
    if(!update.meta.changes)throw new HTTPError(409,'This invitation has already been claimed.');
    return json({ok:true});
  }
  throw new HTTPError(404,'Not found.');
}
export default {
 async fetch(request,env):Promise<Response> {
  try {
   const url=new URL(request.url);
   if(url.pathname==='/health')return json({service:'split-api',status:'ok'});
   if(url.pathname==='/.well-known/apple-app-site-association') return json({applinks:{details:[{appIDs:['64PUT29XZ8.com.yoinklabs.split'],components:[{'/':'/join/*'}]}]}});
   const invite=url.pathname.match(/^\/join\/([a-f0-9-]{72})$/);
   if(invite && request.method==='GET') return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join your group · Split</title><style>body{font:20px system-ui;background:#f4f3ee;color:#172e27;max-width:480px;margin:5vh auto;padding:28px}a{display:block;background:#183f34;color:white;padding:18px;border-radius:18px;text-align:center;text-decoration:none}p{line-height:1.6}@media(prefers-color-scheme:dark){body{background:#101b17;color:#edf3ea}}</style><svg role="img" aria-label="Split logo" width="72" height="72" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="240" fill="#d1f091"/><g fill="#12382b"><rect x="222" y="340" width="580" height="142" rx="71"/><rect x="222" y="542" width="580" height="142" rx="71"/></g><path d="M518 744H622L506 280H402Z" fill="#d1f091"/></svg><h1>Good company.<br>Clear balances.</h1><p>You have an invitation to Split. Open it on your iPhone after installing the free TestFlight beta.</p><a href="com.yoinklabs.split://join/${invite[1]}">Open Split</a><p><a href="https://testflight.apple.com/join/YX8W6bCx">Get the free beta</a></p><p>If the app is not installed yet, keep this invitation and open it again after installing. Beta access becomes available after Apple approves the build.</p>`,{headers:{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}});
   const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];if(!token)throw new HTTPError(401,'Sign in to sync your expenses.');
   let userID:string;
   try{const {payload}=await jwtVerify(token,jwks,{issuer:env.CLERK_ISSUER,algorithms:['RS256'],requiredClaims:['exp','sub','iat']});if(!payload.sub || (payload.azp && !['com.yoinklabs.split','https://yoinklabs.dev','https://www.yoinklabs.dev'].includes(String(payload.azp))))throw 0;userID=payload.sub;}catch{throw new HTTPError(401,'Your session expired. Sign in again.');}
   return await handle(request,env,userID);
  }catch(error){if(error instanceof HTTPError)return json({error:error.message},error.status);if(error instanceof InputError)return json({error:error.message},422);console.error(JSON.stringify({event:'request_failed',type:error instanceof Error?error.name:'unknown'}));return json({error:'Could not save this change. Please retry.'},500);}
 }
} satisfies ExportedHandler<Env>;
