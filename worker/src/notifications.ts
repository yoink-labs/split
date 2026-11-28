// Email notifications: preferences, signed unsubscribe links, invite emails
// and batched activity digests delivered by the 15-minute cron.
import { HTTPError, body, json } from './http';
import { InputError } from './ledger';
import { reserveMemberEmail, sendMemberEmail } from './memberEmail';
import {
  activityKinds, emailKinds, kindLabels, renderDigest, renderGroupInvite, renderPage,
  type ActivityItem, type ActivityKind, type EmailKind,
} from './emailTemplate';

declare global {
  interface Env {
    EMAIL_SIGNING_SECRET?: string;
    EMAIL_DIGEST_MINUTES?: string;
  }
}

type PreferenceKind = EmailKind | 'all';
const preferenceKinds: PreferenceKind[] = ['all', ...emailKinds];
const isPreferenceKind = (value: unknown): value is PreferenceKind =>
  typeof value === 'string' && (preferenceKinds as string[]).includes(value);

// Resend's free tier allows 100 emails a day. User-triggered emails stop at
// 75 a day (memberEmail.ts); automatic digests stop earlier so people can
// still send invitations when activity is busy.
const SYSTEM_DAILY_LIMIT = 60;
const SENDS_PER_RUN = 25;
const DAY = 86400_000;

export const logoURL = (env: Env) => `${env.WEB_URL}/icon.png`;

// ---------------------------------------------------------------- tokens

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function signingKey(env: Env) {
  const secret = env.EMAIL_SIGNING_SECRET || env.CLERK_SECRET_KEY;
  if (!secret) throw new HTTPError(503, 'Email links are unavailable.');
  // A dedicated key derived from the server secret, used only for email links.
  const material = await crypto.subtle.digest('SHA-256', encoder.encode('split-email-links-v1:' + secret));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** A per-user token for unsubscribe and preference links. It never expires. */
export async function emailToken(env: Env, userID: string) {
  const id = b64url(encoder.encode(userID));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode('v1.' + id));
  return id + '.' + b64url(new Uint8Array(signature));
}

export async function verifyEmailToken(env: Env, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 400) return null;
  const match = token.match(/^([A-Za-z0-9_-]{2,300})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await signingKey(env), fromB64url(match[2]), encoder.encode('v1.' + match[1]));
    if (!ok) return null;
    const userID = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(fromB64url(match[1]));
    return userID || null;
  } catch { return null; }
}

async function links(env: Env, userID: string, kind: EmailKind) {
  const token = await emailToken(env, userID);
  return {
    logoURL: logoURL(env),
    unsubscribeURL: `${env.APP_URL}/email/unsubscribe?t=${token}&k=${kind}`,
    preferencesURL: `${env.APP_URL}/email/preferences?t=${token}`,
  };
}

// ----------------------------------------------------------- preferences

export async function emailPreferences(db: D1Database, userID: string): Promise<Record<PreferenceKind, boolean>> {
  const rows = (await db.prepare('SELECT kind,enabled FROM email_preferences WHERE user_id=?').bind(userID)
    .all<{ kind: string; enabled: number }>()).results;
  const result = Object.fromEntries(preferenceKinds.map(k => [k, true])) as Record<PreferenceKind, boolean>;
  for (const row of rows) if (isPreferenceKind(row.kind)) result[row.kind] = Boolean(row.enabled);
  return result;
}

const allows = (prefs: Record<PreferenceKind, boolean>, kind: EmailKind) => prefs.all && prefs[kind];

export async function savePreferences(db: D1Database, userID: string, changes: Partial<Record<PreferenceKind, boolean>>) {
  const now = Date.now();
  const statements = Object.entries(changes).map(([kind, enabled]) =>
    db.prepare(`INSERT INTO email_preferences(user_id,kind,enabled,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,kind) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .bind(userID, kind, enabled ? 1 : 0, now));
  if (statements.length) await db.batch(statements);
}

function readChanges(value: Record<string, unknown>) {
  const source = value.preferences && typeof value.preferences === 'object' ? value.preferences as Record<string, unknown> : value;
  const changes: Partial<Record<PreferenceKind, boolean>> = {};
  for (const [kind, enabled] of Object.entries(source)) {
    if (!isPreferenceKind(kind) || typeof enabled !== 'boolean') throw new InputError('Choose on or off for each email type.');
    changes[kind] = enabled;
  }
  if (!Object.keys(changes).length) throw new InputError('Choose on or off for each email type.');
  return changes;
}

/** Signed-in routes: GET/POST /v1/email-preferences. Only the caller's own row is ever read or written. */
export async function preferencesRoute(request: Request, env: Env, userID: string) {
  if (new URL(request.url).pathname !== '/v1/email-preferences') return null;
  if (request.method === 'POST') await savePreferences(env.DB, userID, readChanges(await body(request)));
  else if (request.method !== 'GET') return null;
  return json({ preferences: await emailPreferences(env.DB, userID), labels: kindLabels });
}

// ------------------------------------------------------ public link pages

const page = (env: Env, status: number, o: Omit<Parameters<typeof renderPage>[0], 'logoURL'>) =>
  new Response(renderPage({ ...o, logoURL: logoURL(env) }), { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${env.WEB_URL}; form-action 'self'; frame-ancestors 'none'`,
  } });

