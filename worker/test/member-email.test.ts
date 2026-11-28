import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { handle } from '../src/index';

const owner = 'member-email-owner';
const guest = 'member-email-guest';
const groupID = 'member-email-group';
const groupPath = '/v1/groups/' + groupID;
const seat = 'member-email-seat';
const seatPath = groupPath + '/members/' + seat;
const address = 'casey@example.test';
const settings = { ...env, RESEND_API_KEY: 'mock-resend', EMAIL_FROM: 'Split <split@yoinklabs.dev>' };

function call(path: string, data?: unknown, userID = owner, bindings: Env = settings) {
  return handle(new Request('https://split.test' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }), bindings, userID);
}

async function setup() {
  await call('/v1/groups', { id: groupID, name: 'Trip', kind: 'trip', currency: 'USD', members: [
    { id: 'owner-seat', userID: owner, name: 'Owner' },
    { id: seat, name: 'Casey', email: 'claim@example.test', phone: '555-0102' },
  ] });
}

function identity(userID: string, email: string, verified = true) {
  return Response.json({ id: userID, first_name: 'Casey', last_name: null, username: null,
    primary_email_address_id: 'primary', email_addresses: [
      { id: 'primary', email_address: email, verification: { status: verified ? 'verified' : 'unverified' } },
    ] });
}

type Invitation = { id: string; recipientEmail?: string; memberID?: string };
async function invitations() {
  return (await (await call(groupPath + '/invites')).json<{ invites: Invitation[] }>()).invites;
}

async function clearCooldown() {
  await env.DB.prepare('UPDATE member_email_attempts SET created_at=0').run();
}

it('shows pending claim emails only to active group members', async () => {
  await setup();
  expect(await (await call(groupPath + '/members')).json()).toEqual({
    claimEmails: [{ memberID: seat, email: 'claim@example.test' }],
  });
  expect(await (await call('/v1/snapshot')).text()).not.toContain('claim@example.test');
  await expect(call(groupPath + '/members', undefined, guest)).rejects.toMatchObject({ status: 403 });

  const { code } = await (await call(groupPath + '/invites', {})).json<{ code: string }>();
  await call('/v1/join', { token: code }, guest);
  const guestSeat = await env.DB.prepare('SELECT id FROM members WHERE user_id=? AND group_id=?')
    .bind(guest, groupID).first<string>('id');
  await call(groupPath + '/members/' + guestSeat + '/remove', { mode: 'archive' });
  for (const route of [groupPath + '/members', groupPath + '/invites']) {
    await expect(call(route, undefined, guest)).rejects.toMatchObject({ status: 403 });
  }
  await expect(call(seatPath + '/invite-email', { email: address }, guest)).rejects.toMatchObject({ status: 403 });
});

it('emails a claim link to the selected address and requires current verified ownership', async () => {
  await setup();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(call(seatPath + '/invite-email', { email: 'bad' })).rejects.toThrow('Check the email');
    await expect(call(groupPath + '/members/other-seat/invite-email', { email: address })).rejects.toMatchObject({ status: 404 });
    await expect(call(seatPath + '/invite-email', { email: address }, guest)).rejects.toMatchObject({ status: 403 });
    await expect(call(seatPath + '/invite-email', { email: address }, owner, env)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect((await call(seatPath + '/invite-email', { email: 'Casey@EXAMPLE.TEST' })).ok).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer mock-resend', 'Idempotency-Key': expect.any(String) });
    const send = JSON.parse(String(init?.body));
    expect(send.to).toEqual([address]);
    const token = send.text.split('/join/').at(-1);
    expect(token).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    expect((await invitations())[0]).toMatchObject({ memberID: seat, recipientEmail: address });
    expect(JSON.stringify(await invitations())).not.toContain(token);

    await expect(call(seatPath + '/invite-email', { email: address })).rejects.toMatchObject({ status: 429 });
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await call(seatPath + '/invite-email', { email: 'alternate@example.test' });
    await call(groupPath + '/invites', { memberID: seat });
    expect(await invitations()).toHaveLength(3);
    expect(await (await call(groupPath + '/members')).json()).toMatchObject({
      claimEmails: [{ memberID: seat, email: 'claim@example.test' }],
    });

    fetch.mockResolvedValueOnce(identity(guest, 'someone-else@example.test'));
    await expect(call('/v1/join', { token }, guest)).rejects.toMatchObject({ status: 403 });
    fetch.mockResolvedValueOnce(identity(guest, address, false));
    await expect(call('/v1/join', { token }, guest)).rejects.toMatchObject({ status: 403 });
    fetch.mockResolvedValueOnce(identity(guest, address));
    expect((await call('/v1/join', { token }, guest)).ok).toBe(true);
    expect(await invitations()).toEqual([]);
    expect(await env.DB.prepare('SELECT user_id FROM members WHERE id=?').bind(seat).first('user_id')).toBe(guest);
  } finally { fetch.mockRestore(); }
});

it('resends to the original recipient, preserves the old invite on rejection, and supports revocation', async () => {
  await setup();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await call(seatPath + '/invite-email', { email: address });
    const [original] = await invitations();
    const resend = groupPath + '/invites/' + original.id + '/resend';
    await expect(call(resend, {}, guest)).rejects.toMatchObject({ status: 403 });
    await clearCooldown();

    fetch.mockResolvedValueOnce(new Response(null, { status: 422 }));
    await expect(call(resend, {})).rejects.toMatchObject({ status: 502 });
    expect(await invitations()).toEqual([original]);
    await clearCooldown();

    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await call(resend, { email: 'ignored@example.test' });
    const outgoing = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
    expect(outgoing.to).toEqual([address]);
    const [updated] = await invitations();
    expect(updated.id).not.toBe(original.id);
    expect(await invitations()).toHaveLength(1);
    await call(groupPath + '/invites/' + updated.id + '/revoke', {});
    await expect(call('/v1/join', { token: outgoing.text.split('/join/').at(-1) }, guest)).rejects.toMatchObject({ status: 404 });
  } finally { fetch.mockRestore(); }
});

it('sends a sign-in reminder only to the joined member’s current verified address', async () => {
  await setup();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const path = groupPath + '/members/owner-seat/sign-in-email';
  try {
    await expect(call(path, {}, guest)).rejects.toMatchObject({ status: 403 });
    await expect(call(seatPath + '/sign-in-email', {})).rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(identity(owner, address, false));
    await expect(call(path, {})).rejects.toMatchObject({ status: 422 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await clearCooldown();
    fetch.mockResolvedValueOnce(identity(owner, address));
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await (await call(path, { email: 'ignored@example.test' })).json()).toEqual({ ok: true });
    const reminder = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
    expect(reminder).toMatchObject({
      to: [address], subject: 'Sign in to Split', text: expect.stringContaining(settings.WEB_URL + '/g/' + groupID),
    });
    await expect(call(path, {})).rejects.toMatchObject({ status: 429 });
  } finally { fetch.mockRestore(); }
});

it('keeps revocation effective when it overlaps with a resend', async () => {
  await setup();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await call(seatPath + '/invite-email', { email: address });
    const [original] = await invitations();
    const oldPath = groupPath + '/invites/' + original.id;
    await clearCooldown();
    fetch.mockImplementationOnce(async () => {
      await call(oldPath + '/revoke', {});
      return new Response(null, { status: 200 });
    });
    await expect(call(oldPath + '/resend', {})).rejects.toMatchObject({ status: 409 });
    expect(await invitations()).toEqual([]);
  } finally { fetch.mockRestore(); }
});
