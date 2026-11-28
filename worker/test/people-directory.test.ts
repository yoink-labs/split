import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handle } from '../src/index';
import { saveProfile } from '../src/people';
import { InputError } from '../src/ledger';
import { DIRECT_INVITES_PER_HOUR, FRIEND_REQUESTS_PER_HOUR } from '../src/directory';

const owner = 'dir-owner', casey = 'dir-casey', mallory = 'dir-mallory';
const groupID = 'dir-group-0001', groupPath = '/v1/groups/' + groupID;
const settings = { ...env, RESEND_API_KEY: 'mock-resend', EMAIL_FROM: 'Split <split@yoinklabs.dev>' };

function call(user: string, path: string, data?: unknown) {
  return handle(new Request('https://split.test' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }), settings, user);
}
const read = async <T = any>(user: string, path: string, data?: unknown) => (await call(user, path, data)).json<T>();
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

async function befriend(target: string) {
  await read(owner, '/v1/friends/requests', { email: target === casey ? 'casey@example.test' : 'mallory@example.test' });
  const [request] = await inbox(target);
  await read(target, `/v1/invitations/${request.id}/accept`, {});
}

async function shareGroup(target = casey) {
  const shared = 'dir-shared-group';
  await call(owner, '/v1/groups', { id: shared, name: 'Shared', kind: 'trip', currency: 'EUR',
    members: [{ id: 'dir-shared-owner', userID: owner, name: 'Olive' }] });
  await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)')
    .bind('dir-shared-guest', shared, target, 'Guest').run();
  return shared;
}

describe('friends and known people', () => {
  it('keeps email requests private, reciprocal only after acceptance, and removable by either friend', async () => {
    await people();
    await call(casey, '/v1/profile/avatar', { avatarURL: 'preset:fern' });
    const send = (email: string) => read(owner, '/v1/friends/requests', { email });
    expect(await send('nobody@example.test')).toEqual({ok:true});
    expect(await send('CASEY@example.test')).toEqual({ok:true});
    await send('casey@example.test');
    expect(await inbox(owner)).toEqual([]);
    expect(await inbox(mallory)).toEqual([]);
    const items = await inbox(casey);
    expect(items).toEqual([expect.objectContaining({ kind: 'friend', inviterName: 'Olive Owner' })]);
    expect(JSON.stringify(items)).not.toMatch(/example\.test|username|phone|email/);
    const [invite] = items;
    expect((await read(casey,'/v1/snapshot')).invitationCount).toBe(1);
    expect(await read(owner, '/v1/friends')).toEqual([]);
    expect(await read(owner, '/v1/people/known')).toEqual([]);
    for (const actor of [owner,mallory]) for (const action of ['accept','decline'])
      await expect(call(actor,`/v1/invitations/${invite.id}/${action}`,{})).rejects.toMatchObject({status:404});
    await expect(call(owner,`/v1/friends/${casey}/remove`,{})).rejects.toMatchObject({status:404});
    await call(casey,`/v1/invitations/${invite.id}/accept`,{});
    expect((await read(casey,'/v1/snapshot')).invitationCount).toBe(0);
    const card = [{userID:casey,name:'Casey Green',avatarURL:'preset:fern'}];
    expect(await read(owner,'/v1/friends')).toEqual(card);
    expect(await read(owner,'/v1/people/known')).toEqual(card);
    expect(await read(casey,'/v1/friends')).toEqual([{userID:owner,name:'Olive Owner'}]);
    await expect(call(mallory,`/v1/friends/${casey}/remove`,{})).rejects.toMatchObject({status:404});
    await call(casey,`/v1/friends/${owner}/remove`,{});
    expect(await read(owner,'/v1/friends')).toEqual([]);
    expect(await inbox(casey)).toEqual([]);
  });

  it('honors discoverability for exact email and requires an active shared group for account IDs', async () => {
    await people();
    await expect(call(casey,'/v1/profile/discoverable',{discoverable:'no'})).rejects.toBeInstanceOf(InputError);
    await call(casey,'/v1/profile/discoverable',{discoverable:false});
    await call(owner,'/v1/friends/requests',{email:'casey@example.test'});
    await call(owner,'/v1/friends/requests',{userID:casey});
    expect(await inbox(casey)).toEqual([]);
    const shared = await shareGroup();
    await call(owner,'/v1/friends/requests',{email:'casey@example.test'});
    expect(await inbox(casey)).toEqual([]);
    expect(await read(owner,'/v1/people/shared')).toEqual([{userID:casey,name:'Casey Green'}]);
    await call(owner,'/v1/friends/requests',{userID:casey});
    const [request] = await inbox(casey);
    await call(casey,`/v1/invitations/${request.id}/decline`,{});
    await expect(call(casey,`/v1/invitations/${request.id}/accept`,{})).rejects.toMatchObject({status:404});
    await env.DB.prepare('UPDATE members SET removed_at=? WHERE group_id=? AND user_id=?').bind('2026-01-01',shared,casey).run();
    expect(await read(owner,'/v1/people/shared')).toEqual([]);
    expect(await read(owner,'/v1/people/known')).toEqual([]);
    await call(owner,'/v1/friends/requests',{userID:casey});
    expect(await inbox(casey)).toEqual([]);
  });

  it('validates input and limits requests per account', async () => {
    await people();
    for (const input of [{email:'cas'}, {email:'casey@example.test',userID:casey}, {}])
      await expect(call(owner,'/v1/friends/requests',input)).rejects.toBeInstanceOf(InputError);
    for (let i=0;i<FRIEND_REQUESTS_PER_HOUR;i++) await call(owner,'/v1/friends/requests',{email:'unknown@example.test'});
    await expect(call(owner,'/v1/friends/requests',{email:'unknown@example.test'})).rejects.toMatchObject({status:429});
    expect((await call(casey,'/v1/friends/requests',{email:'unknown@example.test'})).status).toBe(202);
    await expect(call(owner,'/v1/people/search',{query:'Casey'})).rejects.toMatchObject({status:404});
  });
});

