import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handle } from '../src/index';
import { saveProfile } from '../src/people';
import { InputError } from '../src/ledger';
import { DIRECT_INVITES_PER_HOUR, MAX_RESULTS, SEARCH_LIMIT_PER_HOUR } from '../src/directory';

const owner = 'dir-owner', casey = 'dir-casey', mallory = 'dir-mallory';
const groupID = 'dir-group-0001', groupPath = '/v1/groups/' + groupID;
const settings = { ...env, RESEND_API_KEY: 'mock-resend', EMAIL_FROM: 'Split <split@yoinklabs.dev>' };

function call(user: string, path: string, data?: unknown) {
  return handle(new Request('https://split.test' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }), settings, user);
}
const read = async <T = any>(user: string, path: string, data?: unknown) => (await call(user, path, data)).json<T>();
const search = (user: string, query: string) => read<any[]>(user, '/v1/people/search', { query });
const inbox = async (user: string) => (await read<{ invitations: any[] }>(user, '/v1/invitations')).invitations;

async function people() {
  await saveProfile(env.DB, { userID: owner, name: 'Olive Owner', username: 'olive', email: 'olive@example.test' });
  await saveProfile(env.DB, { userID: casey, name: 'Casey Green', username: 'caseyg', email: 'casey@example.test' });
  await saveProfile(env.DB, { userID: mallory, name: 'Mallory Stone', username: 'mal', email: 'mallory@example.test' });
  await call(owner, '/v1/groups', { id: groupID, name: 'Lisbon', kind: 'trip', currency: 'EUR', members: [
    { id: 'dir-seat-owner', userID: owner, name: 'Olive' },
    { id: 'dir-seat-casey', name: 'Casey (placeholder)' },
  ] });
}
function identity(userID: string, email: string) {
  return Response.json({ id: userID, first_name: 'Casey', last_name: null, username: null, primary_email_address_id: 'primary',
    email_addresses: [{ id: 'primary', email_address: email, verification: { status: 'verified' } }] });
}

describe('people search', () => {
  it('returns only an ID, display name and avatar, for a full email or a 3+ letter name prefix', async () => {
    await people();
    await call(casey, '/v1/profile/avatar', { avatarURL: 'preset:fern' });
    const found = await search(owner, 'CASEY@example.test');
    expect(found).toEqual([{ userID: casey, name: 'Casey Green', avatarURL: 'preset:fern' }]);
    expect(JSON.stringify(found)).not.toMatch(/example\.test|caseyg/);
    expect(await search(owner, 'cas')).toEqual([{ userID: casey, name: 'Casey Green', avatarURL: 'preset:fern' }]);
    expect(await search(owner, 'gre')).toHaveLength(1); // a later word in the name
    expect(await search(owner, 'een')).toEqual([]); // prefixes only, never substrings
    expect(await search(owner, 'olive')).toEqual([]); // never yourself
    expect(await search(owner, '%%%')).toEqual([]);
    for (const query of ['ca', 'casey@', '@caseyg', 'casey@example', ' ', 'x'.repeat(255)])
      await expect(call(owner, '/v1/people/search', { query })).rejects.toBeInstanceOf(InputError);
  });

  it('caps the number of results', async () => {
    for (let i = 0; i < MAX_RESULTS + 5; i++)
      await saveProfile(env.DB, { userID: 'dir-many-' + i, name: 'Sam ' + i, username: null, email: null });
    expect(await search(owner, 'sam')).toHaveLength(MAX_RESULTS);
  });

  it('rate-limits each account per hour without affecting others', async () => {
    await people();
    for (let i = 0; i < SEARCH_LIMIT_PER_HOUR; i++) await search(owner, 'casey');
    await expect(call(owner, '/v1/people/search', { query: 'casey' })).rejects.toMatchObject({ status: 429 });
    await expect(call(owner, '/v1/people/' + casey)).rejects.toMatchObject({ status: 429 });
    expect(await search(mallory, 'casey')).toHaveLength(1);
    await env.DB.prepare('UPDATE lookup_limits SET hour=0 WHERE user_id=?').bind(owner).run();
    expect(await search(owner, 'casey')).toHaveLength(1);
  });

  it('hides people who turn off discoverable from search, profiles and invitations', async () => {
    await people();
    expect(await read(casey, '/v1/profile/discoverable')).toEqual({ discoverable: true });
    expect((await read(casey, '/v1/snapshot')).discoverable).toBe(true);
    await call(casey, '/v1/profile/discoverable', { discoverable: false });
    expect((await read(casey, '/v1/snapshot')).discoverable).toBe(false);
    expect(await search(owner, 'casey@example.test')).toEqual([]);
    expect(await search(owner, 'casey')).toEqual([]);
    await expect(call(owner, '/v1/people/' + casey)).rejects.toMatchObject({ status: 404 });
    await expect(call(owner, groupPath + '/invites/direct', { userID: casey })).rejects.toMatchObject({ status: 404 });
    await expect(call(casey, '/v1/profile/discoverable', { discoverable: 'no' })).rejects.toBeInstanceOf(InputError);

    // People who already share a group can still see each other's minimal profile.
    await call(owner, groupPath + '/members', { id: 'dir-seat-direct', name: 'Casey', userID: casey });
    expect(await read(owner, '/v1/people/' + casey)).toEqual({ userID: casey, name: 'Casey Green', sharedGroups: [{ id: groupID, name: 'Lisbon' }] });
    await call(casey, '/v1/profile/discoverable', { discoverable: true });
    expect(await search(owner, 'casey')).toHaveLength(1);
  });
});

