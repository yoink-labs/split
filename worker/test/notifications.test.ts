import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { handle } from '../src/index';
import { deliverDigests, emailToken, notifyActivity, verifyEmailToken } from '../src/notifications';
import { money } from '../src/emailTemplate';

const alex = 'user-alex-email', maya = 'user-maya-email', sam = 'user-sam-email';
const group = 'group-email-1';
const settings = { ...env, RESEND_API_KEY: 'mock-resend', EMAIL_FROM: 'Split <split@yoinklabs.dev>' } as Env;
let sends: { to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> }[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

async function call(user: string, path: string, data?: unknown, bindings: Env = settings) {
  const init: RequestInit = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  return handle(new Request('https://split.test' + path, init), bindings, user);
}
const publicCall = (path: string, method = 'GET') =>
  worker.fetch(new Request('https://split.test' + path, { method }), settings, {} as ExecutionContext);

const expense = (id: string, splits: [string, number][], payer = 'seat-alex') => ({
  id, groupID: group, title: 'Dinner <b>', amount: splits.reduce((n, [, a]) => n + a, 0), currency: 'USD', paidBy: payer,
  splits: splits.map(([memberID, amount]) => ({ memberID, amount })), kind: 'expense', splitMode: 'exact', createdAt: '2026-11-20T00:00:00Z',
});

beforeEach(async () => {
  sends = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === 'https://api.resend.com/emails') sends.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });
  for (const [id, name, mail] of [[maya, 'Maya', 'maya@example.test'], [sam, 'Sam', 'sam@example.test'], [alex, 'Alex', 'alex@example.test']])
    await env.DB.prepare('INSERT INTO split_profiles VALUES (?,?,?,?,?)').bind(id, name, null, mail, Date.now()).run();
  await call(alex, '/v1/groups', { id: group, name: 'Lisbon', kind: 'trip', currency: 'USD', members: [
    { id: 'seat-alex', userID: alex, name: 'Alex' },
    { id: 'seat-maya', userID: maya, name: 'Maya' },
    { id: 'seat-casey', name: 'Casey', email: 'casey-placeholder@example.test' },
  ] });
});
afterEach(() => fetchSpy.mockRestore());

it('stores per-user preferences and only ever returns the caller’s own', async () => {
  const fresh = await (await call(maya, '/v1/email-preferences')).json<any>();
  expect(Object.values(fresh.preferences).every(Boolean)).toBe(true);
  expect(Object.keys(fresh.preferences)).toEqual(['all', 'invites', 'expenses', 'payments', 'settleRequests', 'credits', 'pendingResolved']);
  const saved = await (await call(maya, '/v1/email-preferences', { preferences: { expenses: false, payments: false } })).json<any>();
  expect(saved.preferences).toMatchObject({ expenses: false, payments: false, invites: true, all: true });
  expect((await (await call(alex, '/v1/email-preferences')).json<any>()).preferences.expenses).toBe(true);
  await expect(call(maya, '/v1/email-preferences', { marketing: false })).rejects.toThrow('Choose on or off');
  await expect(call(maya, '/v1/email-preferences', { expenses: 'no' })).rejects.toThrow('Choose on or off');
  await expect(call(maya, '/v1/email-preferences', { userID: alex, expenses: false })).rejects.toThrow('Choose on or off');
});

