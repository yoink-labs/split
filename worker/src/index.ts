import {groupTools,generateRecurring} from './groupTools';
import { purchaseRoute, attachments } from './receipts';
import { socialRoute } from './social';
import { claimSeat, lookup, refreshIdentity, resolveEntry } from './people';
import { HTTPError, json, body } from './http';
import { deviceRoute, deviceIdentity, manageDevices } from './cli/devices';
import { cliRoute } from './cli/routes';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { currencies, InputError, validID, validateEntry } from './ledger';
const jwks = createRemoteJWKSet(new URL('https://clerk.yoinklabs.dev/.well-known/jwks.json'));
interface Member {id:string; groupID:string; userID:string|null; name:string; email?:string; phone?:string;payment?:string}
export function validParty(azp: unknown, webOrigin: string) {
  return azp === undefined || (typeof azp === 'string' && [webOrigin, 'com.yoinklabs.split', 'https://yoinklabs.dev', 'https://www.yoinklabs.dev'].includes(azp));
}
function contactInfo(emailInput:unknown,phoneInput:unknown) {
    const email=typeof emailInput==='string' ? emailInput.trim().toLowerCase() : '';
    const phone=typeof phoneInput==='string' ? phoneInput.trim() : '';
    if ((email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254)) || (phone && !/^[+0-9() .-]{3,32}$/.test(phone))) throw new InputError('Check the email address or phone number.');
    return {email,phone};
}
async function member(env:Env,groupID:string,userID:string) {
  const row=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(groupID,userID).first();
  if(!row) throw new HTTPError(403,'You are not a member of this group.');
}
async function members(env:Env,groupID:string):Promise<Member[]> {return (await env.DB.prepare('SELECT id, group_id AS groupID, user_id AS userID, name FROM members WHERE group_id=? ORDER BY id').bind(groupID).all<Member>()).results;}
const hash=async(token:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
export async function handle(request:Request,env:Env,userID:string):Promise<Response> {
  const url=new URL(request.url), path=url.pathname;
  const extra=await groupTools(request,env,userID);
  if(extra) return extra;
  const purchase=await purchaseRoute(request,env,userID);
  if(purchase) return purchase;
  const social=await socialRoute(request,env,userID);
  if(social) return social;
  if(path==='/v1/snapshot' && request.method==='GET') {
    const groups=(await env.DB.prepare('SELECT g.id,g.name,g.kind,g.currency,g.simplify,g.archived_at AS archivedAt,(SELECT weights FROM group_splits WHERE group_id=g.id) AS weights,g.created_at AS createdAt FROM groups g JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC LIMIT 101').bind(userID).all<{id:string;name:string;kind:string;currency:string;simplify:number;archivedAt:string|null;weights:string|null;createdAt:string}>()).results;
    if(groups.length>100) throw new HTTPError(409,'This beta supports up to 100 groups.');
    const aliases = new Map((await env.DB.prepare(`SELECT a.member_id, a.canonical_id FROM member_aliases a
      JOIN members m ON m.id=a.canonical_id JOIN members viewer ON viewer.group_id=m.group_id WHERE viewer.user_id=?`)
      .bind(userID).all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
    const visible=(await env.DB.prepare(`SELECT m.id,m.group_id AS groupID,m.user_id AS userID,m.name,(SELECT details FROM payment_profiles WHERE member_id=m.id) AS payment FROM members m
      JOIN members viewer ON viewer.group_id=m.group_id WHERE viewer.user_id=? ORDER BY m.rowid`).bind(userID).all<Member>()).results;
    const all=groups.map(({weights,simplify,archivedAt,...g})=>{
      const defaults:Record<string,number>={};
      for(const [id,w] of Object.entries(JSON.parse(String(weights??'{}')) as Record<string,number>)) {
        const key=aliases.get(id)??id;defaults[key]=(defaults[key]??0)+w;
      }
      return {...g,simplify:Boolean(simplify),archived:Boolean(archivedAt),defaultWeights:defaults,members:visible.filter(m=>m.groupID===g.id && !aliases.has(m.id)).map(({payment,...m})=>({...m,payment:JSON.parse(payment??'{}')}))};
    });
    const entries=(await env.DB.prepare(`SELECT e.payload,e.author,(SELECT cadence FROM recurring WHERE entry_id=e.id) AS recurrence,
      (SELECT json_group_array(id) FROM receipts WHERE entry_id=e.id) AS photos,
      (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id) AS commentCount,
      (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id) AS likeCount,
      EXISTS(SELECT 1 FROM entry_reactions v WHERE v.entry_id=e.id AND v.user_id=?) AS likedByMe
      FROM entries e JOIN members m ON m.group_id=e.group_id
      WHERE m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries) ORDER BY e.created_at DESC LIMIT 5001`)
      .bind(userID,userID).all<{payload:string;author:string;recurrence:string|null;photos:string;commentCount:number;likeCount:number;likedByMe:number}>()).results;
    if(entries.length>5000)throw new HTTPError(409,'This beta supports up to 5,000 entries. Export support is coming.');
    return json({userID,groups:all,entries:entries.map(e=>({...resolveEntry(JSON.parse(e.payload),aliases), recurrence:e.recurrence,receiptIDs:JSON.parse(e.photos),editable:e.author===userID,
      commentCount:Number(e.commentCount),likeCount:Number(e.likeCount),likedByMe:Boolean(e.likedByMe)}))});
  }
  if(path==='/v1/groups' && request.method==='POST') {
    const b=await body(request);
    const m=b.members as Member[];
    if(!validID(b.id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['trip','home','friend'].includes(String(b.kind))||!currencies.includes(b.currency as typeof currencies[number])||!Array.isArray(m)||m.length<1||m.length>50||m.some(x=>!x || typeof x!=='object')||new Set(m.map(x=>x.id)).size!==m.length||m.some(x=>!validID(x.id)||typeof x.name!=='string'||!x.name.trim()||x.name.length>60)||m.filter(x=>x.userID===userID).length!==1) throw new InputError('Check the group and its members.');
    const existing=await env.DB.prepare('SELECT creator FROM groups WHERE id=?').bind(b.id).first<{creator:string}>();
    if(existing){ if(existing.creator!==userID)throw new HTTPError(409,'Group ID already used.'); return json({ok:true}); }
    const count=await env.DB.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').bind(userID).first<{n:number}>();if((count?.n??0)>=100)throw new HTTPError(409,'Group limit reached.');
    const inserts=[env.DB.prepare('INSERT INTO groups(id,name,kind,currency,creator,created_at) VALUES (?,?,?,?,?,?)').bind(b.id,b.name.trim(),b.kind,b.currency,userID,new Date().toISOString())];
    for (const person of m) {
      let name=person.name.trim();
      if (person.userID && person.userID!==userID) {
        const profile=await env.DB.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(person.userID).first<{name:string}>();
        if (!profile) throw new InputError('Choose an existing Split user.');
        name=profile.name;
      }
      inserts.push(env.DB.prepare('INSERT INTO members VALUES (?,?,?,?)').bind(person.id,b.id,person.userID||null,name));
      const contact=contactInfo(person.email,person.phone);
      if (!person.userID && (contact.email || contact.phone))
        inserts.push(env.DB.prepare('INSERT INTO member_contacts VALUES (?,?,?)').bind(person.id,contact.email||null,contact.phone||null));
    }
    await env.DB.batch(inserts);
    return json({ok:true},201);
  }
  if(path==='/v1/entries' && request.method==='POST') {
    const b=await body(request,1_350_000); if(!validID(b.groupID)) throw new InputError('Invalid group.');
    await member(env,b.groupID,userID);
    const e=validateEntry(b,(await members(env,b.groupID)).map(m=>m.id)), payload=JSON.stringify(e);
    if(e.bill?.closed) throw new InputError('New receipts start open.');
    if(e.exchange && e.exchange.target!==await env.DB.prepare('SELECT currency FROM groups WHERE id=?').bind(e.groupID).first('currency')) throw new InputError('Use the group settlement currency.');
    // DO NOTHING is safe under concurrent retries; compare after insertion.
    await env.DB.batch([env.DB.prepare('INSERT INTO entries VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(e.id,e.groupID,userID,payload,new Date().toISOString()), ...attachments(env.DB,e,userID,payload,b.photos)]);
    const saved=await env.DB.prepare('SELECT author,payload FROM entries WHERE id=?').bind(e.id).first<{author:string;payload:string}>();
    if(saved?.author!==userID||saved.payload!==payload)throw new HTTPError(409,'An entry already uses this ID.');
    return json({ok:true});
  }
  if (path==='/v1/people/search' && request.method==='POST') {
    return json(await lookup(env.DB,userID,(await body(request)).query));
  }
  const revise=path.match(/^\/v1\/entries\/([\w-]+)\/(edit|delete)$/);
  if (revise && request.method==='POST') {
    const b=await body(request,1_350_000);
    const saved=await env.DB.prepare('SELECT group_id,author,payload FROM entries WHERE id=?').bind(revise[1]).first<{group_id:string;author:string;payload:string}>();
    if (!saved || saved.author!==userID) throw new HTTPError(403,'Only the person who recorded this entry can change it.');
    await member(env,saved.group_id,userID);
    const old=JSON.parse(saved.payload);
    const deleted=await env.DB.prepare('SELECT entry_id FROM deleted_entries WHERE entry_id=?').bind(revise[1]).first();
    const deleting=revise[2]==='delete';
    if (deleted) {
      if (deleting) return json({ok:true});
      throw new HTTPError(409,'This entry has been deleted.');
    }
    const ids=(await members(env,saved.group_id)).map(m=>m.id);
      const aliases=new Map((await env.DB.prepare('SELECT member_id,canonical_id FROM member_aliases JOIN members ON members.id=member_id WHERE group_id=?')
        .bind(saved.group_id).all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
    const canonical=resolveEntry(old,aliases);
    let payload: string | undefined;
    if (!deleting) {
      const updated=validateEntry(b.entry,ids,canonical.bill);
      if(updated.id!==revise[1] || updated.groupID!==saved.group_id || updated.createdAt!==old.createdAt || updated.kind!==old.kind)
        throw new InputError('Invalid edit.');
      if(updated.exchange && updated.exchange.target!==await env.DB.prepare('SELECT currency FROM groups WHERE id=?').bind(saved.group_id).first('currency')) throw new InputError('Use the group settlement currency.');
      if((updated.exchange || updated.bill) && await env.DB.prepare('SELECT 1 FROM recurring WHERE entry_id=?').bind(updated.id).first()) throw new InputError('Stop the recurring schedule before itemizing or converting this expense.');
      payload=JSON.stringify(updated);
      if(updated.bill?.closed && !old.bill?.closed) throw new InputError('Use the payer close action.');
      if(old.bill?.closed && (updated.paidBy!==canonical.paidBy || JSON.stringify(updated.bill)!==JSON.stringify(canonical.bill))) throw new InputError('This receipt is closed.');
      if (old.bill && !updated.bill) throw new InputError('Keep the receipt items when editing this expense.');
      if(old.bill && old.bill.closed!==updated.bill?.closed) throw new InputError('Use the payer close action.');
      if (saved.payload===payload && !b.photos) return json({ok:true});
    }
    const conditional=!deleting || b.original!==undefined;
    if (conditional) {
      const original=validateEntry(b.original,ids,canonical.bill);
      if (JSON.stringify(original)!==JSON.stringify(canonical)) throw new HTTPError(409,'This entry changed. Refresh and try again.');
    }
    const statement=deleting
      ? await env.DB.prepare('INSERT OR IGNORE INTO deleted_entries SELECT id FROM entries WHERE id=? AND (?=0 OR payload=?)')
        .bind(revise[1],Number(conditional),saved.payload)
      : await env.DB.prepare('UPDATE entries SET payload=? WHERE id=? AND payload=? AND id NOT IN (SELECT entry_id FROM deleted_entries)')
        .bind(payload!,revise[1],saved.payload);
    const [result]=await env.DB.batch([statement,...(deleting?[]:attachments(env.DB,JSON.parse(payload!),userID,payload!,b.photos))]);
    if (!result.meta.changes && !(deleting && await env.DB.prepare('SELECT entry_id FROM deleted_entries WHERE entry_id=?').bind(revise[1]).first()))
      throw new HTTPError(409,'This entry changed. Refresh and try again.');
    return json({ok:true});
  }
  const addMember=path.match(/^\/v1\/groups\/([\w-]+)\/members$/);
  if (addMember && request.method==='POST') {
    const groupID=addMember[1];
    await member(env,groupID,userID);
    const b=await body(request);
    if(!validID(b.id)) throw new InputError('Invalid member.');
    const name=typeof b.name==='string' ? b.name.trim() : '';
    if (!name || name.length>60) throw new InputError('Enter a name of up to 60 characters.');
    const {email,phone}=contactInfo(b.email,b.phone);
    const target=b.userID ? await env.DB.prepare('SELECT user_id,name FROM split_profiles WHERE user_id=?').bind(String(b.userID)).first<{user_id:string;name:string}>() : null;
    if (b.userID && !target) throw new InputError('Choose a Split user from search results.');
    const existing=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND (id=? OR user_id=?)').bind(groupID,b.id,target?.user_id??null).first<{id:string}>();
    if (existing) return json({id:existing.id});
    await env.DB.batch([
      env.DB.prepare('INSERT INTO members VALUES (?,?,?,?)').bind(b.id,groupID,target?.user_id??null,target?.name??name),
      ...(email || phone ? [env.DB.prepare('INSERT INTO member_contacts VALUES (?,?,?)').bind(b.id,email||null,phone||null)] : [])
    ]);
    return json({id:b.id},201);
  }
  const inviteMatch=path.match(/^\/v1\/groups\/([\w-]+)\/invites$/);
  if(inviteMatch && request.method==='POST') {
    const groupID=inviteMatch[1];await member(env,groupID,userID);const b=await body(request);
    const code=Array.from(crypto.getRandomValues(new Uint8Array(12)), n=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n%32]).join('');
    const digest=await hash(code), expiry=Date.now()+7*86400000;
    if (b.memberID) {
      const seat=await env.DB.prepare('SELECT id FROM members WHERE id=? AND group_id=? AND user_id IS NULL AND id NOT IN (SELECT member_id FROM member_aliases)')
        .bind(b.memberID,groupID).first<{id:string}>();
      if(!seat)throw new InputError('Choose an unclaimed member to invite.');
      await env.DB.batch([env.DB.prepare('DELETE FROM invites WHERE member_id=?').bind(seat.id),env.DB.prepare('INSERT INTO invites VALUES (?,?,?,?)').bind(digest,groupID,seat.id,expiry)]);
    } else {
      await env.DB.batch([env.DB.prepare('DELETE FROM group_invites WHERE expires_at<=?').bind(Date.now()),
        env.DB.prepare('INSERT INTO group_invites VALUES (?,?,?)').bind(digest,groupID,expiry)]);
    }
    return json({url:`${env.APP_URL}/join/${code}`,code});
  }
  if(path==='/v1/join' && request.method==='POST') {
    const b=await body(request);
    if(typeof b.token!=='string'||b.token.length>100)throw new InputError('Invalid invite.');
    const raw=b.token.trim(), token=raw.length===72?raw:raw.replace(/[\s-]/g,'').toUpperCase();
    const digest=await hash(token);
    const invite=await env.DB.prepare(`SELECT group_id,member_id FROM invites WHERE token_hash=? AND expires_at>?
      UNION ALL SELECT group_id,NULL FROM group_invites WHERE token_hash=? AND expires_at>?`)
      .bind(digest,Date.now(),digest,Date.now()).first<{group_id:string;member_id:string|null}>();
    if(!invite)throw new HTTPError(404,'This invitation is invalid or expired. Ask for a new link or code.');
    if (invite.member_id) {
      if (!await claimSeat(env.DB,invite.group_id,invite.member_id,userID)) throw new HTTPError(409,'This invitation has already been claimed.');
    } else {
      const profile=await env.DB.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(userID).first<{name:string}>();
      await env.DB.prepare(`INSERT INTO members SELECT ?,?,?,? WHERE NOT EXISTS
        (SELECT 1 FROM members WHERE group_id=? AND user_id=?)`)
        .bind(crypto.randomUUID(),invite.group_id,userID,profile?.name??'Split member',invite.group_id,userID).run();
    }
    return json({ok:true,groupID:invite.group_id});
  }
  throw new HTTPError(404,'Not found.');
}
export default {
 async scheduled(event,env) { await generateRecurring(env.DB,new Date(event.scheduledTime).toISOString().slice(0,10)); },
 async fetch(request,env):Promise<Response> {
  try {
   const url=new URL(request.url);
   if(url.pathname==='/health')return json({service:'split-api',status:'ok'});
   if(url.pathname==='/.well-known/apple-app-site-association') return json({applinks:{details:[{appIDs:['64PUT29XZ8.com.yoinklabs.split'],components:[{'/':'/join/*'}]}]}});
   const invite=url.pathname.match(/^\/join\/((?:[a-f0-9-]{72}|[A-HJ-NP-Z2-9]{12}))$/);
   if(invite && request.method==='GET') return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join your group · Split</title><style>body{font:20px system-ui;background:#f4f3ee;color:#172e27;max-width:480px;margin:5vh auto;padding:28px}a{display:block;background:#183f34;color:white;padding:18px;border-radius:18px;text-align:center;text-decoration:none}p{line-height:1.6}@media(prefers-color-scheme:dark){body{background:#101b17;color:#edf3ea}}</style><svg role="img" aria-label="Split logo" width="72" height="72" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="240" fill="#d1f091"/><g fill="#12382b"><rect x="222" y="340" width="580" height="142" rx="71"/><rect x="222" y="542" width="580" height="142" rx="71"/></g><path d="M518 744H622L506 280H402Z" fill="#d1f091"/></svg><h1>Join a group on Split</h1><p>Join this group on the web or in the iOS app.</p><a href="https://split.yoinklabs.dev/invite/${invite[1]}">Continue on the web</a><br><a href="com.yoinklabs.split://join/${invite[1]}">Open Split</a><p><a href="https://testflight.apple.com/join/YX8W6bCx">Get Split on TestFlight</a></p><p>${invite[1].length===12 ? `You can also choose <b>Join group</b> in Split and enter <strong>${invite[1]}</strong>.` : "After installing Split, open this invitation again to claim your place."}</p>`,{headers:{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}});
   const publicDevice = await deviceRoute(request, env);
   if (publicDevice) return publicDevice;
   const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];if(!token)throw new HTTPError(401,'Sign in to sync your expenses.');
   let userID:string;
   const device = token.startsWith('spl_') ? await deviceIdentity(env, token) : null;
   if (device) userID = device.user_id;
   else try{const {payload}=await jwtVerify(token,jwks,{issuer:env.CLERK_ISSUER,algorithms:['RS256'],requiredClaims:['exp','sub','iat']});if(!payload.sub || !validParty(payload.azp, env.WEB_URL))throw 0;userID=payload.sub;}catch{throw new HTTPError(401,'Your session expired. Sign in again.');}
   if (url.pathname.startsWith('/v1/device/')) return await manageDevices(request, env, userID, device?.id);
   if (url.pathname === '/mcp' || url.pathname === '/v1/cli') {
     if (!device) throw new HTTPError(403, 'Sign in with a Split device token.');
     return await cliRoute(request, env, userID, handle);
   }
   if (device) throw new HTTPError(403, 'Use the CLI or MCP endpoint with a device token.');
   if (url.pathname==='/v1/snapshot' || url.pathname==='/v1/join') {
     await refreshIdentity(env,userID);
   }
   return await handle(request,env,userID);
  }catch(error){if(error instanceof Error && /Receipt limit reached|bytes BETWEEN/.test(error.message)) return json({error:'Receipt storage limit reached.'},409);if(error instanceof Error && /Group is full|Account group limit reached/.test(error.message)) return json({error:'Member or account group limit reached.'},409);if(error instanceof HTTPError)return json({error:error.message},error.status);if(error instanceof InputError)return json({error:error.message},422);console.error(JSON.stringify({event:'request_failed',type:error instanceof Error?error.name:'unknown'}));return json({error:'Could not save this change. Please retry.'},500);}
 }
} satisfies ExportedHandler<Env>;
