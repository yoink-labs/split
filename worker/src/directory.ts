// People search and the invite inbox.
//
// Privacy rules for the directory:
// - Results contain only the account ID, display name and avatar. Email
//   addresses, usernames and phone numbers never leave the Worker.
// - A query is a full email address (exact match against the verified primary
//   address) or a name prefix of at least three characters.
// - Each account may run a limited number of lookups per hour and sees at most
//   MAX_RESULTS people per query.
// - People who turn off "discoverable" never appear in search, and their
//   profile is visible only to people who already share a group with them.
import { HTTPError, body, json } from './http';
import { InputError } from './ledger';
import { activeGroupMember, activePlaceholder, requireActiveMember, tokenHash } from './memberEmail';
import { claimSeat, fetchVerifiedProfile, refreshIdentity } from './people';

export const SEARCH_LIMIT_PER_HOUR = 60;
export const MAX_RESULTS = 10;
export const MIN_NAME_PREFIX = 3;
export const DIRECT_INVITES_PER_HOUR = 20;
const INVITE_DAYS = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Person { userID: string; name: string; avatarURL?: string }
export interface Invitation {
  id: string; kind: 'email' | 'direct'; groupID: string; groupName: string; groupKind: string;
  memberCount: number; inviterName?: string; memberName?: string; expiresAt: number;
}

const discoverable = `COALESCE((SELECT discoverable FROM people_settings WHERE user_id=p.user_id),1)=1`;
const sharesGroup = `EXISTS (SELECT 1 FROM members mine JOIN members theirs ON theirs.group_id=mine.group_id
  WHERE mine.user_id=? AND mine.removed_at IS NULL AND theirs.user_id=p.user_id)`;
const avatar = '(SELECT avatar_url FROM user_avatars WHERE user_id=p.user_id) AS avatarURL';

function person(row: {userID: string; name: string; avatarURL: string | null}): Person {
  return {userID: row.userID, name: row.name, ...(row.avatarURL ? {avatarURL: row.avatarURL} : {})};
}

async function spendLookup(db: D1Database, userID: string) {
  const hour = Math.floor(Date.now() / 3600000);
  const count = await db.prepare(`INSERT INTO lookup_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET
    attempts=CASE WHEN hour=excluded.hour THEN attempts+1 ELSE 1 END, hour=excluded.hour RETURNING attempts`)
    .bind(userID, hour).first<{attempts: number}>();
  if ((count?.attempts ?? 0) > SEARCH_LIMIT_PER_HOUR) throw new HTTPError(429, 'Search limit reached. Try again in an hour.');
}

export function parseQuery(raw: unknown): {email: string} | {prefix: string} {
  const query = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!query || query.length > 254) throw new InputError('Enter a full email address or at least 3 letters of a name.');
  if (query.includes('@')) {
    if (!EMAIL.test(query)) throw new InputError('Enter a full email address, like name@example.com.');
    return {email: query.toLowerCase()};
  }
  if ([...query].length < MIN_NAME_PREFIX) throw new InputError('Enter at least 3 letters of a name.');
  if (query.length > 60) throw new InputError('Names are up to 60 characters.');
  return {prefix: query.toLowerCase().replace(/[\\%_]/g, '\\$&')};
}

export async function lookup(db: D1Database, userID: string, raw: unknown): Promise<Person[]> {
  const query = parseQuery(raw);
  await spendLookup(db, userID);
  const match = 'email' in query
    ? {sql: 'p.email=?', args: [query.email]}
    : {sql: `(lower(p.name) LIKE ? ESCAPE '\\' OR lower(p.name) LIKE ? ESCAPE '\\')`, args: [query.prefix + '%', '% ' + query.prefix + '%']};
  const {results} = await db.prepare(`SELECT p.user_id AS userID,p.name,${avatar} FROM split_profiles p
    WHERE p.user_id<>? AND ${discoverable} AND ${match.sql} ORDER BY p.name COLLATE NOCASE, p.user_id LIMIT ?`)
    .bind(userID, ...match.args, MAX_RESULTS).all<{userID: string; name: string; avatarURL: string | null}>();
  return results.map(person);
}