describe('invite inbox', () => {
  it('delivers a direct invitation only to its recipient, who can accept it and claim the placeholder', async () => {
    await people();
    await expect(call(mallory, groupPath + '/invites/direct', { userID: casey })).rejects.toMatchObject({ status: 403 });
    await expect(call(owner, groupPath + '/invites/direct', { userID: 'nobody' })).rejects.toMatchObject({ status: 404 });
    await expect(call(owner, groupPath + '/invites/direct', { userID: casey, memberID: 'dir-seat-owner' })).rejects.toMatchObject({ status: 404 });
    const { id } = await read<{ id: string }>(owner, groupPath + '/invites/direct', { userID: casey, memberID: 'dir-seat-casey' });
    expect(id).toMatch(/^[a-f0-9]{64}$/);

    expect(await inbox(casey)).toEqual([expect.objectContaining({ id, kind: 'direct', groupID, groupName: 'Lisbon',
      inviterName: 'Olive Owner', memberName: 'Casey (placeholder)', memberCount: 2 })]);
    expect((await read(casey, '/v1/snapshot')).invitationCount).toBe(1);
    expect(await inbox(mallory)).toEqual([]);
    expect((await read(owner, groupPath + '/invites')).invites).toContainEqual(expect.objectContaining({ id, kind: 'person', recipientName: 'Casey Green' }));

    // Another account cannot accept or decline it, and learns nothing about it.
    for (const action of ['accept', 'decline'])
      await expect(call(mallory, `/v1/invitations/${id}/${action}`, {})).rejects.toMatchObject({ status: 404 });
    expect((await read(mallory, '/v1/snapshot')).groups).toEqual([]);

    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    try {
      expect(await read(casey, `/v1/invitations/${id}/accept`, {})).toEqual({ ok: true, groupID });
    } finally { fetch.mockRestore(); }
    const seat = await env.DB.prepare('SELECT user_id FROM members WHERE id=?').bind('dir-seat-casey').first('user_id');
    expect(seat).toBe(casey);
    expect(await inbox(casey)).toEqual([]);
    await expect(call(casey, `/v1/invitations/${id}/accept`, {})).rejects.toMatchObject({ status: 404 });
    await expect(call(owner, groupPath + '/invites/direct', { userID: casey })).rejects.toMatchObject({ status: 409 });
  });

  it('lets the recipient decline, and the inviter revoke, a direct invitation', async () => {
    await people();
    const first = await read<{ id: string }>(owner, groupPath + '/invites/direct', { userID: casey });
    expect(await read(casey, `/v1/invitations/${first.id}/decline`, {})).toEqual({ ok: true });
    expect(await inbox(casey)).toEqual([]);
    expect((await read(casey, '/v1/snapshot')).groups).toEqual([]);

    const second = await read<{ id: string }>(owner, groupPath + '/invites/direct', { userID: casey });
    await call(owner, `${groupPath}/invites/${second.id}/revoke`, {});
    expect(await inbox(casey)).toEqual([]);
    await expect(call(casey, `/v1/invitations/${second.id}/accept`, {})).rejects.toMatchObject({ status: 404 });
  });

  it('joins as a new member when no placeholder is attached', async () => {
    await people();
    const { id } = await read<{ id: string }>(owner, groupPath + '/invites/direct', { userID: mallory });
    expect(await read(mallory, `/v1/invitations/${id}/accept`, {})).toEqual({ ok: true, groupID });
    const members = (await read(mallory, '/v1/snapshot')).groups[0].members;
    expect(members.find((m: any) => m.userID === mallory)).toMatchObject({ name: 'Mallory Stone' });
  });

  it('rate-limits direct invitations per sender', async () => {
    await people();
    for (let i = 0; i < DIRECT_INVITES_PER_HOUR; i++) {
      await saveProfile(env.DB, { userID: 'dir-bulk-' + i, name: 'Bulk ' + i, username: null, email: null });
      await call(owner, groupPath + '/invites/direct', { userID: 'dir-bulk-' + i });
    }
    await expect(call(owner, groupPath + '/invites/direct', { userID: casey })).rejects.toMatchObject({ status: 429 });
  });

  it('shows an email invitation to the verified recipient only, and claims the placeholder on accept', async () => {
    await people();
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await call(owner, groupPath + '/members/dir-seat-casey/invite-email', { email: 'casey@example.test' });
      const [invite] = await inbox(casey);
      expect(invite).toMatchObject({ kind: 'email', groupID, memberName: 'Casey (placeholder)' });
      expect(await inbox(mallory)).toEqual([]);
      await expect(call(mallory, `/v1/invitations/${invite.id}/accept`, {})).rejects.toMatchObject({ status: 404 });
      await expect(call(mallory, `/v1/invitations/${invite.id}/decline`, {})).rejects.toMatchObject({ status: 404 });

      // The live Clerk check must still match the invited address.
      fetch.mockResolvedValueOnce(identity(casey, 'someone-else@example.test'));
      await expect(call(casey, `/v1/invitations/${invite.id}/accept`, {})).rejects.toMatchObject({ status: 404 });
      fetch.mockResolvedValue(identity(casey, 'casey@example.test'));
      expect(await read(casey, `/v1/invitations/${invite.id}/accept`, {})).toEqual({ ok: true, groupID });
      expect(await env.DB.prepare('SELECT user_id FROM members WHERE id=?').bind('dir-seat-casey').first('user_id')).toBe(casey);
      expect(await inbox(casey)).toEqual([]);
    } finally { fetch.mockRestore(); }
  });

  it('removes a declined email invitation', async () => {
    await people();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 200 }));
    try { await call(owner, groupPath + '/members/dir-seat-casey/invite-email', { email: 'casey@example.test' }); }
    finally { fetch.mockRestore(); }
    const [invite] = await inbox(casey);
    await call(casey, `/v1/invitations/${invite.id}/decline`, {});
    expect(await inbox(casey)).toEqual([]);
    expect((await read(owner, groupPath + '/invites')).invites).toEqual([]);
  });
});
