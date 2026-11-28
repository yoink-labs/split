import { knownAccount } from './relationships';
import { itemSplit } from './items';
import { type Entry } from './ledger';

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
  const nights = new Map<string, number>();
  for (const split of entry.splits) {
    const id = aliases.get(split.memberID) ?? split.memberID;
    amounts.set(id, (amounts.get(id) ?? 0) + split.amount);
    if (split.nights !== undefined) nights.set(id, (nights.get(id) ?? 0) + split.nights);
  }
  const payerAmounts = new Map<string, number>();
  for (const payer of entry.payers ?? []) {
    const id = aliases.get(payer.memberID) ?? payer.memberID;
    payerAmounts.set(id, (payerAmounts.get(id) ?? 0) + payer.amount);
  }
  const payers = entry.payers?.length ? Array.from(payerAmounts, ([memberID, amount]) => ({memberID, amount})) : undefined;
  if(entry.bill) {
    const bill={...entry.bill,items:entry.bill.items.map(i=>{
      const seats=(i.roundingSeats??i.memberIDs).map(id=>aliases.get(id)??id);
      const memberIDs=[...new Set(seats)];
      if(!i.memberIDs.some(id=>aliases.has(id))) return i;
      const {shares,roundingSeats,roundingWeights,...item}=i;
      if(seats.length>memberIDs.length) {
        const weights=roundingWeights ?? (shares ? i.memberIDs.map(id=>Object.hasOwn(shares,id)?shares[id]:100) : undefined);
        return {...item,memberIDs,roundingSeats:seats,...(weights?{roundingWeights:weights}:{})};
      }
      const remapped=shares && Object.fromEntries(Object.entries(shares).map(([id,w])=>[aliases.get(id)??id,w]));
      return {...item,memberIDs,...(remapped?{shares:remapped}:{})};
    })};
    const paidBy=aliases.get(entry.paidBy)??entry.paidBy;
    return {...entry,bill,paidBy,splits:itemSplit(bill,paidBy),...(payers?{payers}:{})};
  }
  return {...entry, paidBy: aliases.get(entry.paidBy) ?? entry.paidBy, ...(payers?{payers}:{}),
    splits: Array.from(amounts, ([memberID, amount]) => ({memberID, amount, ...(nights.has(memberID) ? {nights: nights.get(memberID)} : {})}))};
}

// D1 serializes the batch. A simultaneous direct add, group join, or claim
// sees either the original seat or the completed merge.
// Evidence is the invitation that authorizes the claim. It is rechecked inside
// every statement so a revoke that races the claim wins.
export type ClaimEvidence = 'link' | 'direct' | { actor: string };
export async function claimSeat(db: D1Database, groupID: string, seatID: string, userID: string, tokenHash: string,
  evidence: ClaimEvidence = 'link') {
  const link = typeof evidence === 'object' ? evidence : null;
  const invite = link
    ? 'EXISTS (SELECT 1 FROM member_links WHERE id=? AND member_id=? AND group_id=? AND recipient=?)'
    : evidence === 'direct'
    ? `EXISTS (SELECT 1 FROM direct_invites WHERE id=? AND member_id=? AND group_id=? AND expires_at>? AND recipient=?
      AND EXISTS (SELECT 1 FROM members WHERE group_id=direct_invites.group_id AND user_id=direct_invites.inviter AND removed_at IS NULL))`
    : 'EXISTS (SELECT 1 FROM invites WHERE token_hash=? AND member_id=? AND group_id=? AND expires_at>?)';
  const inviteArgs: unknown[] = link ? [tokenHash,seatID,groupID,userID]
    : [tokenHash,seatID,groupID,Date.now(),...(evidence === 'direct' ? [userID] : [])];
  const eligible = 'id=? AND group_id=? AND user_id IS NULL AND removed_at IS NULL AND id NOT IN (SELECT member_id FROM member_aliases)';
  const audit = link ? [db.prepare(`INSERT INTO member_links(id,group_id,member_id,member_name,actor,recipient,created_at)
    SELECT ?,group_id,id,name,?,?,? FROM members WHERE ${eligible}
    AND EXISTS (SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL)
    AND EXISTS (SELECT 1 FROM split_profiles p WHERE p.user_id=? AND p.user_id<>? AND ${knownAccount})
    AND NOT EXISTS (SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NOT NULL)`)
    .bind(tokenHash,link.actor,userID,Date.now(),seatID,groupID,groupID,link.actor,userID,link.actor,link.actor,link.actor,link.actor,groupID,userID)] : [];
  const results = await db.batch([
    ...audit,
    db.prepare(`INSERT INTO member_aliases(member_id, canonical_id)
      SELECT target.id, existing.id FROM members target JOIN members existing ON existing.group_id=target.group_id
      WHERE target.id=? AND target.group_id=? AND target.user_id IS NULL AND target.removed_at IS NULL AND existing.user_id=? AND ${invite}
      ON CONFLICT(member_id) DO NOTHING`).bind(seatID, groupID, userID, ...inviteArgs),
    db.prepare(`UPDATE members SET user_id=? WHERE ${eligible} AND ${invite}`).bind(userID, seatID, groupID, ...inviteArgs),
  ]);
  if (link) return Boolean(results[0].meta.changes);
  return Boolean(await db.prepare(`SELECT m.id FROM members m LEFT JOIN member_aliases a ON a.member_id=m.id
    JOIN members owner ON owner.id=COALESCE(a.canonical_id,m.id)
    WHERE m.id=? AND m.group_id=? AND owner.user_id=? AND ${invite}`).bind(seatID,groupID,userID,...inviteArgs).first());
}