it('validates signed unsubscribe tokens and never changes anything on GET', async () => {
  const token = await emailToken(settings, maya);
  expect(await verifyEmailToken(settings, token)).toBe(maya);
  const [id, sig] = token.split('.');
  const alexID = (await emailToken(settings, alex)).split('.')[0];
  for (const bad of [alexID + '.' + sig, id + '.' + sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA'), 'garbage', '', id, token + 'x'])
    expect(await verifyEmailToken(settings, bad)).toBeNull();
  // A different signing secret rejects the token.
  expect(await verifyEmailToken({ ...settings, EMAIL_SIGNING_SECRET: 'other' } as Env, token)).toBeNull();

  const forged = await publicCall(`/email/unsubscribe?t=${alexID}.${sig}&k=expenses`, 'POST');
  expect(forged.status).toBe(400);
  expect((await (await call(alex, '/v1/email-preferences')).json<any>()).preferences.expenses).toBe(true);

  const confirm = await publicCall(`/email/unsubscribe?t=${token}&k=expenses`);
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain('New expenses that include you');
  expect((await (await call(maya, '/v1/email-preferences')).json<any>()).preferences.expenses).toBe(true);

  expect((await publicCall(`/email/unsubscribe?t=${token}&k=expenses`, 'POST')).status).toBe(200);
  expect((await (await call(maya, '/v1/email-preferences')).json<any>()).preferences).toMatchObject({ expenses: false, all: true });
  await publicCall(`/email/unsubscribe?t=${token}&all=1`, 'POST');
  expect((await (await call(maya, '/v1/email-preferences')).json<any>()).preferences.all).toBe(false);
  await publicCall(`/email/preferences?t=${token}&undo=all`, 'POST');
  expect((await (await call(maya, '/v1/email-preferences')).json<any>()).preferences.all).toBe(true);
  const prefsPage = await (await publicCall(`/email/preferences?t=${token}`)).text();
  expect(prefsPage).not.toContain('maya@example.test');
});

it('emails one digest to joined members only, without other members’ addresses', async () => {
  await call(alex, '/v1/entries', expense('entry-email-1', [['seat-alex', 1000], ['seat-maya', 1001], ['seat-casey', 999]]));
  const report = await deliverDigests(settings, Date.now() + 1000);
  expect(report).toMatchObject({ sent: 1 });
  expect(sends).toHaveLength(1);
  const [mail] = sends;
  expect(mail.to).toEqual(['maya@example.test']);
  expect(mail.subject).toBe('Alex added “Dinner <b>” · $30.00 in Lisbon');
  expect(mail.text).toContain('Your share: $10.01');
  expect(mail.html).toContain('Dinner &lt;b&gt;');
  expect(mail.html).toContain('prefers-color-scheme:dark');
  expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  const blob = JSON.stringify(sends);
  for (const other of ['alex@example.test', 'casey-placeholder@example.test', 'sam@example.test']) expect(blob).not.toContain(other);
  const unsubscribe = mail.headers!['List-Unsubscribe'].slice(1, -1);
  expect(await verifyEmailToken(settings, new URL(unsubscribe).searchParams.get('t'))).toBe(maya);
});

it('never emails placeholders, unverified accounts, removed members or opted-out users', async () => {
  await env.DB.prepare('UPDATE split_profiles SET email=NULL WHERE user_id=?').bind(maya).run();
  await call(alex, '/v1/entries', expense('entry-email-2', [['seat-maya', 500], ['seat-casey', 500]]));
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends).toEqual([]);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM email_activity WHERE sent_at IS NULL').first('n')).toBe(0);

  await env.DB.prepare('UPDATE split_profiles SET email=? WHERE user_id=?').bind('maya@example.test', maya).run();
  await call(maya, '/v1/email-preferences', { expenses: false });
  await call(alex, '/v1/entries', expense('entry-email-3', [['seat-maya', 500]]));
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends).toEqual([]);

  await call(maya, '/v1/email-preferences', { expenses: true });
  await call(alex, '/v1/entries', expense('entry-email-4', [['seat-maya', 500]]));
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind(new Date().toISOString(), 'seat-maya').run();
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends).toEqual([]);
});

it('sends at most one activity email per user per group per window and batches the rest', async () => {
  const start = Date.now() + 1000;
  await call(alex, '/v1/entries', expense('entry-rate-1', [['seat-maya', 500]]));
  // Retrying the same request does not queue it twice.
  await call(alex, '/v1/entries', expense('entry-rate-1', [['seat-maya', 500]]));
  expect((await deliverDigests(settings, start)).sent).toBe(1);
  await call(alex, '/v1/entries', expense('entry-rate-2', [['seat-maya', 700]]));
  await call(alex, '/v1/entries', expense('entry-rate-3', [['seat-maya', 900]]));
  expect((await deliverDigests(settings, start + 5 * 60_000)).sent).toBe(0);
  expect((await deliverDigests(settings, start + 15 * 60_000)).sent).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[1].subject).toBe('2 updates in Lisbon');
  expect(sends[1].text).not.toContain('$5.00');
  expect((await deliverDigests(settings, start + 30 * 60_000)).sent).toBe(0);
});

