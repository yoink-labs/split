// Known accounts, friend requests, and the invitation inbox.
import { HTTPError, body, json } from './http';
import { InputError } from './ledger';
import { activeGroupMember, activePlaceholder, requireActiveMember, tokenHash } from './memberEmail';
import { activeSharedGroup, knownAccount, knownPerson, listPeople } from './relationships';
import { claimSeat, fetchVerifiedProfile, refreshIdentity } from './people';

export const FRIEND_REQUESTS_PER_HOUR = 60;
export const DIRECT_INVITES_PER_HOUR = 20;
const INVITE_DAYS = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Invitation {
  id: string; kind: 'email' | 'direct' | 'friend' | 'linked'; groupID: string; groupName: string; groupKind: string;
  memberCount: number; inviterName?: string; memberName?: string; expiresAt: number;
}

const discoverable = `COALESCE((SELECT discoverable FROM people_settings WHERE user_id=p.user_id),1)=1`;
async function spendFriendRequest(db: D1Database, userID: string) {
  const hour = Math.floor(Date.now() / 3600000);
  const count = await db.prepare(`INSERT INTO lookup_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET
    attempts=CASE WHEN hour=excluded.hour THEN attempts+1 ELSE 1 END, hour=excluded.hour RETURNING attempts`)
    .bind(userID, hour).first<{attempts: number}>();
  if ((count?.attempts ?? 0) > FRIEND_REQUESTS_PER_HOUR) throw new HTTPError(429, 'Friend request limit reached. Try again in an hour.');
}

async function requestFriend(db: D1Database, actor: string, b: Record<string, unknown>) {
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const target = typeof b.userID === 'string' ? b.userID : '';
  if ((email && target) || (!email && !target) || (email && (email.length > 254 || !EMAIL.test(email))) || target.length > 128)
    throw new InputError('Enter a full email address or choose someone from a shared group.');
  await spendFriendRequest(db, actor);
  const now = Date.now();
  const match = email ? `p.email=? AND ${discoverable}` : `p.user_id=? AND ${activeSharedGroup}`;
  const args = email ? [email] : [target, actor];
  await db.prepare(`INSERT INTO friendships(id,sender,recipient,expires_at)
    SELECT ?,?,p.user_id,? FROM split_profiles p WHERE p.user_id<>? AND ${match}
    ON CONFLICT DO UPDATE SET id=excluded.id,sender=excluded.sender,recipient=excluded.recipient,expires_at=excluded.expires_at
    WHERE friendships.accepted=0 AND friendships.expires_at<=?`)
    .bind(await tokenHash(crypto.randomUUID()),actor,now+INVITE_DAYS*86400_000,actor,...args,now).run();
  // Uniform response for unavailable, opted-out, already pending, and unknown addresses.
  return json({ok:true},202);
}

async function respondPeople(db: D1Database, userID: string, id: string, action: 'accept' | 'decline') {
  const pending = 'id=? AND recipient=? AND accepted=0 AND expires_at>?';
  const result = await db.prepare(action === 'accept'
    ? `UPDATE friendships SET accepted=1 WHERE ${pending}`
    : `DELETE FROM friendships WHERE ${pending}`).bind(id,userID,Date.now()).run();
  if (result.meta.changes) return json({ok:true});
  const read = await db.prepare('UPDATE member_links SET read_at=? WHERE id=? AND recipient=? AND read_at IS NULL')
    .bind(Date.now(),id,userID).run();
  if (read.meta.changes) return json({ok:true, dismissed:true});
}

export async function isDiscoverable(db: D1Database, userID: string) {
  const value = await db.prepare('SELECT discoverable FROM people_settings WHERE user_id=?').bind(userID).first<number>('discoverable');
  return value !== 0;
}