/** Public routes under /email/*. A valid signed token is the only credential. */
export async function emailLinkRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/email/unsubscribe' && url.pathname !== '/email/preferences') return null;
  if (request.method !== 'GET' && request.method !== 'POST') return null;
  const token = url.searchParams.get('t') ?? '';
  const userID = await verifyEmailToken(env, token);
  if (!userID) return page(env, 400, { title: 'This link isn’t valid', message: 'Open the newest Split email, or change email settings in the Split app.' });
  const self = (query: string) => `${url.pathname}?t=${encodeURIComponent(token)}${query}`;

  if (url.pathname === '/email/unsubscribe') {
    const requested = url.searchParams.get('k');
    const kind: PreferenceKind = url.searchParams.get('all') === '1' || !isPreferenceKind(requested) ? 'all' : requested;
    if (request.method === 'GET') {
      // Mail scanners prefetch links, so a GET only shows the confirmation.
      return page(env, 200, kind === 'all'
        ? { title: 'Unsubscribe from Split email?', message: 'You will stop getting invitation and activity emails from Split.', form: { action: self('&all=1'), label: 'Turn off all Split email' } }
        : { title: 'Unsubscribe?', message: `Stop emails about: ${kindLabels[kind]}.`, form: {
            action: self('&k=' + kind), label: 'Turn these off', secondary: { action: self('&all=1'), label: 'Turn off all Split email' } } });
    }
    // RFC 8058 one-click unsubscribe also lands here.
    await savePreferences(env.DB, userID, { [kind]: false });
    return page(env, 200, { title: 'You’re unsubscribed', message: kind === 'all'
      ? 'Split won’t email you about invitations or activity. You can turn email back on in the app.'
      : `You won’t get emails about: ${kindLabels[kind]}.`, form: { action: `/email/preferences?t=${encodeURIComponent(token)}&undo=${kind}`, label: 'Undo' } });
  }

  if (request.method === 'POST') {
    const undo = url.searchParams.get('undo');
    if (isPreferenceKind(undo)) await savePreferences(env.DB, userID, { [undo]: true });
    const toggle = url.searchParams.get('toggle');
    if (isPreferenceKind(toggle)) {
      const current = await emailPreferences(env.DB, userID);
      await savePreferences(env.DB, userID, { [toggle]: !current[toggle] });
    }
  }
  return preferencesPage(env, userID, token);
}