/** Someone the viewer may see: discoverable, or already sharing a group. */
async function visiblePerson(db: D1Database, viewer: string, target: string) {
  return db.prepare(`SELECT p.user_id AS userID,p.name,${avatar} FROM split_profiles p
    WHERE p.user_id=? AND p.user_id<>? AND (${discoverable} OR ${sharesGroup})`)
    .bind(target, viewer, viewer).first<{userID: string; name: string; avatarURL: string | null}>();
}

async function profile(db: D1Database, viewer: string, target: string) {
  await spendLookup(db, viewer);
  const row = await visiblePerson(db, viewer, target);
  if (!row) throw new HTTPError(404, 'Person not found.');
  // Only groups the viewer already belongs to, so nothing new is revealed.
  const {results} = await db.prepare(`SELECT g.id,g.name FROM groups g
    JOIN members mine ON mine.group_id=g.id AND mine.user_id=? AND mine.removed_at IS NULL
    JOIN members theirs ON theirs.group_id=g.id AND theirs.user_id=? ORDER BY g.name LIMIT 20`)
    .bind(viewer, target).all<{id: string; name: string}>();
  return {...person(row), sharedGroups: results};
}

export async function isDiscoverable(db: D1Database, userID: string) {
  const value = await db.prepare('SELECT discoverable FROM people_settings WHERE user_id=?').bind(userID).first<number>('discoverable');
  return value !== 0;
}

async function inviteUser(env: Env, groupID: string, inviter: string, b: Record<string, unknown>) {
  await requireActiveMember(env, groupID, inviter);
  if (typeof b.userID !== 'string' || !b.userID || b.userID.length > 128) throw new InputError('Choose a person from search results.');
  const target = b.userID;
  if (target === inviter) throw new InputError('You are already in this group.');
  const memberID = b.memberID === undefined || b.memberID === null ? null : String(b.memberID);
  if (!await visiblePerson(env.DB, inviter, target)) throw new HTTPError(404, 'Person not found.');
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
    ON CONFLICT(group_id,recipient) DO UPDATE SET inviter=excluded.inviter,member_id=excluded.member_id,
      created_at=excluded.created_at,expires_at=excluded.expires_at RETURNING id`)
    .bind(id, groupID, target, inviter, memberID, now, now + INVITE_DAYS * 86400_000, groupID, inviter).first<string>('id');
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
    ) ORDER BY expiresAt DESC LIMIT 50`)
    .bind(userID, now, userID, userID, now, userID)
    .all<Invitation & {inviterName: string | null; memberName: string | null}>();
  return results.map(({inviterName, memberName, ...row}) => ({...row, memberCount: Number(row.memberCount),
    ...(inviterName ? {inviterName} : {}), ...(memberName ? {memberName} : {})}));
}

async function respond(env: Env, userID: string, id: string, action: 'accept' | 'decline') {
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
  if (path === '/v1/people/search' && request.method === 'POST')
    return json(await lookup(env.DB, userID, (await body(request)).query));
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
  const profileMatch = path.match(/^\/v1\/people\/([\w-]{1,128})$/);
  if (profileMatch && request.method === 'GET' && profileMatch[1] !== 'search') return json(await profile(env.DB, userID, profileMatch[1]));
  const direct = path.match(/^\/v1\/groups\/([\w-]+)\/invites\/direct$/);
  if (direct && request.method === 'POST') return inviteUser(env, direct[1], userID, await body(request));
  if (path === '/v1/invitations' && request.method === 'GET') return json({invitations: await invitations(env.DB, userID)});
  const answer = path.match(/^\/v1\/invitations\/([a-f0-9]{64})\/(accept|decline)$/);
  if (answer && request.method === 'POST') return respond(env, userID, answer[1], answer[2] as 'accept' | 'decline');
  return undefined;
}
