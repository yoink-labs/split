import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle } from '../src/index';
import { itemSplit } from '../src/items';
import { operate } from '../src/cli/operations';
import { resolveEntry } from '../src/people';
import { type Entry, validateEntry } from '../src/ledger';

const req = (path: string, body?: unknown) =>
  new Request('https://split-api.yoinklabs.dev' + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function seedGroup(user = 'user-a') {
  const gid = 'grp-workspace-1';
  const res = await handle(req('/v1/groups', {
    id: gid,
    name: 'Patagonia Trip',
    kind: 'trip',
    currency: 'USD',
    description: 'Glaciers and steaks',
    startDate: '2026-11-12',
    endDate: '2026-11-21',
    members: [
      { id: 'mem-harris-1', name: 'Harris', userID: user },
      { id: 'mem-maya-001', name: 'Maya', userID: null },
      { id: 'mem-jordan-1', name: 'Jordan', userID: null },
    ],
  }), env, user);
  expect(res.status).toBe(201);
  return gid;
}

it('allocates fractional item shares to the exact cent', () => {
  const bill = {
    closed: false,
    tax: 100,
    tip: 200,
    items: [
      {
        id: 'item-12345678',
        title: '3 Beers',
        amount: 2400,
        memberIDs: ['mem-harris-1', 'mem-maya-001'],
        shares: { 'mem-harris-1': 200, 'mem-maya-001': 100 }, // 2x vs 1x
      },
    ],
  };
  const splits = itemSplit(bill, 'mem-harris-1');
  // Gross is 2700 -> 2:1 = 1800 and 900
  expect(splits).toEqual([
    { memberID: 'mem-harris-1', amount: 1800 },
    { memberID: 'mem-maya-001', amount: 900 },
  ]);
});

it('keeps historical weighted cents when two claimants merge into one seat', () => {
  const [canonical, placeholder, other] = ['mem-harris-1', 'mem-maya-001', 'mem-jordan-1'];
  const bill = { closed:false, tax:0, tip:0, items:[
    { id:'item-12345678', title:'Drinks', amount:101, memberIDs:[canonical,placeholder,other], shares:{[placeholder]:200} }
  ] };
  const entry: Entry = {
    id:'entry-12345678', groupID:'grp-workspace-1', title:'Drinks', amount:101, currency:'USD',
    paidBy:canonical, splits:itemSplit(bill,canonical), kind:'expense', splitMode:'exact',
    createdAt:'2026-11-12T18:00:00Z', bill
  };
  const resolved = resolveEntry(entry, new Map([[placeholder,canonical]]));
  expect(resolved.splits).toEqual([{memberID:canonical,amount:76},{memberID:other,amount:25}]);
  expect(validateEntry(resolved,[canonical,other],resolved.bill)).toEqual(resolved);
});

it('persists group description, trip dates, invites listing/revocation, member archive/delete, and avatars', async () => {
  const gid = await seedGroup('user-a');

  // Update metadata
  const upd = await handle(req(`/v1/groups/${gid}/update`, {
    description: 'Updated trip notes',
    startDate: '2026-11-10',
    endDate: '2026-11-22',
  }), env, 'user-a');
  expect(upd.status).toBe(200);

  // Set avatar
  const av = await handle(req('/v1/profile/avatar', { avatarURL: 'preset:cobalt' }), env, 'user-a');
  expect(av.status).toBe(200);

  // Snapshot reflects metadata + avatar
  const snap = await (await handle(req('/v1/snapshot'), env, 'user-a')).json<{ groups: any[] }>();
  expect(snap.groups[0].description).toBe('Updated trip notes');
  expect(snap.groups[0].startDate).toBe('2026-11-10');
  expect(snap.groups[0].endDate).toBe('2026-11-22');
  expect(snap.groups[0].members.find((m: any) => m.id === 'mem-harris-1').avatarURL).toBe('preset:cobalt');

  // Invites: create, list, revoke, and block non-member
  const invRes = await handle(req(`/v1/groups/${gid}/invites`, {}), env, 'user-a');
  expect(invRes.status).toBe(200);
  const listRes = await handle(req(`/v1/groups/${gid}/invites`), env, 'user-a');
  expect(listRes.status).toBe(200);
  const { invites } = await listRes.json<{ invites: { id: string }[] }>();
  expect(invites).toHaveLength(1);

  await expect(handle(req(`/v1/groups/${gid}/invites`), env, 'outsider')).rejects.toThrow();
  await expect(handle(req(`/v1/groups/${gid}/invites/${invites[0].id}/revoke`, {}), env, 'outsider')).rejects.toThrow(/not a member/);
  await expect(handle(req(`/v1/groups/${gid}/members/mem-maya-001/remove`, {mode:'archive'}), env, 'outsider')).rejects.toThrow(/not a member/);
  await expect(handle(req(`/v1/groups/${gid}/update`, {endDate:'2026-11-31'}), env, 'user-a')).rejects.toThrow(/valid YYYY-MM-DD/);

  const rev = await handle(req(`/v1/groups/${gid}/invites/${invites[0].id}/revoke`, {}), env, 'user-a');
  expect(rev.status).toBe(200);
  const afterRev = await (await handle(req(`/v1/groups/${gid}/invites`), env, 'user-a')).json<{ invites: unknown[] }>();
  expect(afterRev.invites).toHaveLength(0);

  // Add an expense involving Maya, then test delete vs archive
  const expRes = await handle(req('/v1/entries', {
    id: 'entry-12345678',
    groupID: gid,
    title: 'Steakhouse',
    amount: 3000,
    currency: 'USD',
    paidBy: 'mem-harris-1',
    splits: [{ memberID: 'mem-harris-1', amount: 1500 }, { memberID: 'mem-maya-001', amount: 1500 }],
    kind: 'expense',
    splitMode: 'equal',
    createdAt: '2026-11-12T18:00:00Z',
  }), env, 'user-a');
  expect(expRes.status).toBe(200);

  // Maya has expenses -> delete rejected (409), archive succeeds
  await expect(handle(req(`/v1/groups/${gid}/members/mem-maya-001/remove`, { mode: 'delete' }), env, 'user-a')).rejects.toThrow(/expenses/);
  const arch = await handle(req(`/v1/groups/${gid}/members/mem-maya-001/remove`, { mode: 'archive' }), env, 'user-a');
  expect(arch.status).toBe(200);
  await expect(handle(req(`/v1/groups/${gid}/invites`, {memberID:'mem-maya-001'}), env, 'user-a')).rejects.toThrow(/unclaimed member/);

  // Jordan has no expenses -> delete succeeds
  const del = await handle(req(`/v1/groups/${gid}/members/mem-jordan-1/remove`, { mode: 'delete' }), env, 'user-a');
  expect(del.status).toBe(200);

  const snap2 = await (await handle(req('/v1/snapshot'), env, 'user-a')).json<{ groups: any[] }>();
  expect(snap2.groups[0].members.map((m: any) => m.id)).toEqual(['mem-harris-1', 'mem-maya-001']);
  expect(snap2.groups[0].members.find((m: any) => m.id === 'mem-maya-001').removed).toBe(true);
});

it('supports fractional claim updates via /claim and MCP itemized receipt upload', async () => {
  const gid = await seedGroup('user-a');
  const created = await operate('expenses_add', {
    group: gid,
    title: 'Don Julio',
    amount: '33.00',
    payer: 'mem-harris-1',
    category: 'Dining',
    notes: 'Uploaded by local LLM',
    date: '2026-11-14',
    bill: {
      items: [
        { title: 'Malbec', amount: '30.00', memberIDs: ['mem-harris-1'] },
      ],
      tax: '3.00',
      tip: '0.00',
    },
  }, env, 'user-a', handle) as { id: string; bill: { items: { id: string }[] } };

  const itemID = created.bill.items[0].id;
  const claimRes = await handle(req(`/v1/entries/${created.id}/claim`, {
    itemID,
    original: ['mem-harris-1'],
    memberIDs: ['mem-harris-1', 'mem-maya-001'],
    shares: { 'mem-harris-1': 200, 'mem-maya-001': 100 },
    mergeEdits: true,
  }), env, 'user-a');
  expect(claimRes.status).toBe(200);

  const snap = await (await handle(req('/v1/snapshot'), env, 'user-a')).json<{ entries: any[] }>();
  const saved = snap.entries.find((e) => e.id === created.id);
  expect(saved.notes).toBe('Uploaded by local LLM');
  expect(saved.splits).toEqual([
    { memberID: 'mem-harris-1', amount: 2200 },
    { memberID: 'mem-maya-001', amount: 1100 },
  ]);
  await expect(handle(req(`/v1/entries/${created.id}/claim`, {
    itemID, original: ['mem-harris-1','mem-maya-001'], memberIDs: ['mem-harris-1','mem-maya-001'],
    shares: { 'mem-jordan-1': 1.5 },
  }), env, 'user-a')).rejects.toThrow(/share weights/);
  expect((await handle(req(`/v1/entries/${created.id}/close`, {memberIDs:[]}), env, 'user-a')).status).toBe(200);
});

it('validates phase writes and preserves overrides on older expense edits', async () => {
  const groupID = await seedGroup();
  const paidBy = 'mem-harris-1';
  const expense = {
    id: 'entry-trip-phase', groupID, paidBy, title: 'Flights', currency: 'USD', amount: 1000,
    kind: 'expense', splitMode: 'equal', splits: [{ memberID: paidBy, amount: 1000 }],
    createdAt: '2026-11-12T12:00:00Z',
  };
  const add = (entry: object, user = 'user-a') => handle(req('/v1/entries', entry), env, user);
  await expect(add({ ...expense, phase: 'invalid' })).rejects.toThrow('valid trip phase');
  await expect(add({ ...expense, phase: 'pre' }, 'outsider')).rejects.toMatchObject({ status: 403 });
  expect((await add({ ...expense, phase: 'pre' })).ok).toBe(true);
  const edit = (original: object, entry: object) =>
    handle(req('/v1/entries/entry-trip-phase/edit', { original, entry }), env, 'user-a');
  const changed = { ...expense, title: 'Airport flights' };
  expect((await edit(expense, changed)).ok).toBe(true);
  const snapshot = async () => (await (await handle(req('/v1/snapshot'), env, 'user-a')).json<{entries: Entry[]}>()).entries[0];
  expect((await snapshot()).phase).toBe('pre');
  await expect(edit({ ...changed, phase: null }, { ...changed, phase: 'post' })).rejects.toMatchObject({ status: 409 });
  expect((await edit({ ...changed, phase: 'pre' }, { ...changed, phase: null })).ok).toBe(true);
  expect((await snapshot()).phase).toBeUndefined();
  expect((await handle(req(`/v1/groups/${groupID}/update`, { kind: 'home' }), env, 'user-a')).ok).toBe(true);
  await expect(add({ ...expense, id: 'entry-home-phase', phase: 'post' })).rejects.toThrow('only in trip groups');
});