async function preferencesPage(env: Env, userID: string, token: string) {
  const prefs = await emailPreferences(env.DB, userID);
  const rows = (['all', ...emailKinds] as PreferenceKind[]).map(kind => {
    const on = prefs[kind];
    const label = kind === 'all' ? 'All Split email' : kindLabels[kind];
    return `<form method="post" action="/email/preferences?t=${encodeURIComponent(token)}&toggle=${kind}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid rgba(127,140,133,.25);margin:0">
      <span>${label}${kind !== 'all' && !prefs.all ? ' <small style="opacity:.6">(paused)</small>' : ''}</span>
      <button type="submit" class="${on ? 'btn' : 'ghost'}" style="width:auto;padding:8px 16px;font-size:14px">${on ? 'On' : 'Off'}</button></form>`;
  }).join('');
  const html = renderPage({ title: 'Email preferences', message: 'Choose which emails Split sends you.', logoURL: logoURL(env) })
    .replace('</div></html>', rows + '</div></html>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${env.WEB_URL}; form-action 'self'; frame-ancestors 'none'` } });
}

// ------------------------------------------------------------ recipients

/** The verified sign-in address on file. Placeholders have no account and never get one. */
async function verifiedAddress(db: D1Database, userID: string) {
  return db.prepare('SELECT email FROM split_profiles WHERE user_id=? AND email IS NOT NULL').bind(userID).first<string>('email');
}

async function memberName(db: D1Database, groupID: string, userID: string) {
  return (await db.prepare(`SELECT COALESCE((SELECT name FROM members WHERE group_id=? AND user_id=?),
    (SELECT name FROM split_profiles WHERE user_id=?), 'A Split member') AS name`).bind(groupID, userID, userID).first<string>('name'))!;
}

function unsubscribeHeaders(unsubscribeURL: string) {
  return { 'List-Unsubscribe': `<${unsubscribeURL}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

async function reserveSystemEmail(env: Env, recipient: string) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const [, result] = await env.DB.batch([
    env.DB.prepare('DELETE FROM member_email_attempts WHERE created_at <= ?').bind(now - DAY),
    env.DB.prepare(`INSERT INTO member_email_attempts(id, sender, recipient_hash, created_at)
      SELECT ?, 'system:digest', ?, ? WHERE EXISTS (SELECT count(*) FROM member_email_attempts HAVING count(*) < ?)`)
      .bind(id, 'digest:' + recipient, now, SYSTEM_DAILY_LIMIT),
  ]);
  return result.meta.changes ? id : null;
}

// --------------------------------------------------------------- invites

/**
 * Emails a signed-up Split user that they were invited to (or added to) a
 * group. Best effort: returns false instead of throwing so the caller's
 * change still succeeds. The invite inbox lane calls this with added=false.
 */
export async function emailGroupInvite(env: Env, o: { groupID: string; inviterUserID: string; inviteeUserID: string; added?: boolean; url?: string }) {
  try {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || o.inviterUserID === o.inviteeUserID) return false;
    if (!allows(await emailPreferences(env.DB, o.inviteeUserID), 'invites')) return false;
    const to = await verifiedAddress(env.DB, o.inviteeUserID);
    if (!to) return false;
    const group = await env.DB.prepare('SELECT name FROM groups WHERE id=?').bind(o.groupID).first<string>('name');
    if (!group) return false;
    const sendID = await reserveMemberEmail(env, o.inviterUserID, 'account:' + o.inviteeUserID);
    const l = await links(env, o.inviteeUserID, 'invites');
    const url = o.url ?? (o.added ? `${env.WEB_URL}/g/${o.groupID}` : `${env.WEB_URL}/invites`);
    await sendMemberEmail(env, sendID, to, renderGroupInvite({ inviter: await memberName(env.DB, o.groupID, o.inviterUserID), group, url, added: o.added, ...l }),
      unsubscribeHeaders(l.unsubscribeURL));
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'invite_email_skipped', status: error instanceof HTTPError ? error.status : 'error' }));
    return false;
  }
}

// -------------------------------------------------------------- activity

export interface ActivityRecipient { memberID: string; share?: number; variant?: string }
export interface ActivityEvent {
  groupID: string;
  kind: ActivityKind;
  /** Stable id of the thing that happened (entry id, request id + action). Retries with the same id are ignored. */
  refID: string;
  actorUserID: string;
  recipients: ActivityRecipient[];
  title?: string;
  amount?: number;
  currency?: string;
}

/**
 * Queues an activity update for the next digest. Group seats are resolved to
 * their joined accounts; placeholders, removed members and the actor are
 * skipped. Never throws: a failed notification must not fail the change.
 * Other features (refunds, credits, pending expenses) call this hook.
 */
export async function notifyActivity(env: Env, event: ActivityEvent) {
  try {
    if (!(activityKinds as readonly string[]).includes(event.kind) || !event.recipients.length) return;
    const seats = (await env.DB.prepare(`SELECT m.id AS memberID, owner.user_id AS userID
      FROM json_each(?) j JOIN members m ON m.id=j.value AND m.group_id=?
      LEFT JOIN member_aliases a ON a.member_id=m.id
      JOIN members owner ON owner.id=COALESCE(a.canonical_id,m.id) AND owner.group_id=m.group_id
      WHERE owner.user_id IS NOT NULL AND owner.removed_at IS NULL AND owner.user_id<>?`)
      .bind(JSON.stringify(event.recipients.map(r => r.memberID)), event.groupID, event.actorUserID)
      .all<{ memberID: string; userID: string }>()).results;
    if (!seats.length) return;
    const owners = new Map(seats.map(s => [s.memberID, s.userID]));
    const perUser = new Map<string, ActivityRecipient>();
    for (const r of event.recipients) {
      const userID = owners.get(r.memberID);
      if (!userID) continue;
      const prior = perUser.get(userID);
      perUser.set(userID, { memberID: r.memberID, variant: prior?.variant ?? r.variant,
        share: r.share === undefined && prior?.share === undefined ? undefined : (prior?.share ?? 0) + (r.share ?? 0) });
    }
    const actor = await memberName(env.DB, event.groupID, event.actorUserID);
    const now = Date.now();
    await env.DB.batch([...perUser].map(([userID, r]) => {
      const item: ActivityItem = { kind: event.kind, actor, title: event.title, amount: event.amount, currency: event.currency, share: r.share, variant: r.variant };
      return env.DB.prepare(`INSERT INTO email_activity(id,user_id,group_id,kind,ref_id,data,created_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,ref_id) DO NOTHING`)
        .bind(crypto.randomUUID(), userID, event.groupID, event.kind, event.refID, JSON.stringify(item), now);
    }));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'activity_email_queue_failed', type: error instanceof Error ? error.name : 'unknown' }));
  }
}

/**
 * Sends at most one digest per user per group per window (default 15 minutes,
 * matching the cron). `now` should be the cron's scheduled time so the window
 * lines up with the schedule.
 */
export async function deliverDigests(env: Env, now = Date.now()) {
  const window = Math.max(1, Number(env.EMAIL_DIGEST_MINUTES) || 15) * 60_000;
  const report = { sent: 0, dropped: 0, deferred: 0, limited: false };
  // Keep history long enough to dedupe retries, and give up on undeliverable updates.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_activity WHERE created_at < ?').bind(now - 30 * DAY),
    env.DB.prepare('UPDATE email_activity SET sent_at=0 WHERE sent_at IS NULL AND created_at < ?').bind(now - 2 * DAY),
    env.DB.prepare('DELETE FROM email_digest_sends WHERE sent_at < ?').bind(now - 2 * DAY),
  ]);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return report;
  const due = (await env.DB.prepare(`SELECT a.user_id AS userID, a.group_id AS groupID FROM email_activity a
    LEFT JOIN email_digest_sends s ON s.user_id=a.user_id AND s.group_id=a.group_id
    WHERE a.sent_at IS NULL AND a.created_at <= ? AND (s.sent_at IS NULL OR s.sent_at <= ?)
    GROUP BY a.user_id, a.group_id ORDER BY min(a.created_at) LIMIT ?`)
    .bind(now, now - window, SENDS_PER_RUN).all<{ userID: string; groupID: string }>()).results;

  for (const { userID, groupID } of due) {
    const rows = (await env.DB.prepare(`SELECT id, kind, data FROM email_activity
      WHERE user_id=? AND group_id=? AND sent_at IS NULL AND created_at <= ? ORDER BY created_at LIMIT 50`)
      .bind(userID, groupID, now).all<{ id: string; kind: EmailKind; data: string }>()).results;
    const prefs = await emailPreferences(env.DB, userID);
    const group = await env.DB.prepare(`SELECT g.name FROM groups g JOIN members m ON m.group_id=g.id
      WHERE g.id=? AND m.user_id=? AND m.removed_at IS NULL`).bind(groupID, userID).first<string>('name');
    const to = group ? await verifiedAddress(env.DB, userID) : null;
    const wanted = to ? rows.filter(r => allows(prefs, r.kind)) : [];
    const skipped = rows.filter(r => !wanted.includes(r));
    const mark = (ids: string[], value: number) => ids.length
      ? env.DB.prepare(`UPDATE email_activity SET sent_at=? WHERE id IN (SELECT value FROM json_each(?))`).bind(value, JSON.stringify(ids))
      : null;
    const drop = mark(skipped.map(r => r.id), 0);
    if (drop) { await drop.run(); report.dropped += skipped.length; }
    if (!wanted.length || !to || !group) continue;

    const sendID = await reserveSystemEmail(env, userID);
    if (!sendID) {
      report.limited = true;
      console.warn(JSON.stringify({ event: 'email_daily_limit_reached', limit: SYSTEM_DAILY_LIMIT }));
      break;
    }
    const l = await links(env, userID, wanted[0].kind);
    // One digest can mix kinds; its unsubscribe link offers that kind or everything.
    const email = renderDigest({ group, items: wanted.map(r => JSON.parse(r.data) as ActivityItem), url: `${env.WEB_URL}/g/${groupID}`, ...l });
    try {
      await sendMemberEmail(env, sendID, to, email, unsubscribeHeaders(l.unsubscribeURL));
    } catch {
      report.deferred += wanted.length;
      console.warn(JSON.stringify({ event: 'digest_send_failed' }));
      continue;
    }
    await env.DB.batch([
      mark(wanted.map(r => r.id), now)!,
      env.DB.prepare(`INSERT INTO email_digest_sends(user_id,group_id,sent_at) VALUES (?,?,?)
        ON CONFLICT(user_id,group_id) DO UPDATE SET sent_at=excluded.sent_at`).bind(userID, groupID, now),
    ]);
    report.sent++;
  }
  return report;
}
