import { activeDisputeResolver, disputeAccess, disputeComment, disputeEvent, disputeRoute, openDisputes } from './disputes';
import { normalizeName } from './names';
import { knownPerson, knownAccount } from './relationships';
import { legacyPayment, paymentMethods, saveAccountPayments } from './paymentProfiles';
import { preserveStatementAmount } from './exchange';
import {groupTools,generateRecurring} from './groupTools';
import { purchaseRoute, attachments, receiptActivity } from './receipts';
import { receiptInboxRoute } from './receiptInbox';
import { optionalDescription, socialRoute } from './social';
import { claimSeat, fetchVerifiedProfile, refreshIdentity, resolveEntry } from './people';
import { directoryRoute, invitations, isDiscoverable } from './directory';
import { activeGroupMember, activePlaceholder, emailInvitation, newInviteCode, requireActiveMember, reserveMemberEmail, sendMemberEmail, tokenHash } from './memberEmail';
import { HTTPError, json, body, optionalDay } from './http';
import { deviceRoute, deviceIdentity, manageDevices } from './cli/devices';
import { combinationRoute } from './combinations';
import { cliRoute } from './cli/routes';
import { financeRoute } from './finance';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { currencies, entryPayers, InputError, validID, validateEntry, type Entry } from './ledger';
import { importSplitwise } from './splitwiseImport';
import { groupAliases, hasRefunds, pendingRoute, refundedExpenseGuard, refundGuard } from './refunds';
import { pendingSettlements, recordSettlement, respondToSettlement } from './settlements';
import { deliverDigests, emailGroupInvite, emailLinkRoute, notifyActivity, preferencesRoute, type ActivityEvent } from './notifications';
import { renderSignInReminder } from './emailTemplate';
const jwks = createRemoteJWKSet(new URL('https://clerk.yoinklabs.dev/.well-known/jwks.json'));
interface Member {id:string; groupID:string; userID:string|null; name:string; email?:string; phone?:string; payment?:string; accountPayment?:string; viewerRemoved?:string|null; removedAt?:string|null; avatarURL?:string|null}
export function validParty(azp: unknown, webOrigin: string) {
  return azp === undefined || (typeof azp === 'string' && [webOrigin, 'com.yoinklabs.split', 'https://yoinklabs.dev', 'https://www.yoinklabs.dev'].includes(azp));
}
function contactInfo(emailInput:unknown,phoneInput:unknown) {
    const email=typeof emailInput==='string' ? emailInput.trim().toLowerCase() : '';
    const phone=typeof phoneInput==='string' ? phoneInput.trim() : '';
    if ((email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254)) || (phone && !/^[+0-9() .-]{3,32}$/.test(phone))) throw new InputError('Check the email address or phone number.');
    return {email,phone};
}
function memberEmail(value:unknown):string {
  const {email}=contactInfo(value,undefined);
  if (!email) throw new InputError('Enter a valid email address.');
  return email;
}
function saveMemberEmail(db:D1Database,groupID:string,memberID:string,userID:string,email:string|null) {
  return db.prepare(`INSERT INTO member_contacts(member_id,email)
    SELECT id,? FROM (${activePlaceholder}) WHERE true
    ON CONFLICT(member_id) DO UPDATE SET email=excluded.email`)
    .bind(email,groupID,memberID,groupID,userID);
}
async function member(env:Env,groupID:string,userID:string) {
  const row=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(groupID,userID).first();
  if(!row) throw new HTTPError(403,'You are not a member of this group.');
}
async function members(env:Env,groupID:string):Promise<Member[]> {return (await env.DB.prepare('SELECT id, group_id AS groupID, user_id AS userID, name FROM members WHERE group_id=? ORDER BY id').bind(groupID).all<Member>()).results;}
/** Who hears about a new entry: refunds and credits tell the people credited; expenses tell everyone who shares or paid. */
function entryActivity(e:Entry,userID:string,kind:'expenses'|'pendingResolved'='expenses'):ActivityEvent {
  const base={groupID:e.groupID,actorUserID:userID,title:e.title,amount:e.amount,currency:e.currency};
  if(e.kind==='refund') return {...base,kind:kind==='pendingResolved'?kind:'credits',refID:e.id+(kind==='pendingResolved'?':resolved:'+e.amount:''),
    recipients:e.splits.filter(s=>s.amount>0 && s.memberID!==e.paidBy).map(s=>({memberID:s.memberID,share:s.amount,variant:e.refundOf?'refund':'credit'}))};
  return {...base,kind,refID:kind==='pendingResolved'?e.id+':resolved:'+e.amount:e.id,
    recipients:[...e.splits.filter(s=>s.amount>0).map(s=>({memberID:s.memberID,share:s.amount})),
      ...entryPayers(e).map(p=>({memberID:p.memberID,share:0}))]};
}
/** After a pending entry is confirmed, adjusted or turned into a refund. */
async function notifyResolved(env:Env,id:string,userID:string) {
  const rows=(await env.DB.prepare(`SELECT payload FROM entries WHERE (id=? OR (json_extract(payload,'$.refundOf')=? AND author=?))
    AND id NOT IN (SELECT entry_id FROM deleted_entries)`).bind(id,id,userID).all<{payload:string}>()).results.map(r=>JSON.parse(r.payload) as Entry);
  const entry=rows.find(e=>e.id===id);
  if(!entry || entry.pending) return;
  await notifyActivity(env,entryActivity(entry,userID,'pendingResolved'));
  // A refund recorded while resolving is a credit to the people it pays back.
  for(const refund of rows.filter(e=>e.id!==id && e.kind==='refund')) await notifyActivity(env,entryActivity(refund,userID));
}
export async function handle(request:Request,env:Env,userID:string):Promise<Response> {
  const url=new URL(request.url), path=url.pathname;
  const dispute=await disputeRoute(request,env,userID);
  if(dispute) return dispute;
  const combination=await combinationRoute(request,env,userID);
  if(combination) return combination;
  const extra=await groupTools(request,env,userID);
  if(extra) return extra;
  const inbox=await receiptInboxRoute(request,env,userID);
  if(inbox) return inbox;
  const purchase=await purchaseRoute(request,env,userID);
  if(purchase) return purchase;
  const social=await socialRoute(request,env,userID);
  if(social) return social;
  const pending=await pendingRoute(request,env,userID);
  if(pending) {
    const resolved=path.match(/^\/v1\/entries\/([\w-]+)\/resolve$/);
    if(resolved && pending.ok) await notifyResolved(env,resolved[1],userID);
    return pending;
  }
  const preferences=await preferencesRoute(request,env,userID);
  if(preferences) return preferences;
  const directory=await directoryRoute(request,env,userID);
  if(directory) return directory;
  if(path==='/v1/profile/payment-methods' && request.method==='POST')
    return saveAccountPayments(request,env.DB,userID);
  if(path==='/v1/snapshot' && request.method==='GET') {
    type SnapshotGroup={id:string;creator:string;name:string;kind:string;currency:string;simplify?:number;archivedAt?:string|null;description?:string|null;startDate?:string|null;endDate?:string|null;weights:string|null;createdAt:string};
    let groups: SnapshotGroup[];
    try {
      groups=(await env.DB.prepare('SELECT g.id,g.creator,g.name,g.kind,g.currency,g.simplify,g.archived_at AS archivedAt,g.description,g.start_date AS startDate,g.end_date AS endDate,(SELECT weights FROM group_splits WHERE group_id=g.id) AS weights,g.created_at AS createdAt FROM groups g JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC LIMIT 101').bind(userID).all<SnapshotGroup>()).results;
    } catch {
      try {
        groups=(await env.DB.prepare('SELECT g.id,g.creator,g.name,g.kind,g.currency,g.simplify,g.archived_at AS archivedAt,(SELECT weights FROM group_splits WHERE group_id=g.id) AS weights,g.created_at AS createdAt FROM groups g JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC LIMIT 101').bind(userID).all<SnapshotGroup>()).results;
      } catch {
        groups=(await env.DB.prepare('SELECT g.id,g.creator,g.name,g.kind,g.currency,1 AS simplify,NULL AS archivedAt,(SELECT weights FROM group_splits WHERE group_id=g.id) AS weights,g.created_at AS createdAt FROM groups g JOIN members m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at DESC LIMIT 101').bind(userID).all<SnapshotGroup>()).results;
      }
    }
    if(groups.length>100) throw new HTTPError(409,'This beta supports up to 100 groups.');
    const aliases = new Map((await env.DB.prepare(`SELECT a.member_id, a.canonical_id FROM member_aliases a
      JOIN members m ON m.id=a.canonical_id JOIN members viewer ON viewer.group_id=m.group_id WHERE viewer.user_id=?`)
      .bind(userID).all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
    const visible=(await env.DB.prepare(`SELECT m.id,m.group_id AS groupID,m.user_id AS userID,m.name,
      m.removed_at AS removedAt,viewer.removed_at AS viewerRemoved,
      (SELECT details FROM account_payment_profiles WHERE user_id=m.user_id) AS accountPayment,
      (SELECT avatar_url FROM user_avatars WHERE user_id=m.user_id) AS avatarURL,
      (SELECT details FROM payment_profiles WHERE member_id=m.id) AS payment FROM members m
      JOIN members viewer ON viewer.group_id=m.group_id WHERE viewer.user_id=? ORDER BY m.rowid`)
      .bind(userID).all<Member>()).results;
    const avatarURL = visible.find(m => m.userID===userID)?.avatarURL
      ?? (groups.length ? null : await env.DB.prepare('SELECT avatar_url FROM user_avatars WHERE user_id=?').bind(userID).first<string>('avatar_url'));
    const tripRates=new Map<string,Record<string,number>>();
    if(groups.some(g=>g.kind==='trip')) {
      try {
        const rows=(await env.DB.prepare(`SELECT r.group_id,r.currency,r.rate_e8 FROM trip_exchange_rates r
          JOIN members m ON m.group_id=r.group_id WHERE m.user_id=?`).bind(userID)
          .all<{group_id:string;currency:string;rate_e8:number}>()).results;
        for(const row of rows) {
          const rates=tripRates.get(row.group_id)??{};
          rates[row.currency]=row.rate_e8;
          tripRates.set(row.group_id,rates);
        }
      } catch (err) {
        // During rollout the ledger should still load before migration 0016 is applied.
        if(!String(err).includes('no such table: trip_exchange_rates')) throw err;
      }
    }
    const all=groups.map(({creator,weights,simplify,archivedAt,description,startDate,endDate,...g})=>{
      const roster=visible.filter(m=>m.groupID===g.id && !aliases.has(m.id));
      const active=new Set(roster.filter(m=>!m.removedAt).map(m=>m.id));
      const defaults:Record<string,number>={};
      for(const [id,w] of Object.entries(JSON.parse(String(weights??'{}')) as Record<string,number>)) {
        const key=aliases.get(id)??id;
        if(active.has(key)) defaults[key]=(defaults[key]??0)+w;
      }
      return {...g,canDelete:creator===userID && roster.some(m=>m.userID===userID && !m.removedAt),simplify:Boolean(simplify),archived:Boolean(archivedAt),
        ...(description?{description}:{}),...(startDate?{startDate}:{}),...(endDate?{endDate}:{}),
        defaultWeights:defaults,
        ...(tripRates.has(g.id)?{tripRates:tripRates.get(g.id)}:{}),
        members:roster.map(({payment,accountPayment,viewerRemoved,removedAt,avatarURL,...m})=>{
          const override=!removedAt && !viewerRemoved ? paymentMethods(payment) : undefined;
          const methods=!removedAt && !viewerRemoved ? override ?? paymentMethods(accountPayment) ?? [] : [];
          return {...m,name:normalizeName(m.name),payment:legacyPayment(methods),paymentMethods:methods,
            ...(m.userID===userID && override!==undefined ? {paymentOverride:override} : {}),
            ...(removedAt?{removed:true}:{}),
            ...(avatarURL?{avatarURL}:{})};
        })};
    });
    type SnapshotEntryRow={payload:string;author:string;recurrence:string|null;photos:string;commentCount:number;likeCount:number;likedByMe:number};
    let entries: SnapshotEntryRow[];
    try {
      entries=(await env.DB.prepare(`SELECT e.payload,e.author,(SELECT cadence FROM recurring WHERE entry_id=e.id) AS recurrence,
        (SELECT json_group_array(id) FROM expense_receipts WHERE entry_id=e.id) AS photos,
        (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id) AS commentCount,
        (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id) AS likeCount,
        EXISTS(SELECT 1 FROM entry_reactions v WHERE v.entry_id=e.id AND v.user_id=?) AS likedByMe
        FROM entries e JOIN members m ON m.group_id=e.group_id
        WHERE m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries) ORDER BY e.created_at DESC LIMIT 5001`)
        .bind(userID,userID).all<SnapshotEntryRow>()).results;
    } catch {
      entries=(await env.DB.prepare(`SELECT e.payload,e.author,(SELECT cadence FROM recurring WHERE entry_id=e.id) AS recurrence,
        (SELECT json_group_array(id) FROM expense_receipts WHERE entry_id=e.id) AS photos,
        0 AS commentCount,0 AS likeCount,0 AS likedByMe
        FROM entries e JOIN members m ON m.group_id=e.group_id
        WHERE m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries) ORDER BY e.created_at DESC LIMIT 5001`)
        .bind(userID).all<SnapshotEntryRow>()).results;
    }
    if(entries.length>5000)throw new HTTPError(409,'This beta supports up to 5,000 entries. Export support is coming.');
    const settlementRequests=(await pendingSettlements(env.DB,userID))
      .map(row => resolveEntry(JSON.parse(row.payload),aliases));
    const profilePayment=await env.DB.prepare('SELECT details FROM account_payment_profiles WHERE user_id=?').bind(userID).first<string>('details');
    const [pendingInvitations,discoverable,disputes]=await Promise.all([invitations(env.DB,userID),isDiscoverable(env.DB,userID),openDisputes(env.DB,userID)]);
    return json({userID,...(disputes.length ? {disputes} : {}),paymentMethods:paymentMethods(profilePayment)??[],settlementRequests,invitationCount:pendingInvitations.length,discoverable,...(avatarURL ? {avatarURL} : {}),groups:all,entries:entries.map(e=>{
      const entry=resolveEntry(JSON.parse(e.payload),aliases);
      return {...entry,recurrence:e.recurrence,receiptIDs:JSON.parse(e.photos),editable:e.author===userID && !entry.combinedCount,
        commentCount:Number(e.commentCount),likeCount:Number(e.likeCount),likedByMe:Boolean(e.likedByMe)};
    })});
  }
  if(path==='/v1/import/splitwise' && request.method==='POST') return importSplitwise(env.DB,userID,await body(request,2_000_000));
  if(path==='/v1/groups' && request.method==='POST') {
    const b=await body(request);
    const m=b.members as Member[];
    if(!validID(b.id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['trip','home','friend'].includes(String(b.kind))||!currencies.includes(b.currency as typeof currencies[number])||!Array.isArray(m)||m.length<1||m.length>50||m.some(x=>!x || typeof x!=='object')||new Set(m.map(x=>x.id)).size!==m.length||m.some(x=>!validID(x.id)||typeof x.name!=='string'||!x.name.trim()||x.name.length>60)||m.filter(x=>x.userID===userID).length!==1) throw new InputError('Check the group and its members.');
    const existing=await env.DB.prepare('SELECT creator FROM groups WHERE id=?').bind(b.id).first<{creator:string}>();
    if(existing){ if(existing.creator!==userID)throw new HTTPError(409,'Group ID already used.'); return json({ok:true}); }
    const count=await env.DB.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').bind(userID).first<{n:number}>();if((count?.n??0)>=100)throw new HTTPError(409,'Group limit reached.');
    const desc=optionalDescription(b.description) ?? null;
    const startDate=optionalDay(b.startDate,'start date') ?? null;
    const endDate=optionalDay(b.endDate,'end date') ?? null;
    if(startDate && endDate && endDate < startDate) throw new InputError('End date must be on or after the start date.');
    const fields=[b.id,b.name.trim(),b.kind,b.currency,userID,new Date().toISOString()];
    const inserts=[desc || startDate || endDate
      ? env.DB.prepare('INSERT INTO groups(id,name,kind,currency,creator,created_at,description,start_date,end_date) VALUES (?,?,?,?,?,?,?,?,?)').bind(...fields,desc,startDate,endDate)
      : env.DB.prepare('INSERT INTO groups(id,name,kind,currency,creator,created_at) VALUES (?,?,?,?,?,?)').bind(...fields)];
    for (const person of m) {
      let name=normalizeName(person.name);
      if (person.userID && person.userID!==userID) {
        const profile=await knownPerson(env.DB,userID,person.userID);
        if (!profile) throw new InputError('Choose a friend or someone from a shared group.');
        name=profile.name;
      }
      inserts.push(env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)').bind(person.id,b.id,person.userID||null,name));
      const contact=contactInfo(person.email,person.phone);
      if (!person.userID && (contact.email || contact.phone))
        inserts.push(env.DB.prepare('INSERT INTO member_contacts VALUES (?,?,?)').bind(person.id,contact.email||null,contact.phone||null));
    }
    await env.DB.batch(inserts);
    return json({ok:true},201);
  }
  const settlementResponse=path.match(/^\/v1\/settlements\/([\w-]+)\/(approve|decline|cancel)$/);
  if(settlementResponse && request.method==='POST') {
    const [,id,action]=settlementResponse;
    if(action==='approve' || action==='decline' || action==='cancel') {
      const response=await respondToSettlement(env.DB,id,action,userID);
      if(action!=='cancel') {
        const row=await env.DB.prepare('SELECT group_id,payer_id,payload FROM settlement_requests WHERE id=?').bind(id).first<{group_id:string;payer_id:string;payload:string}>();
        if(row) {
          const e=JSON.parse(row.payload);
          await notifyActivity(env,{groupID:row.group_id,kind:'payments',refID:id+':'+action,actorUserID:userID,
            recipients:[{memberID:row.payer_id,variant:action==='approve'?'confirmed':'declined'}],amount:e.amount,currency:e.currency});
        }
      }
      return response;
    }
  }
  if((path==='/v1/entries' || path==='/v1/settlements') && request.method==='POST') {
    const b=await body(request,1_650_000); if(!validID(b.groupID)) throw new InputError('Invalid group.');
    await member(env,b.groupID,userID);
    const e=validateEntry(b,(await members(env,b.groupID)).map(m=>m.id),undefined,{reconcileBill:true});
    if (e.bill) await requireActiveMember(env,b.groupID,userID);
    if(path==='/v1/settlements' && e.kind!=='settlement') throw new InputError('Choose a payment to confirm.');
    const payload=JSON.stringify(e);
    if(e.exchange && e.exchange.target!==await env.DB.prepare('SELECT currency FROM groups WHERE id=?').bind(e.groupID).first('currency')) throw new InputError('Use the group settlement currency.');
    if(e.kind==='settlement') {
      if(b.photos!==undefined) throw new InputError('Attach receipt photos to an expense.');
      const response=await recordSettlement(env.DB,e,userID);
      const {status}=await response.clone().json<{status:string}>();
      const payer=await env.DB.prepare('SELECT user_id FROM members WHERE id=? AND group_id=?').bind(e.paidBy,e.groupID).first<string>('user_id');
      const recipient=e.splits[0].memberID, recordedByPayer=payer===userID;
      // A pending payment asks the recipient to confirm it; a confirmed one tells the other side.
      await notifyActivity(env,status==='pending'
        ? {groupID:e.groupID,kind:'settleRequests',refID:e.id,actorUserID:userID,recipients:[{memberID:recipient}],amount:e.amount,currency:e.currency}
        : {groupID:e.groupID,kind:'payments',refID:e.id,actorUserID:userID,amount:e.amount,currency:e.currency,
          recipients:[recordedByPayer?{memberID:recipient,variant:'paidYou'}:{memberID:e.paidBy,variant:'receivedYours'}]});
      return response;
    }
    const prior=e.kind==='refund' && e.refundOf ? await env.DB.prepare('SELECT author,payload FROM entries WHERE id=?').bind(e.id).first<{author:string;payload:string}>() : null;
    if(prior?.author===userID && prior.payload===payload) return json({ok:true});
    const guard=prior ? undefined : await refundGuard(env.DB,e,await groupAliases(env.DB,e.groupID));
    // Reserve pending payment IDs so approval can never collide with an expense.
    const [inserted]=await env.DB.batch([env.DB.prepare(`INSERT INTO entries SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM settlement_requests WHERE id=?)${guard?' AND '+guard.sql:''} ON CONFLICT(id) DO NOTHING`).bind(e.id,e.groupID,userID,payload,new Date().toISOString(),e.id,...(guard?.binds??[])), ...attachments(env.DB,e,userID,payload,b.photos)]);
    const saved=await env.DB.prepare('SELECT author,payload FROM entries WHERE id=?').bind(e.id).first<{author:string;payload:string}>();
    if(!saved && guard) throw new HTTPError(409,'The original expense or its refunds changed. Refresh and try again.');
    if(saved?.author!==userID||saved.payload!==payload)throw new HTTPError(409,'An entry already uses this ID.');
    if(inserted.meta.changes) {
      if (!e.handled) await notifyActivity(env,entryActivity(e,userID));
      await receiptActivity(env,e,userID,false);
    }
    return json({ok:true});
  }
  const handled=path.match(/^\/v1\/entries\/([\w-]+)\/handled$/);
  if(handled && request.method==='POST') {
    const b=await body(request);
    if(typeof b.handled!=='boolean') throw new InputError('Choose whether the expense was already handled.');
    const row=await env.DB.prepare(`SELECT e.payload,e.group_id AS groupID,m.id AS viewer FROM entries e
      JOIN members m ON m.group_id=e.group_id AND m.user_id=? AND m.removed_at IS NULL
      WHERE e.id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries)`)
      .bind(userID,handled[1]).first<{payload:string;groupID:string;viewer:string}>();
    if(!row) throw new HTTPError(404,'Expense unavailable.');
    const entry=JSON.parse(row.payload);
    if(entry.combinedCount) throw new HTTPError(409,'Split this expense back into its originals first.');
    if(entry.kind!=='expense') throw new InputError('Only expenses can be marked as already handled.');
    const aliases=new Map((await env.DB.prepare(`SELECT a.member_id,a.canonical_id FROM member_aliases a
      JOIN members m ON m.id=a.canonical_id WHERE m.group_id=?`).bind(row.groupID)
      .all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
    if(!entryPayers(resolveEntry(entry,aliases)).some(p=>p.memberID===row.viewer))
      throw new HTTPError(403,'Only a payer can change whether this expense is handled.');
    if(Boolean(entry.handled)===b.handled) return json({ok:true});
    // Keep the stored entry in canonical key order so normal edit retries still match.
    const updated=validateEntry({...entry,handled:b.handled},(await members(env,row.groupID)).map(m=>m.id),entry.bill);
    const saved=await env.DB.prepare(`UPDATE entries SET payload=? WHERE id=? AND payload=?
      AND id NOT IN (SELECT entry_id FROM deleted_entries)`).bind(JSON.stringify(updated),handled[1],row.payload).run();
    if(!saved.meta.changes) throw new HTTPError(409,'This expense changed. Refresh and try again.');
    return json({ok:true});
  }
  const revise=path.match(/^\/v1\/entries\/([\w-]+)\/(edit|delete)$/);
  if (revise && request.method==='POST') {
    const b=await body(request,1_350_000);
    const saved=await env.DB.prepare('SELECT group_id,author,payload FROM entries WHERE id=?').bind(revise[1]).first<{group_id:string;author:string;payload:string}>();
    const dispute = saved ? await disputeAccess(env.DB,revise[1],userID) : null;
    if (!saved || (saved.author!==userID && !(revise[2]==='edit' && dispute?.disputeID && dispute.canResolve)))
      throw new HTTPError(403,'Only the person who recorded this entry can change it.');
    await member(env,saved.group_id,userID);
    const old=JSON.parse(saved.payload);
    if(old.combinedCount) throw new HTTPError(409,'Split this expense back into its originals first.');
    const deleted=await env.DB.prepare('SELECT entry_id FROM deleted_entries WHERE entry_id=?').bind(revise[1]).first();
    const deleting=revise[2]==='delete';
    const disputeID=dispute?.disputeID;
    if(disputeID && deleting) throw new HTTPError(409,'Resolve this dispute before deleting the expense.');
    if(disputeID && saved.author!==userID && b.photos!==undefined)
      throw new HTTPError(403,'Only the recorder can attach photos while editing this expense.');
    const reply=disputeID ? disputeComment(b.disputeReply) : '';
    if (deleted) {
      if(await env.DB.prepare('SELECT 1 FROM active_expense_combination_sources WHERE source_id=?').bind(revise[1]).first())
        throw new HTTPError(409,'Restore the original expenses before changing this expense.');
      if (deleting) return json({ok:true});
      throw new HTTPError(409,'This entry has been deleted.');
    }
    const ids=(await members(env,saved.group_id)).map(m=>m.id);
      const aliases=new Map((await env.DB.prepare('SELECT member_id,canonical_id FROM member_aliases JOIN members ON members.id=member_id WHERE group_id=?')
        .bind(saved.group_id).all<{member_id:string;canonical_id:string}>()).results.map(a=>[a.member_id,a.canonical_id]));
    const canonical=resolveEntry(old,aliases);
    let replacement: Entry | undefined;
    let payload: string | undefined;
    let guard: {sql:string;binds:unknown[]} | undefined;
    if (deleting && old.kind==='expense' && await hasRefunds(env.DB,saved.group_id,revise[1]))
      throw new InputError('This expense has refunds. Delete its refunds first.');
    if (!deleting) {
      if (old.kind==='settlement') throw new InputError('Payments cannot be edited.');
      const legacyOriginal=preserveStatementAmount(b.original,canonical);
      const updated=validateEntry(legacyOriginal!==b.original ? preserveStatementAmount(b.entry,canonical) : b.entry,ids,canonical.bill,{reconcileBill:true});
      if (updated.bill || old.bill) await requireActiveMember(env,saved.group_id,userID);
      if(disputeID) {
        const ordered = (splits: Entry['splits']) => [...splits].sort((a,b) => a.memberID.localeCompare(b.memberID));
        if(updated.amount===canonical.amount && updated.splitMode===canonical.splitMode &&
          JSON.stringify(ordered(updated.splits))===JSON.stringify(ordered(canonical.splits)))
          throw new InputError('Change the amount, split or participants to resolve by editing.');
        delete updated.pending;
        delete updated.pendingNote;
      }
      replacement=updated;
      if(updated.id!==revise[1] || updated.groupID!==saved.group_id || updated.createdAt!==old.createdAt || updated.kind!==old.kind || updated.refundOf!==old.refundOf)
        throw new InputError('Invalid edit.');
      guard=updated.kind==='refund' ? await refundGuard(env.DB,updated,aliases) : await refundedExpenseGuard(env.DB,updated,aliases);
      if(Boolean(updated.handled)!==Boolean(canonical.handled)) {
        const viewer=(await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL')
          .bind(saved.group_id,userID).first<{id:string}>())?.id;
        if(!entryPayers(canonical).some(p=>p.memberID===viewer))
          throw new HTTPError(403,'Only a payer can change whether this expense is handled.');
      }
      if(updated.exchange && updated.exchange.target!==canonical.exchange?.target &&
        updated.exchange.target!==await env.DB.prepare('SELECT currency FROM groups WHERE id=?').bind(saved.group_id).first('currency')) throw new InputError('Use the group settlement currency.');
      if((updated.exchange || updated.bill || updated.spread) && await env.DB.prepare('SELECT 1 FROM recurring WHERE entry_id=?').bind(updated.id).first()) throw new InputError('Stop the recurring schedule before itemizing, converting, or spreading this expense over days.');
      payload=JSON.stringify(updated);
      if (old.bill && !updated.bill) throw new InputError('Keep the receipt items when editing this expense.');
      if (saved.payload===payload && !b.photos) return json({ok:true});
    }
    const conditional=!deleting || b.original!==undefined;
    if (conditional) {
      const original=validateEntry(preserveStatementAmount(b.original,canonical),ids,canonical.bill);
      if (JSON.stringify(original)!==JSON.stringify(canonical)) throw new HTTPError(409,'This entry changed. Refresh and try again.');
    }
    const disputeGuard=disputeID
      ? ' AND EXISTS (SELECT 1 FROM expense_disputes WHERE id=? AND entry_id=entries.id AND closed_at IS NULL)' +
        ' AND ' + activeDisputeResolver
      : ' AND NOT EXISTS (SELECT 1 FROM expense_disputes WHERE entry_id=entries.id AND closed_at IS NULL)';
    const disputeBinds=disputeID ? [disputeID,userID] : [];
    const statement=deleting
      ? await env.DB.prepare(`INSERT OR IGNORE INTO deleted_entries SELECT id FROM entries WHERE id=? AND (?=0 OR payload=?)
        AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.group_id=entries.group_id AND json_extract(r.payload,'$.refundOf')=entries.id
          AND r.id NOT IN (SELECT entry_id FROM deleted_entries))${disputeGuard}`)
        .bind(revise[1],Number(conditional),saved.payload,...disputeBinds)
      : await env.DB.prepare(`UPDATE entries SET payload=? WHERE id=? AND payload=? AND id NOT IN (SELECT entry_id FROM deleted_entries)${guard?' AND '+guard.sql:''}${disputeGuard}`)
        .bind(payload!,revise[1],saved.payload,...(guard?.binds??[]),...disputeBinds);
    const [result]=await env.DB.batch([statement,...(disputeID ? [disputeEvent(env.DB,disputeID,'edited',userID,dispute!.name,reply)] : []),...(deleting?[]:attachments(env.DB,JSON.parse(payload!),userID,payload!,b.photos))]);
    if (!result.meta.changes && !(deleting && await env.DB.prepare('SELECT entry_id FROM deleted_entries WHERE entry_id=? AND entry_id NOT IN (SELECT source_id FROM active_expense_combination_sources)').bind(revise[1]).first()))
      throw new HTTPError(409,'This entry changed. Refresh and try again.');
    if (replacement) await receiptActivity(env,replacement,userID,Boolean(canonical.bill?.closed),canonical);
    return json({ok:true});
  }
  const addMember=path.match(/^\/v1\/groups\/([\w-]+)\/members$/);
  if (addMember && request.method==='GET') {
    const groupID = addMember[1];
    await requireActiveMember(env,groupID,userID);
    const {results} = await env.DB.prepare(`SELECT m.id AS memberID,c.email FROM member_contacts c
      JOIN members m ON m.id=c.member_id WHERE m.group_id=? AND m.user_id IS NULL AND m.removed_at IS NULL
        AND m.id NOT IN (SELECT member_id FROM member_aliases) AND c.email IS NOT NULL AND ${activeGroupMember}`)
      .bind(groupID,groupID,userID).all<{memberID:string;email:string}>();
    return json({claimEmails:results});
  }
  const emailAction = path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/(invite-email|sign-in-email)$/);
  if (emailAction && request.method==='POST') {
    const [,groupID,memberID,action] = emailAction;
    await requireActiveMember(env,groupID,userID);
    const b = await body(request);
    if (action==='invite-email') {
      await emailInvitation(env,groupID,memberID,userID,memberEmail(b.email));
    } else {
      const target = await env.DB.prepare(`SELECT user_id FROM members
        WHERE group_id=? AND id=? AND removed_at IS NULL AND user_id IS NOT NULL AND ${activeGroupMember}`)
        .bind(groupID,memberID,groupID,userID).first<string>('user_id');
      if (!target) throw new HTTPError(404,'Choose a joined member in this group.');
      const sendID = await reserveMemberEmail(env,userID,'account:'+target);
      const profile = await fetchVerifiedProfile(env,target);
      if (!profile) throw new HTTPError(503,'Could not look up the member’s sign-in address. Try again later.');
      if (!profile.email) throw new HTTPError(422,'This member has no verified sign-in email.');
      const group = await env.DB.prepare('SELECT name FROM groups WHERE id=?').bind(groupID).first<string>('name');
      await sendMemberEmail(env,sendID,profile.email,renderSignInReminder({group:group??'your group',url:`${env.WEB_URL}/g/${groupID}`,logoURL:`${env.WEB_URL}/icon.png`}));
    }
    return json({ok:true});
  }
  const resendInvite = path.match(/^\/v1\/groups\/([\w-]+)\/invites\/([a-f0-9]{64})\/resend$/);
  if (resendInvite && request.method==='POST') {
    const [,groupID,id] = resendInvite;
    await requireActiveMember(env,groupID,userID);
    const invite = await env.DB.prepare(`SELECT member_id,recipient_email FROM invites
      WHERE group_id=? AND token_hash=? AND recipient_email IS NOT NULL`)
      .bind(groupID,id).first<{member_id:string;recipient_email:string}>();
    if (!invite) throw new HTTPError(404,'Email invitation not found.');
    await emailInvitation(env,groupID,invite.member_id,userID,invite.recipient_email,id);
    return json({ok:true});
  }
  if (addMember && request.method==='POST') {
    const groupID=addMember[1];
    await requireActiveMember(env,groupID,userID);
    const b=await body(request);
    if(!validID(b.id)) throw new InputError('Invalid member.');
    const name=typeof b.name==='string' ? normalizeName(b.name) : '';
    if (!name || name.length>60) throw new InputError('Enter a name of up to 60 characters.');
    const {email,phone}=contactInfo(b.email,b.phone);
    const target=typeof b.userID==='string' ? await knownPerson(env.DB,userID,b.userID) : null;
    if (b.userID && !target) throw new InputError('Choose a friend or someone from a shared group.');
    const existing=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND (id=? OR user_id=?)')
      .bind(groupID,b.id,target?.userID??null).first<{id:string}>();
    if (existing) return json({id:existing.id});
    const added=target
      ? env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name) SELECT ?,?,p.user_id,p.name FROM split_profiles p
          WHERE p.user_id=? AND ${knownAccount} AND ${activeGroupMember}`)
        .bind(b.id,groupID,target.userID,userID,userID,userID,groupID,userID)
      : env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name) SELECT ?,?,NULL,? WHERE ${activeGroupMember}`)
        .bind(b.id,groupID,name,groupID,userID);
    const [saved]=await env.DB.batch([added,
      ...(!target && (email || phone) ? [env.DB.prepare(`INSERT INTO member_contacts SELECT id,?,? FROM members WHERE id=? AND ${activeGroupMember}`)
        .bind(email||null,phone||null,b.id,groupID,userID)] : [])
    ]);
    if (!saved.meta.changes) throw new HTTPError(409,'Membership changed. Refresh and try again.');
    if (target) await emailGroupInvite(env,{groupID,inviterUserID:userID,inviteeUserID:target.userID,added:true});
    return json({id:b.id},201);
  }
  const editMemberEmail=path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/email$/);
  if (editMemberEmail && request.method==='POST') {
    const [,groupID,memberID]=editMemberEmail;
    await member(env,groupID,userID);
    const b=await body(request);
    const email=b.email===null ? null : memberEmail(b.email);
    const [,saved]=await env.DB.batch([
      env.DB.prepare(`DELETE FROM invites WHERE group_id=? AND recipient_email IS NULL AND member_id IN (${activePlaceholder})
        AND (SELECT email FROM member_contacts WHERE member_id=?) IS NOT ?`)
        .bind(groupID,groupID,memberID,groupID,userID,memberID,email),
      saveMemberEmail(env.DB,groupID,memberID,userID,email)
    ]);
    if (!saved.meta.changes) throw new InputError('Choose an active, unclaimed member in your group.');
    return json({id:memberID,email});
  }
  const inviteMatch=path.match(/^\/v1\/groups\/([\w-]+)\/invites$/);
  if(inviteMatch && request.method==='POST') {
    const groupID=inviteMatch[1];await requireActiveMember(env,groupID,userID);const b=await body(request);
    const hasMember=b.memberID!==undefined && b.memberID!==null;
    if (hasMember && !validID(b.memberID)) throw new InputError('Choose an unclaimed member to invite.');
    const name=typeof b.name==='string' ? normalizeName(b.name) : '';
    if (b.name!==undefined && (!name || name.length>60 || hasMember))
      throw new InputError('Enter a name of up to 60 characters for a new placeholder, or choose an existing member.');
    const email=b.email===undefined ? undefined : memberEmail(b.email);
    if (email && !hasMember && !name) throw new InputError('Choose a member or enter a name for the email invitation.');
    const memberID=name ? crypto.randomUUID() : hasMember ? b.memberID as string : undefined;
    const code=newInviteCode();
    const digest=await tokenHash(code), expiry=Date.now()+7*86400000;
    if (memberID) {
      const statements=[
        name
          ? env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name) SELECT ?,?,NULL,? WHERE ${activeGroupMember}`)
            .bind(memberID,groupID,name,groupID,userID)
          : env.DB.prepare(`DELETE FROM invites WHERE group_id=? AND recipient_email IS NULL AND member_id IN (${activePlaceholder})`)
            .bind(groupID,groupID,memberID,groupID,userID)
      ];
      if (email) statements.push(saveMemberEmail(env.DB,groupID,memberID,userID,email));
      statements.push(env.DB.prepare(`INSERT INTO invites(token_hash,group_id,member_id,expires_at)
        SELECT ?,?,id,? FROM (${activePlaceholder})`).bind(digest,groupID,expiry,groupID,memberID,groupID,userID));
      const results=await env.DB.batch(statements);
      if (!results.at(-1)?.meta.changes) throw new InputError('Choose an active, unclaimed member to invite.');
    } else {
      await env.DB.batch([env.DB.prepare('DELETE FROM group_invites WHERE expires_at<=?').bind(Date.now()),
        env.DB.prepare('INSERT INTO group_invites VALUES (?,?,?)').bind(digest,groupID,expiry)]);
    }
    return json({url:`${env.APP_URL}/join/${code}`,code,id:digest,...(memberID ? {memberID} : {})});
  }
  if(path==='/v1/join' && request.method==='POST') {
    const b=await body(request);
    if(typeof b.token!=='string'||b.token.length>100)throw new InputError('Invalid invite.');
    const raw=b.token.trim(), token=raw.length===72?raw:raw.replace(/[\s-]/g,'').toUpperCase();
    const digest=await tokenHash(token);
    const invite=await env.DB.prepare(`SELECT group_id,member_id,recipient_email FROM invites WHERE token_hash=? AND expires_at>?
      UNION ALL SELECT group_id,NULL,NULL FROM group_invites WHERE token_hash=? AND expires_at>?`)
      .bind(digest,Date.now(),digest,Date.now()).first<{group_id:string;member_id:string|null;recipient_email:string|null}>();
    if(!invite)throw new HTTPError(404,'This invitation is invalid or expired. Ask for a new link or code.');
    if (invite.recipient_email) {
      const profile = await fetchVerifiedProfile(env,userID);
      if (!profile) throw new HTTPError(503,'Could not verify your sign-in email. Try again later.');
      if (profile.email !== invite.recipient_email)
        throw new HTTPError(403,'Sign in with the verified primary email address that received this invitation.');
    }
    if (invite.member_id) {
      if (!await claimSeat(env.DB,invite.group_id,invite.member_id,userID,digest)) throw new HTTPError(409,'This invitation has expired or has already been claimed.');
    } else {
      const profile=await env.DB.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(userID).first<{name:string}>();
      const joined=await env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name)
        SELECT ?,group_id,?,? FROM group_invites WHERE token_hash=? AND group_id=? AND expires_at>?
        ON CONFLICT(group_id,user_id) DO UPDATE SET user_id=excluded.user_id`)
        .bind(crypto.randomUUID(),userID,profile?.name??'Split member',digest,invite.group_id,Date.now()).run();
      if(!joined.meta.changes) throw new HTTPError(404,'This invitation is invalid or expired.');
    }
    return json({ok:true,groupID:invite.group_id});
  }
  throw new HTTPError(404,'Not found.');
}
export default {
 async scheduled(event,env) {
   await generateRecurring(env.DB,new Date(event.scheduledTime).toISOString().slice(0,10));
   try { await deliverDigests(env,event.scheduledTime); }
   catch (error) { console.error(JSON.stringify({event:'digest_run_failed',type:error instanceof Error?error.name:'unknown'})); }
 },
 async fetch(request,env):Promise<Response> {
  try {
   const url=new URL(request.url);
   if(url.pathname==='/health')return json({service:'split-api',status:'ok'});
   if(url.pathname==='/.well-known/apple-app-site-association') return json({applinks:{details:[{appIDs:['64PUT29XZ8.com.yoinklabs.split'],components:[{'/':'/join/*'}]}]}});
   const invite=url.pathname.match(/^\/join\/((?:[a-f0-9-]{72}|[A-HJ-NP-Z2-9]{12}))$/);
   if(invite && request.method==='GET') return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join your group · Split</title><style>body{font:20px system-ui;background:#f4f3ee;color:#172e27;max-width:480px;margin:5vh auto;padding:28px}a{display:block;background:#183f34;color:white;padding:18px;border-radius:18px;text-align:center;text-decoration:none}p{line-height:1.6}@media(prefers-color-scheme:dark){body{background:#101b17;color:#edf3ea}}</style><svg role="img" aria-label="Split logo" width="72" height="72" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="240" fill="#d1f091"/><g fill="#12382b"><rect x="222" y="340" width="580" height="142" rx="71"/><rect x="222" y="542" width="580" height="142" rx="71"/></g><path d="M518 744H622L506 280H402Z" fill="#d1f091"/></svg><h1>Join a group on Split</h1><p>Join this group on the web or in the iOS app.</p><a href="https://split.yoinklabs.dev/invite/${invite[1]}">Continue on the web</a><br><a href="com.yoinklabs.split://join/${invite[1]}">Open Split</a><p><a href="https://testflight.apple.com/join/YX8W6bCx">Get Split on TestFlight</a></p><p>${invite[1].length===12 ? `You can also choose <b>Join group</b> in Split and enter <strong>${invite[1]}</strong>.` : "After installing Split, open this invitation again to claim your place."}</p>`,{headers:{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}});
   const emailLink = await emailLinkRoute(request, env);
   if (emailLink) return emailLink;
   const publicDevice = await deviceRoute(request, env);
   if (publicDevice) return publicDevice;
   const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];if(!token)throw new HTTPError(401,'Sign in to sync your expenses.');
   let userID:string;
   const device = (token.startsWith('spl_') || token.startsWith('sfi_')) ? await deviceIdentity(env, token) : null;
   if (device) userID = device.user_id;
   else try{const {payload}=await jwtVerify(token,jwks,{issuer:env.CLERK_ISSUER,algorithms:['RS256'],requiredClaims:['exp','sub','iat']});if(!payload.sub || !validParty(payload.azp, env.WEB_URL))throw 0;userID=payload.sub;}catch{throw new HTTPError(401,'Your session expired. Sign in again.');}
   if (url.pathname.startsWith('/v1/device/')) return await manageDevices(request, env, userID, device?.id);
   if (device?.scope === 'finance') return await financeRoute(request, env, userID, handle);
   if (url.pathname === '/mcp' || url.pathname === '/v1/cli') {
     if (!device) throw new HTTPError(403, 'Sign in with a Split device token.');
     if (device.is_remote && url.pathname === '/v1/cli') throw new HTTPError(403, 'Use the MCP endpoint with a remote token.');
     return await cliRoute(request, env, userID, handle);
   }
   if (device) throw new HTTPError(403, 'Use the CLI or MCP endpoint with a device token.');
   if (url.pathname==='/v1/snapshot' || url.pathname==='/v1/join' || url.pathname==='/v1/invitations') {
     await refreshIdentity(env,userID);
   }
   return await handle(request,env,userID);
  }catch(error){if(error instanceof Error && /Receipt inbox is full/.test(error.message)) return json({error:'This group’s receipt inbox is full. Pair or delete a receipt first.'},409);if(error instanceof Error && /Receipt limit reached|bytes BETWEEN/.test(error.message)) return json({error:'Receipt storage limit reached.'},409);if(error instanceof Error && /Group is full|Account group limit reached/.test(error.message)) return json({error:'Member or account group limit reached.'},409);if(error instanceof HTTPError)return json({error:error.message},error.status);if(error instanceof InputError)return json({error:error.message},422);console.error(JSON.stringify({event:'request_failed',type:error instanceof Error?error.name:'unknown'}));return json({error:'Could not save this change. Please retry.'},500);}
 }
} satisfies ExportedHandler<Env>;