export async function saveProfile(db: D1Database, profile: Profile) {
  await db.prepare(`INSERT INTO split_profiles VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    name=excluded.name, username=excluded.username, email=excluded.email, refreshed_at=excluded.refreshed_at`)
    .bind(profile.userID, profile.name, profile.username, profile.email, Date.now()).run();
  if (!profile.email) return;
  // Claim one seat per new group first. Remaining matching seats in those
  // groups (including groups the user already belongs to) become aliases.
  const pending=`SELECT m.id,m.group_id FROM member_contacts c JOIN members m ON m.id=c.member_id
    LEFT JOIN member_aliases a ON a.member_id=m.id WHERE c.email=? AND m.user_id IS NULL AND m.removed_at IS NULL AND a.member_id IS NULL`;
  await db.batch([
    db.prepare(`UPDATE members SET user_id=? WHERE id IN (
      SELECT min(id) FROM (${pending}) WHERE group_id NOT IN (SELECT group_id FROM members WHERE user_id=?)
      GROUP BY group_id ORDER BY group_id LIMIT (SELECT max(0,100-count(*)) FROM members WHERE user_id=?))`)
      .bind(profile.userID,profile.email,profile.userID,profile.userID),
    db.prepare(`INSERT INTO member_aliases SELECT seats.id,owner.id FROM (${pending}) seats
      JOIN members owner ON owner.group_id=seats.group_id WHERE owner.user_id=?`).bind(profile.email,profile.userID)
  ]);
}

export async function fetchVerifiedProfile(env: Env, userID: string): Promise<Profile | null> {
  // Always verify current ownership before claiming an email-addressed seat.
  const request = new Request('https://api.clerk.com/v1/users/' + encodeURIComponent(userID), {
    headers:{Authorization:'Bearer '+env.CLERK_SECRET_KEY,Accept:'application/json','User-Agent':'Split-API/0.2'},
    redirect:'manual'
  });
  let response: Response;
  try { response = await fetch(request); }
  catch {
    console.warn(JSON.stringify({event:'identity_lookup_unavailable',type:'network'}));
    return null;
  }
  if (!response.ok) {
    // Identity enrichment can be retried. Never claim evidence from a stale profile.
    console.warn(JSON.stringify({event:'identity_lookup_unavailable',status:response.status}));
    return null;
  }
  const user: ClerkUser = await response.json();
  if (user.id !== userID) throw new Error('Identity mismatch');
  return verifiedProfile(user);
}

export async function refreshIdentity(env: Env, userID:string) {
  const recent=await env.DB.prepare(`SELECT p.user_id FROM split_profiles p WHERE p.user_id=? AND p.refreshed_at>?
    AND NOT EXISTS (SELECT 1 FROM member_contacts c JOIN members m ON m.id=c.member_id
      LEFT JOIN member_aliases a ON a.member_id=m.id WHERE c.email=p.email AND m.user_id IS NULL AND m.removed_at IS NULL AND a.member_id IS NULL)`)
    .bind(userID,Date.now()-300000).first();
  if (recent) return;
  const profile = await fetchVerifiedProfile(env,userID);
  if (profile) await saveProfile(env.DB, profile);
}