it('stops automatic email before the shared daily free-tier budget runs out', async () => {
  const now = Date.now();
  await env.DB.batch(Array.from({ length: 60 }, (_, i) => env.DB.prepare('INSERT INTO member_email_attempts VALUES (?,?,?,?)')
    .bind('fill-' + i, 'someone', 'hash-' + i, now)));
  await call(alex, '/v1/entries', expense('entry-cap-1', [['seat-maya', 500]]));
  expect(await deliverDigests(settings, now + 1000)).toMatchObject({ sent: 0, limited: true });
  expect(sends).toEqual([]);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM email_activity WHERE sent_at IS NULL').first('n')).toBe(1);
});

it('queues payments, settle-up requests and hook events for the right person', async () => {
  const payment = { ...expense('pay-email-1', [['seat-maya', 2500]]), kind: 'settlement', splitMode: 'exact', title: 'Payment' };
  await call(alex, '/v1/settlements', payment);
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends.map(s => [s.to[0], s.subject])).toEqual([['maya@example.test', 'Alex asked you to confirm a $25.00 payment in Lisbon']]);

  await call(maya, '/v1/settlements/pay-email-1/approve', {});
  await notifyActivity(settings, { groupID: group, kind: 'credits', refID: 'refund-1', actorUserID: maya, title: 'Museum',
    amount: 1200, currency: 'USD', recipients: [{ memberID: 'seat-alex', variant: 'refund' }, { memberID: 'seat-casey' }] });
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends).toHaveLength(2);
  expect(sends[1].to).toEqual(['alex@example.test']);
  expect(sends[1].text).toContain('Maya confirmed your $25.00 payment');
  expect(sends[1].text).toContain('Maya recorded a $12.00 refund to you');
});

it('emails a Split user who is added to a group unless invitations are off', async () => {
  expect((await call(alex, `/v1/groups/${group}/members`, { id: 'seat-sam-1', name: 'Sam', userID: sam })).status).toBe(201);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: ['sam@example.test'], subject: 'Alex added you to Lisbon' });
  expect(sends[0].html).toContain('https://split.yoinklabs.dev/g/' + group);

  await env.DB.prepare('DELETE FROM members WHERE id=?').bind('seat-sam-1').run();
  await env.DB.prepare('DELETE FROM member_email_attempts').run();
  await call(sam, '/v1/email-preferences', { invites: false });
  await call(alex, `/v1/groups/${group}/members`, { id: 'seat-sam-2', name: 'Sam', userID: sam });
  expect(sends).toHaveLength(1);
});

it('formats money exactly from minor units', () => {
  expect(money(123456, 'USD')).toBe('$1,234.56');
  expect(money(5, 'USD')).toBe('$0.05');
  expect(money(1500, 'JPY')).toBe('¥1,500');
  expect(money(1234, 'KWD')).toMatch(/^KWD\s1\.234$/);
});

it('emails refunds, credits and resolved pending expenses to the people they affect', async () => {
  const dinner = { ...expense('entry-pend-1', [['seat-alex', 3000], ['seat-maya', 3000]]), pending: true };
  await call(alex, '/v1/entries', dinner);
  await deliverDigests(settings, Date.now() + 1000);
  expect(sends).toHaveLength(1);

  expect((await call(alex, '/v1/entries/entry-pend-1/resolve', { action: 'adjust', amount: 5000 })).status).toBe(200);
  const credit = { id: 'credit-email-1', groupID: group, kind: 'refund', title: 'Deposit back', amount: 800, currency: 'USD', paidBy: 'seat-alex',
    splits: [{ memberID: 'seat-maya', amount: 800 }], splitMode: 'exact', createdAt: '2026-11-21T00:00:00Z' };
  await call(alex, '/v1/entries', credit);
  const refund = { ...credit, id: 'refund-email-1', title: 'Refund: Dinner', amount: 500, refundOf: 'entry-pend-1', splits: [{ memberID: 'seat-maya', amount: 500 }] };
  await call(alex, '/v1/entries', refund);
  await deliverDigests(settings, Date.now() + 16 * 60_000);
  expect(sends).toHaveLength(2);
  expect(sends[1].to).toEqual(['maya@example.test']);
  expect(sends[1].text).toContain('Alex resolved the pending expense “Dinner <b>”');
  expect(sends[1].text).toContain('Your share: $25.00');
  expect(sends[1].text).toContain('Alex recorded a $8.00 credit to you');
  expect(sends[1].text).toContain('Alex recorded a $5.00 refund to you');
  expect(sends[1].text).not.toContain('Alex added');
});
