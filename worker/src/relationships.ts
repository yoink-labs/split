import { normalizeName } from './names';
import { paymentMethods } from './paymentProfiles';

export const activeSharedGroup = `EXISTS (
  SELECT 1 FROM members mine JOIN members theirs ON theirs.group_id=mine.group_id
  WHERE mine.user_id=? AND theirs.user_id=p.user_id
    AND mine.removed_at IS NULL AND theirs.removed_at IS NULL
)`;
const friendship = `EXISTS (SELECT 1 FROM friendships f WHERE f.accepted=1
  AND min(f.sender,f.recipient)=min(?,p.user_id)
  AND max(f.sender,f.recipient)=max(?,p.user_id))`;
export const knownAccount = `(${friendship} OR ${activeSharedGroup})`;
const card = 'p.user_id AS userID,p.name,(SELECT avatar_url FROM user_avatars WHERE user_id=p.user_id) AS avatarURL';

export async function listPeople(db: D1Database, actor: string, kind: 'friends' | 'known' | 'shared') {
  const predicate = kind === 'friends' ? friendship : kind === 'shared' ? activeSharedGroup : knownAccount;
  const args = Array.from({length: kind === 'friends' ? 2 : kind === 'known' ? 3 : 1}, () => actor);
  const payments = kind === 'friends'
    ? ',(SELECT details FROM account_payment_profiles WHERE user_id=p.user_id AND share_with_friends=1) AS sharedPayments'
    : '';
  const {results} = await db.prepare(`SELECT ${card}${payments} FROM split_profiles p WHERE p.user_id<>? AND ${predicate}
    ORDER BY p.name COLLATE NOCASE,p.user_id`).bind(actor, ...args).all<{userID: string; name: string; avatarURL: string | null; sharedPayments?: string | null}>();
  return results.map(({avatarURL, sharedPayments, ...person}) => ({
    ...person, name: normalizeName(person.name), ...(avatarURL ? {avatarURL} : {}), ...(sharedPayments ? {paymentMethods: paymentMethods(sharedPayments)} : {}),
  }));
}

export function knownPerson(db: D1Database, actor: string, target: unknown) {
  return db.prepare(`SELECT ${card} FROM split_profiles p WHERE p.user_id=? AND p.user_id<>? AND ${knownAccount}`)
    .bind(target, actor, actor, actor, actor).first<{userID: string; name: string; avatarURL: string | null}>();
}
