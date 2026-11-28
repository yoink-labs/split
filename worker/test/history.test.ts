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
  const updated = { ...entry, amount: 81_000, splits: [{ memberID, amount: 81_000 }] };
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
    reason: 'partial refund', changes: { amount: { before: 90_000, after: 81_000 } },
  });
  expect(events[0].timestamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  await expect(call(timeline, undefined, 'other-account-history')).rejects.toMatchObject({ status: 403 });
  for (const method of ['POST','PATCH','PUT','DELETE']) {
    await expect(call(history, undefined, actor, method)).rejects.toMatchObject({ status: 405 });
  }
  const id = events[0].id;
  await expect(env.DB.prepare('UPDATE change_history SET reason=? WHERE id=?').bind('forged',id).run())
    .rejects.toThrow('append-only');
  await expect(env.DB.prepare('DELETE FROM change_history WHERE id=?').bind(id).run())
    .rejects.toThrow('append-only');

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
