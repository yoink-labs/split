import { HTTPError } from './http';

declare global {
  interface Env {
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
  }
}

export const tokenHash = async (token: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function newInviteCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)),
    byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('');
}

export async function reserveMemberEmail(env: Env, sender: string, recipient: string) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new HTTPError(503, 'Group email is unavailable.');
  const now = Date.now();
  const id = crypto.randomUUID();
  const recipientHash = await tokenHash(recipient);
  // The rolling limits apply across the whole app and are reserved atomically.
  const [, result] = await env.DB.batch([
    env.DB.prepare('DELETE FROM member_email_attempts WHERE created_at <= ?').bind(now - 86400_000),
    env.DB.prepare(`INSERT INTO member_email_attempts(id, sender, recipient_hash, created_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT count(*) FROM member_email_attempts
        HAVING count(*) < 75
          AND count(CASE WHEN sender=? THEN 1 END) < 20
          AND count(CASE WHEN recipient_hash=? AND created_at>? THEN 1 END) = 0
      )`)
      .bind(id, sender, recipientHash, now, sender, recipientHash, now - 60_000),
  ]);
  if (!result.meta.changes) throw new HTTPError(429, 'Email send limit reached. Try again later.');
  return id;
}

class RejectedEmail extends HTTPError {
  constructor() { super(502, 'Could not send the email. Try again later.'); }
}

export async function sendMemberEmail(env: Env, id: string, to: string, subject: string, message: string) {
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': id,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text: message }),
    });
  } catch {
    // The provider may already have accepted the message when the connection dropped.
    throw new HTTPError(502, 'Could not confirm the email was sent. Try again later.');
  }
  await response.body?.cancel();
  if (response.ok) return;
  if (response.status >= 400 && response.status < 500) throw new RejectedEmail();
  throw new HTTPError(502, 'Could not confirm the email was sent. Try again later.');
}

export const activeGroupMember = 'EXISTS (SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL)';
export const activePlaceholder = `SELECT id FROM members WHERE group_id=? AND id=? AND user_id IS NULL AND removed_at IS NULL
  AND id NOT IN (SELECT member_id FROM member_aliases) AND ${activeGroupMember}`;

export async function requireActiveMember(env: Env, groupID: string, userID: string) {
  if (!await env.DB.prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL')
    .bind(groupID, userID).first()) throw new HTTPError(403, 'You are not a member of this group or your membership is archived.');
}

export async function emailInvitation(env: Env, groupID: string, memberID: string, userID: string,
  email: string, previousID?: string) {
  const args = [groupID, memberID, groupID, userID];
  if (!await env.DB.prepare(activePlaceholder).bind(...args).first())
    throw new HTTPError(404, 'Choose an active placeholder in this group.');

  const sendID = await reserveMemberEmail(env, userID, email);
  const code = newInviteCode();
  const digest = await tokenHash(code);
  const expiry = Date.now() + 7 * 86400_000;
  const previous = previousID
    ? 'WHERE EXISTS (SELECT 1 FROM invites WHERE group_id=? AND member_id=? AND token_hash=? AND recipient_email=?)'
    : '';
  const inserted = await env.DB.prepare(`INSERT INTO invites(token_hash,group_id,member_id,expires_at,recipient_email)
    SELECT ?,?,id,?,? FROM (${activePlaceholder}) ${previous}`)
    .bind(digest, groupID, expiry, email, ...args, ...(previousID ? [groupID, memberID, previousID, email] : [])).run();
  if (!inserted.meta.changes) throw new HTTPError(409, 'This invitation or placeholder has changed. Refresh and try again.');

  const discardIfRevoked = previousID ? env.DB.prepare(`DELETE FROM invites WHERE group_id=? AND token_hash=?
    AND NOT EXISTS (SELECT 1 FROM invites WHERE group_id=? AND token_hash=?)`)
    .bind(groupID, digest, groupID, previousID) : undefined;
  try {
    await sendMemberEmail(env, sendID, email, 'You’re invited to a group on Split',
      `Open this invitation within seven days and sign in to Split with this email address to claim your place.\n\n${env.APP_URL}/join/${code}`);
  } catch (error) {
    if (error instanceof RejectedEmail) {
      await env.DB.prepare('DELETE FROM invites WHERE group_id=? AND token_hash=?').bind(groupID, digest).run();
    } else {
      await discardIfRevoked?.run();
    }
    throw error;
  }
  const replaceOld = env.DB.prepare(`DELETE FROM invites WHERE group_id=? AND member_id=? AND recipient_email=?
    AND token_hash<>? AND expires_at<=?
    AND EXISTS (SELECT 1 FROM invites WHERE group_id=? AND token_hash=?)`)
    .bind(groupID, memberID, email, digest, expiry, groupID, digest);
  if (discardIfRevoked) {
    // A revoke during delivery must invalidate both links.
    const [revoked] = await env.DB.batch([discardIfRevoked, replaceOld]);
    if (revoked.meta.changes) throw new HTTPError(409, 'This invitation was revoked while the email was sending.');
  } else {
    await replaceOld.run();
  }
}