async function inviteUser(env: Env, groupID: string, inviter: string, b: Record<string, unknown>) {
  await requireActiveMember(env, groupID, inviter);
  if (typeof b.userID !== 'string' || !b.userID || b.userID.length > 128) throw new InputError('Choose a friend or someone from a shared group.');
  const target = b.userID;
  if (target === inviter) throw new InputError('You are already in this group.');
  const memberID = b.memberID === undefined || b.memberID === null ? null : String(b.memberID);
  if (!await knownPerson(env.DB, inviter, target)) throw new HTTPError(404, 'Person not found.');
  if (await env.DB.prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL').bind(groupID, target).first())
    throw new HTTPError(409, 'This person is already in the group.');
  if (memberID && !await env.DB.prepare(activePlaceholder).bind(groupID, memberID, groupID, inviter).first())
    throw new HTTPError(404, 'Choose an active placeholder in this group.');
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT count(*) AS n FROM direct_invites WHERE inviter=? AND created_at>?')
    .bind(inviter, now - 3600_000).first<number>('n');
  if ((recent ?? 0) >= DIRECT_INVITES_PER_HOUR) throw new HTTPError(429, 'Invitation limit reached. Try again in an hour.');
  const id = await tokenHash(crypto.randomUUID());
  const saved = await env.DB.prepare(`INSERT INTO direct_invites(id,group_id,recipient,inviter,member_id,created_at,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE ${activeGroupMember}
    AND EXISTS (SELECT 1 FROM split_profiles p WHERE p.user_id=? AND ${knownAccount})
    ON CONFLICT(group_id,recipient) DO UPDATE SET inviter=excluded.inviter,member_id=excluded.member_id,
      created_at=excluded.created_at,expires_at=excluded.expires_at RETURNING id`)
    .bind(id, groupID, target, inviter, memberID, now, now + INVITE_DAYS * 86400_000, groupID, inviter, target, inviter, inviter, inviter).first<string>('id');
  if (!saved) throw new HTTPError(403, 'You are not a member of this group or your membership is archived.');
  return json({id: saved, expiresAt: now + INVITE_DAYS * 86400_000}, 201);
}

const notJoined = (group: string) => `NOT EXISTS (SELECT 1 FROM members x WHERE x.group_id=${group} AND x.user_id=? AND x.removed_at IS NULL)`;
const openSeat = `m.user_id IS NULL AND m.removed_at IS NULL AND m.id NOT IN (SELECT member_id FROM member_aliases)`;
const memberCount = (group: string) => `(SELECT count(*) FROM members c WHERE c.group_id=${group} AND c.removed_at IS NULL
  AND c.id NOT IN (SELECT member_id FROM member_aliases))`;
const directLive = `d.recipient=? AND d.expires_at>? AND EXISTS (SELECT 1 FROM members i WHERE i.group_id=d.group_id AND i.user_id=d.inviter AND i.removed_at IS NULL)`;
const emailLive = `i.recipient_email IS NOT NULL AND i.recipient_email=(SELECT email FROM split_profiles WHERE user_id=?) AND i.expires_at>?`;

/** Pending invitations addressed to this account, for groups it is not an active member of. */
export async function invitations(db: D1Database, userID: string): Promise<Invitation[]> {
  const now = Date.now();
  const {results} = await db.prepare(`SELECT * FROM (
      SELECT d.id,'direct' AS kind,g.id AS groupID,g.name AS groupName,g.kind AS groupKind,${memberCount('g.id')} AS memberCount,
        (SELECT name FROM split_profiles WHERE user_id=d.inviter) AS inviterName,
        (SELECT m.name FROM members m WHERE m.id=d.member_id AND m.group_id=d.group_id AND ${openSeat}) AS memberName,
        d.expires_at AS expiresAt
      FROM direct_invites d JOIN groups g ON g.id=d.group_id WHERE ${directLive} AND ${notJoined('d.group_id')}
    UNION ALL
      SELECT i.token_hash,'email',g.id,g.name,g.kind,${memberCount('g.id')},NULL,m.name,max(i.expires_at)
      FROM invites i JOIN groups g ON g.id=i.group_id JOIN members m ON m.id=i.member_id
      WHERE ${emailLive} AND ${openSeat} AND ${notJoined('i.group_id')} GROUP BY i.member_id
    UNION ALL
      SELECT f.id,'friend','','Friend request','',0,COALESCE(p.name,'Split member'),NULL,f.expires_at
      FROM friendships f LEFT JOIN split_profiles p ON p.user_id=f.sender
      WHERE f.recipient=? AND f.accepted=0 AND f.expires_at>?
    UNION ALL
      SELECT l.id,'linked',g.id,g.name,g.kind,0,p.name,l.member_name,l.created_at
      FROM member_links l JOIN groups g ON g.id=l.group_id LEFT JOIN split_profiles p ON p.user_id=l.actor
      WHERE l.recipient=? AND l.read_at IS NULL
        AND EXISTS (SELECT 1 FROM members m WHERE m.group_id=g.id AND m.user_id=l.recipient AND m.removed_at IS NULL)
    ) ORDER BY expiresAt DESC LIMIT 50`)
    .bind(userID, now, userID, userID, now, userID, userID, now, userID)
    .all<Invitation & {inviterName: string | null; memberName: string | null}>();
  return results.map(({inviterName, memberName, ...row}) => ({...row, memberCount: Number(row.memberCount),
    ...(inviterName ? {inviterName} : {}), ...(memberName ? {memberName} : {})}));
}

async function respond(env: Env, userID: string, id: string, action: 'accept' | 'decline') {
  const people = await respondPeople(env.DB,userID,id,action);
  if (people) return people;
  const now = Date.now();
  const direct = await env.DB.prepare(`SELECT d.group_id AS groupID,d.member_id AS memberID FROM direct_invites d WHERE d.id=? AND ${directLive}`)
    .bind(id, userID, now).first<{groupID: string; memberID: string | null}>();
  if (direct) {
    if (action === 'decline') {
      await env.DB.prepare('DELETE FROM direct_invites WHERE id=? AND recipient=?').bind(id, userID).run();
      return json({ok: true});
    }
    const claimed = direct.memberID ? await claimSeat(env.DB, direct.groupID, direct.memberID, userID, id, 'direct') : false;
    if (!claimed) {
      const name = await env.DB.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(userID).first<string>('name');
      const joined = await env.DB.prepare(`INSERT INTO members(id,group_id,user_id,name)
        SELECT ?,d.group_id,?,? FROM direct_invites d WHERE d.id=? AND ${directLive}
        ON CONFLICT(group_id,user_id) DO UPDATE SET removed_at=NULL`)
        .bind(crypto.randomUUID(), userID, name ?? 'Split member', id, userID, now).run();
      if (!joined.meta.changes) throw new HTTPError(404, 'Invitation not found.');
    }
    await env.DB.prepare('DELETE FROM direct_invites WHERE id=? AND recipient=?').bind(id, userID).run();
    await claimHistory(env, userID);
    return json({ok: true, groupID: direct.groupID});
  }
  // Email invitations are visible only to the account whose verified address received them.
  const email = /^[a-f0-9]{64}$/.test(id) ? await env.DB.prepare(`SELECT i.group_id AS groupID,i.member_id AS memberID,i.recipient_email AS recipient
    FROM invites i WHERE i.token_hash=? AND ${emailLive}`).bind(id, userID, now)
    .first<{groupID: string; memberID: string; recipient: string}>() : null;
  if (!email) throw new HTTPError(404, 'Invitation not found.');
  if (action === 'decline') {
    await env.DB.prepare('DELETE FROM invites WHERE token_hash=? AND recipient_email=?').bind(id, email.recipient).run();
    return json({ok: true});
  }
  const verified = await fetchVerifiedProfile(env, userID);
  if (!verified) throw new HTTPError(503, 'Could not verify your sign-in email. Try again later.');
  if (verified.email !== email.recipient.toLowerCase()) throw new HTTPError(404, 'Invitation not found.');
  if (!await claimSeat(env.DB, email.groupID, email.memberID, userID, id))
    throw new HTTPError(409, 'This invitation has expired or has already been claimed.');
  await claimHistory(env, userID);
  return json({ok: true, groupID: email.groupID});
}

// Other placeholders that list this account's verified email resolve to the
// same person through the existing sign-in claim.
async function claimHistory(env: Env, userID: string) {
  try { await refreshIdentity(env, userID); }
  catch { console.warn(JSON.stringify({event: 'claim_history_deferred'})); }
}

export async function directoryRoute(request: Request, env: Env, userID: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET') {
    if (path === '/v1/people/known') return json(await listPeople(env.DB,userID,'known'));
    if (path === '/v1/people/shared') return json(await listPeople(env.DB,userID,'shared'));
    if (path === '/v1/friends') return json(await listPeople(env.DB,userID,'friends'));
  }
  if (path === '/v1/friends/requests' && request.method === 'POST')
    return requestFriend(env.DB,userID,await body(request));
  const remove = path.match(/^\/v1\/friends\/([\w-]{1,128})\/remove$/);
  if (remove && request.method === 'POST') {
    const deleted = await env.DB.prepare(`DELETE FROM friendships WHERE accepted=1
      AND min(sender,recipient)=min(?,?) AND max(sender,recipient)=max(?,?)`)
      .bind(userID,remove[1],userID,remove[1]).run();
    if (!deleted.meta.changes) throw new HTTPError(404,'Friend not found.');
    return json({ok:true});
  }
  const link = path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/link$/);
  if (link && request.method === 'POST') {
    const [,groupID,memberID] = link;
    await requireActiveMember(env,groupID,userID);
    const b = await body(request);
    if (typeof b.userID !== 'string' || !await knownPerson(env.DB,userID,b.userID))
      throw new HTTPError(404,'Choose a friend or someone from a shared group.');
    const summary = await claimSeat(env.DB,groupID,memberID,b.userID,await tokenHash(crypto.randomUUID()),{actor:userID});
    if (!summary)
      throw new HTTPError(409,'This placeholder is no longer available to link.');
    return json({ok:true,...summary});
  }
  const activity = path.match(/^\/v1\/groups\/([\w-]+)\/member-links$/);
  if (activity && request.method === 'GET') {
    await requireActiveMember(env,activity[1],userID);
    const {results} = await env.DB.prepare(`SELECT l.id,l.member_name AS memberName,l.created_at AS createdAt,
      a.name AS actorName,p.name AS userName FROM member_links l
      LEFT JOIN split_profiles a ON a.user_id=l.actor LEFT JOIN split_profiles p ON p.user_id=l.recipient
      WHERE l.group_id=? AND ${activeGroupMember} ORDER BY l.created_at DESC LIMIT 50`)
      .bind(activity[1],activity[1],userID).all();
    return json({links:results});
  }
  if (path === '/v1/profile/discoverable') {
    if (request.method === 'GET') return json({discoverable: await isDiscoverable(env.DB, userID)});
    if (request.method !== 'POST') throw new HTTPError(404, 'Not found.');
    const b = await body(request);
    if (typeof b.discoverable !== 'boolean') throw new InputError('Choose whether people can find you.');
    await env.DB.prepare(`INSERT INTO people_settings(user_id,discoverable,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET discoverable=excluded.discoverable,updated_at=excluded.updated_at`)
      .bind(userID, b.discoverable ? 1 : 0, Date.now()).run();
    return json({discoverable: b.discoverable});
  }
  const direct = path.match(/^\/v1\/groups\/([\w-]+)\/invites\/direct$/);
  if (direct && request.method === 'POST') return inviteUser(env, direct[1], userID, await body(request));
  if (path === '/v1/invitations' && request.method === 'GET') return json({invitations: await invitations(env.DB, userID)});
  const answer = path.match(/^\/v1\/invitations\/([a-f0-9]{64})\/(accept|decline)$/);
  if (answer && request.method === 'POST') return respond(env, userID, answer[1], answer[2] as 'accept' | 'decline');
  return undefined;
}
