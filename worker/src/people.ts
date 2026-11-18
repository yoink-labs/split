import { InputError, type Entry } from './ledger';

export type Profile = {userID: string; name: string; username: string | null; email: string | null};
type ClerkUser = {
  id: string; first_name: string | null; last_name: string | null; username: string | null;
  primary_email_address_id: string | null;
  email_addresses: {id: string; email_address: string; verification?: {status: string}}[];
};

export function verifiedProfile(user: ClerkUser): Profile {
  const primary = user.email_addresses.find(address =>
    address.id === user.primary_email_address_id && address.verification?.status === 'verified');
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Split member';
  return {userID: user.id, name: name.slice(0, 60), email: primary?.email_address.trim().toLowerCase() ?? null, username: user.username};
}

// Keep old seat IDs valid for cached devices and immutable upload receipts.
// A duplicate seat resolves to the same person for both payer and portions.
export function resolveEntry(entry: Entry, aliases: Map<string,string>): Entry {
  if (!aliases.size) return entry;
  const amounts = new Map<string, number>();
  for (const split of entry.splits) {
    const id = aliases.get(split.memberID) ?? split.memberID;
    amounts.set(id, (amounts.get(id) ?? 0) + split.amount);
  }
  return {...entry, paidBy: aliases.get(entry.paidBy) ?? entry.paidBy,
    splits: Array.from(amounts, ([memberID, amount]) => ({memberID, amount}))};
}

// D1 serializes the batch. A simultaneous direct add, group join, or claim
// sees either the original seat or the completed merge.
export async function claimSeat(db: D1Database, groupID: string, seatID: string, userID: string) {
  const eligible = 'id=? AND group_id=? AND user_id IS NULL AND id NOT IN (SELECT member_id FROM member_aliases)';
  await db.batch([
    db.prepare(`INSERT INTO member_aliases(member_id, canonical_id)
      SELECT target.id, existing.id FROM members target JOIN members existing ON existing.group_id=target.group_id
      WHERE target.id=? AND target.group_id=? AND target.user_id IS NULL AND existing.user_id=?
      ON CONFLICT(member_id) DO NOTHING`).bind(seatID, groupID, userID),
    db.prepare(`UPDATE members SET user_id=? WHERE ${eligible}`).bind(userID, seatID, groupID),
  ]);
  return Boolean(await db.prepare(`SELECT m.id FROM members m LEFT JOIN member_aliases a ON a.member_id=m.id
    JOIN members owner ON owner.id=COALESCE(a.canonical_id,m.id)
    WHERE m.id=? AND m.group_id=? AND owner.user_id=?`).bind(seatID,groupID,userID).first());
}

export async function saveProfile(db: D1Database, profile: Profile) {
  await db.prepare(`INSERT INTO split_profiles VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    name=excluded.name, username=excluded.username, email=excluded.email, refreshed_at=excluded.refreshed_at`)
    .bind(profile.userID, profile.name, profile.username, profile.email, Date.now()).run();
  if (!profile.email) return;
  // Claim one seat per new group first. Remaining matching seats in those
  // groups (including groups the user already belongs to) become aliases.
  const pending=`SELECT m.id,m.group_id FROM member_contacts c JOIN members m ON m.id=c.member_id
    LEFT JOIN member_aliases a ON a.member_id=m.id WHERE c.email=? AND m.user_id IS NULL AND a.member_id IS NULL`;
  await db.batch([
    db.prepare(`UPDATE members SET user_id=? WHERE id IN (
      SELECT min(id) FROM (${pending}) WHERE group_id NOT IN (SELECT group_id FROM members WHERE user_id=?)
      GROUP BY group_id ORDER BY group_id LIMIT (SELECT max(0,100-count(*)) FROM members WHERE user_id=?))`)
      .bind(profile.userID,profile.email,profile.userID,profile.userID),
    db.prepare(`INSERT INTO member_aliases SELECT seats.id,owner.id FROM (${pending}) seats
      JOIN members owner ON owner.group_id=seats.group_id WHERE owner.user_id=?`).bind(profile.email,profile.userID)
  ]);
}

export async function refreshIdentity(env: Env, userID:string) {
  const recent=await env.DB.prepare(`SELECT p.user_id FROM split_profiles p WHERE p.user_id=? AND p.refreshed_at>?
    AND NOT EXISTS (SELECT 1 FROM member_contacts c JOIN members m ON m.id=c.member_id
      LEFT JOIN member_aliases a ON a.member_id=m.id WHERE c.email=p.email AND m.user_id IS NULL AND a.member_id IS NULL)`)
    .bind(userID,Date.now()-300000).first();
  if (recent) return;
  // Always verify current ownership before claiming an email-addressed seat.
  const request = new Request('https://api.clerk.com/v1/users/' + encodeURIComponent(userID), {
    headers:{Authorization:'Bearer '+env.CLERK_SECRET_KEY,Accept:'application/json','User-Agent':'Split-API/0.2'},
    redirect:'manual'
  });
  let response: Response;
  try { response = await fetch(request); }
  catch {
    console.warn(JSON.stringify({event:'identity_lookup_unavailable',type:'network'}));
    return;
  }
  if (!response.ok) {
    // Identity enrichment can be retried. Never claim evidence from a stale profile.
    console.warn(JSON.stringify({event:'identity_lookup_unavailable',status:response.status}));
    return;
  }
  const user: ClerkUser = await response.json();
  if (user.id !== userID) throw new Error('Identity mismatch');
  await saveProfile(env.DB, verifiedProfile(user));
}

export async function lookup(db: D1Database, userID: string, raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 254) throw new InputError('Enter a name, exact email, or username.');
  const hour = Math.floor(Date.now()/3600000);
  const count = await db.prepare(`INSERT INTO lookup_limits VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET
    attempts=CASE WHEN hour=excluded.hour THEN attempts+1 ELSE 1 END, hour=excluded.hour RETURNING attempts`)
    .bind(userID,hour).first<{attempts:number}>();
  if ((count?.attempts ?? 0) > 60) throw new InputError('Search limit reached. Try again in an hour.');
  const query=raw.trim();
  return (await db.prepare(`SELECT p.user_id AS userID,p.name,p.username FROM split_profiles p
    WHERE p.user_id != ? AND (p.email=? OR p.username=? OR
      (instr(lower(p.name),lower(?))>0 AND EXISTS (
        SELECT 1 FROM members mine JOIN members theirs ON mine.group_id=theirs.group_id
        WHERE mine.user_id=? AND theirs.user_id=p.user_id))) ORDER BY p.name LIMIT 15`)
    .bind(userID,query,query.replace(/^@/,''),query,userID).all()).results;
}