describe('direct placeholder linking', () => {
  const seat = 'dir-seat-casey';
  const path = groupPath + '/members/' + seat + '/link';
  const activity = groupPath + '/member-links';

  it('requires active membership and a known account, and records a private notification', async () => {
    await people();
    await expect(call(mallory,path,{userID:casey})).rejects.toMatchObject({status:403});
    await expect(call(mallory,activity)).rejects.toMatchObject({status:403});
    await expect(call(owner,path,{userID:casey})).rejects.toMatchObject({status:404});
    await expect(call(owner,groupPath+'/members',{id:'stranger-seat',name:'Casey',userID:casey})).rejects.toBeInstanceOf(InputError);
    await expect(call(owner,'/v1/groups',{id:'stranger-group',name:'Trip',currency:'EUR',kind:'trip',members:[
      {id:'stranger-owner',name:'Olive',userID:owner},{id:'stranger-guest',name:'Casey',userID:casey},
    ]})).rejects.toBeInstanceOf(InputError);
    await befriend(casey);
    await expect(call(owner,groupPath+'/members/dir-seat-owner/link',{userID:casey})).rejects.toMatchObject({status:409});
    await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-01-01','dir-seat-owner').run();
    await expect(call(owner,path,{userID:casey})).rejects.toMatchObject({status:403});
    await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind('dir-seat-owner').run();
    expect(await read(owner,path,{userID:casey})).toEqual({ok:true});
    await expect(call(owner,path,{userID:casey})).rejects.toMatchObject({status:409});
    const [notice] = await inbox(casey);
    expect(notice).toMatchObject({kind:'linked',groupID,memberName:'Casey (placeholder)',inviterName:'Olive Owner'});
    expect(await inbox(owner)).toEqual([]);
    expect(await inbox(mallory)).toEqual([]);
    expect((await read(casey,'/v1/snapshot')).groups[0].members).toContainEqual(expect.objectContaining({id:seat,userID:casey}));
    await expect(call(owner,`/v1/invitations/${notice.id}/decline`,{})).rejects.toMatchObject({status:404});
    await call(casey,`/v1/invitations/${notice.id}/decline`,{});
    expect(await inbox(casey)).toEqual([]);
    expect(await read(casey,activity)).toEqual({links:[{id:notice.id,memberName:'Casey (placeholder)',actorName:'Olive Owner',userName:'Casey Green',createdAt:expect.any(Number)}]});
    expect(await env.DB.prepare('SELECT count(*) AS n FROM direct_invites').first('n')).toBe(0);
  });

  it('expires a request and records only one concurrent link', async () => {
    await people();
    await call(owner,'/v1/friends/requests',{email:'casey@example.test'});
    const [expired] = await inbox(casey);
    await env.DB.prepare('UPDATE friendships SET expires_at=0 WHERE id=?').bind(expired.id).run();
    expect(await inbox(casey)).toEqual([]);
    await expect(call(casey,`/v1/invitations/${expired.id}/accept`,{})).rejects.toMatchObject({status:404});
    await befriend(casey);
    await befriend(mallory);
    const results = await Promise.allSettled([call(owner,path,{userID:casey}),call(owner,path,{userID:mallory})]);
    expect(results.filter(result => result.status==='fulfilled')).toHaveLength(1);
    expect((await read(owner,activity)).links).toHaveLength(1);
    expect((await inbox(casey)).length + (await inbox(mallory)).length).toBe(1);
  });

  it('merges placeholder expense history into an existing member through aliases', async () => {
    await people();
    await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)')
      .bind('dir-casey-account',groupID,casey,'Casey Green').run();
    await call(owner,'/v1/entries',{id:'dir-dinner',groupID,title:'Dinner',amount:1001,currency:'EUR',
      createdAt:'2026-05-15T00:00:00Z',splitMode:'exact',kind:'expense',paidBy:seat,splits:[{memberID:seat,amount:500},{memberID:'dir-casey-account',amount:501}]});
    await call(owner,path,{userID:casey});
    const snapshot = await read(casey,'/v1/snapshot');
    expect(snapshot.entries[0]).toMatchObject({paidBy:'dir-casey-account',splits:[{memberID:'dir-casey-account',amount:1001}]});
    expect(snapshot.groups[0].members.some((m: {id: string}) => m.id===seat)).toBe(false);
  });
});

describe('invite inbox', () => {
  it('delivers a direct invitation only to its recipient, who can accept it and claim the placeholder', async () => {
    await people();
    await befriend(casey);
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
    await befriend(casey);
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
    await befriend(mallory);
    const { id } = await read<{ id: string }>(owner, groupPath + '/invites/direct', { userID: mallory });
    expect(await read(mallory, `/v1/invitations/${id}/accept`, {})).toEqual({ ok: true, groupID });
    const members = (await read(mallory, '/v1/snapshot')).groups[0].members;
    expect(members.find((m: any) => m.userID === mallory)).toMatchObject({ name: 'Mallory Stone' });
  });

  it('rate-limits direct invitations per sender', async () => {
    await people();
    await befriend(casey);
    for (let i = 0; i < DIRECT_INVITES_PER_HOUR; i++)
      await env.DB.prepare('INSERT INTO direct_invites VALUES (?,?,?,?,?,?,?)')
        .bind('invite-'+i,groupID,'dir-bulk-'+i,owner,null,Date.now(),Date.now()+3600000).run();
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
