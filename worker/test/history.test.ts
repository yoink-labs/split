import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle } from '../src/index';
import { operate } from '../src/cli/operations';

const actor = 'history-actor';
const call = (path: string, data?: unknown, user = actor, method = data === undefined ? 'GET' : 'POST') =>
  handle(new Request('https://split.test' + path, {
    method,
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  }), env, user);

it('records authorized edits atomically, keeps cents exact, and exposes a read-only member timeline', async () => {
  const groupID = 'history-private-group';
  const memberID = 'history-author-seat';
  const group = '/v1/groups/' + groupID;
  const history = group + '/history';
  const entry = {
    id: 'history-expense', groupID, kind: 'expense', title: 'Flights', amount: 90_000,
    currency: 'USD', paidBy: memberID, splitMode: 'equal', createdAt: '2026-09-01T12:00:00Z',
    splits: [{ memberID, amount: 90_000 }],
  };
  const entryPath = '/v1/entries/' + entry.id;
  const timeline = history + '?expense=' + entry.id;
  expect((await call('/v1/groups', { id: groupID, name: 'Trip', kind: 'trip', currency: 'USD',
    members: [{ id: memberID, name: 'Amine', userID: actor }] })).status).toBe(201);
  await call('/v1/entries', entry);
  const stay = { start: '2026-09-02', end: '2026-09-04' };
  const updated = { ...entry, amount: 81_000, createdAt: '2026-09-02T12:00:00Z', splitMode: 'nights',
    spread: { start: '2026-09-02', end: '2026-09-05' }, splits: [{ memberID, amount: 81_000, nights: 2, stay }] };
  const edit = { original: entry, entry: updated, reason: ' partial refund ', actor: 'forged' };
  await call(entryPath + '/edit', edit);
  await call(entryPath + '/edit', edit); // Idempotent retry.
  await expect(call(entryPath + '/edit', { ...edit, entry: { ...updated, title: 'Changed' } }))
    .rejects.toMatchObject({ status: 409 });
  await expect(call(entryPath + '/edit', { ...edit, reason: 'a'.repeat(501) })).rejects.toThrow('500');
  const { events, next } = await (await call(timeline + '&member=' + memberID + '&type=expense')).json<{
    events: Record<string, unknown>[]; next: number | null;
  }>();
  expect(events.map(event => event.action)).toEqual(['edit', 'add']);
  expect(next).toBeNull();
  expect(events[0]).toMatchObject({
    actor, member: memberID, actorName: 'Amine', entity: entry.id, expense: entry.id,
    reason: 'partial refund', changes: {
      amount: { before: 90_000, after: 81_000 },
      createdAt: { before: entry.createdAt, after: updated.createdAt },
      splitMode: { before: 'equal', after: 'nights' },
      splits: { after: [{ memberID, amount: 81_000, nights: 2, stay }] },
    },
  });
  expect(events[0].timestamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  await expect(call(timeline, undefined, 'other-account-history')).rejects.toMatchObject({ status: 403 });
  for (const method of ['POST','PATCH','PUT','DELETE']) {
    await expect(call(history, undefined, actor, method)).rejects.toMatchObject({ status: 405 });
  }
  const day = String(events[0].timestamp).slice(0,10);
  const dated = await (await call(timeline + '&from=' + day + '&to=' + day)).json<{events:unknown[]}>();
  expect(dated.events).toHaveLength(2);
  const beforeTracking = await (await call(timeline + '&to=2000-01-01')).json<{events:unknown[]}>();
  expect(beforeTracking.events).toHaveLength(0);
  const id = events[0].id;
  await expect(env.DB.prepare('UPDATE change_history SET reason=? WHERE id=?').bind('forged',id).run())
    .rejects.toThrow('append-only');
  await expect(env.DB.prepare('DELETE FROM change_history WHERE id=?').bind(id).run())
    .rejects.toThrow('append-only');

  await expect(env.DB.prepare(`INSERT OR REPLACE INTO change_history
    SELECT * FROM change_history WHERE id=?`).bind(id).run()).rejects.toThrow('append-only');

  await call(entryPath + '/delete', { original: updated, reason: 'Duplicate' });
  await expect(call(entryPath + '/restore', {}, 'other-account-history')).rejects.toMatchObject({ status: 404 });
  await call(entryPath + '/restore', {});
  const latest = await operate('history', { group: groupID, expense: entry.id, member: memberID }, env, actor, handle);
  expect(latest).toMatchObject({ events: [
    { action: 'restore' }, { action: 'delete', reason: 'Duplicate' },
    { action: 'edit', reason: 'partial refund' }, { action: 'add' },
  ] });
  await call(group + '/members/' + memberID + '/rename', { name: 'Amin' });
  const renamed = await (await call(history + '?type=member')).json<{ events: unknown[] }>();
  expect(renamed.events[0]).toMatchObject({ action: 'rename', changes: { name: { before: 'Amine', after: 'Amin' } } });
  await expect(call(group + '/members/' + memberID + '/rename', { name: 'Unknown' }, 'other-account-history'))
    .rejects.toMatchObject({ status: 403 });
  await call(group + '/delete', {});
  await expect(call(history)).rejects.toMatchObject({ status: 403 });
  await expect(call('/v1/groups', { id: groupID, name: 'Reused', kind: 'trip', currency: 'USD',
    members: [{ id: memberID, name: 'Unrelated', userID: actor }] })).rejects.toThrow('Group ID already used');
});

it('audits group type changes and trip phase overrides with their actor and optional reason', async () => {
  const groupID = 'history-trip-phases';
  const memberID = 'history-trip-member';
  const group = '/v1/groups/' + groupID;
  await call('/v1/groups', {
    id: groupID, name: 'Lisbon', kind: 'trip', currency: 'USD', startDate: '2026-09-10', endDate: '2026-09-15',
    members: [{ id: memberID, name: 'Amine', userID: actor }],
  });
  const entry = {
    id: 'history-phase-expense', groupID, kind: 'expense', title: 'Flights', amount: 120_000,
    currency: 'USD', paidBy: memberID, splitMode: 'equal', createdAt: '2026-09-12T12:00:00Z',
    splits: [{ memberID, amount: 120_000 }],
  };
  await call('/v1/entries', entry);

  const changePhase = async (phase: string, reason?: string) => {
    const args = { group: groupID, expense: entry.id, phase, ...(reason === undefined ? {} : { reason }) };
    const preview = await operate('expenses_edit', args, env, actor, handle) as { revision: string };
    await operate('expenses_edit', { ...args, yes: true, revision: preview.revision }, env, actor, handle);
  };
  await changePhase('pre', ' Booked in advance ');
  await changePhase('auto');
  await operate('groups_update', { group: groupID, kind: 'home', reason: 'Shared household' }, env, actor, handle);

  const who = { actor, actorName: 'Amine', member: memberID, action: 'edit' };
  const result = await (await call(group + '/history')).json<{ events: unknown[] }>();
  expect(result.events.slice(0, 3)).toMatchObject([
    { ...who, type: 'group', reason: 'Shared household', changes: { kind: { before: 'trip', after: 'home' } } },
    { ...who, type: 'expense', expense: entry.id, reason: null, changes: { phase: { before: 'pre', after: null } } },
    { ...who, type: 'expense', expense: entry.id, reason: 'Booked in advance', changes: { phase: { before: null, after: 'pre' } } },
  ]);
  await expect(call(group + '/history', undefined, 'history-outside-account')).rejects.toMatchObject({ status: 403 });
});
