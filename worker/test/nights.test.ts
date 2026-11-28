import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { operate } from '../src/cli/operations';
import { handle } from '../src/index';
import { allocate, balances, dailyCosts, nightRate, validateEntry, type Entry } from '../src/ledger';

const owner = 'user-alex';
const group = {
  id: 'night-trip', name: 'Airbnb trip', kind: 'trip', currency: 'USD',
  members: ['alex', 'maya', 'harris', 'sam'].map((name, i) => ({
    id: 'member-' + name, name, userID: i === 0 ? owner : null,
  })),
};
const ids = group.members.map(m => m.id);
const amount = 109_462;
const nights = [3, 3, 3, 4];
const amounts = allocate(amount, nights);
const stay: Entry = {
  id: 'night-stay', groupID: group.id, title: 'Airbnb', amount, currency: 'USD', paidBy: ids[0],
  kind: 'expense', splitMode: 'nights', createdAt: '2026-11-10T12:00:00Z',
  spread: {start: '2026-11-12', end: '2026-11-16'},
  splits: ids.map((memberID, i) => ({memberID, amount: amounts[i], nights: nights[i]})),
};
const request = (path: string, body?: unknown) => new Request('https://split-api.yoinklabs.dev' + path,
  body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

it('validates counts, dates, members, and the exact weighted allocation', () => {
  const saved = validateEntry(stay, ids);
  expect(saved.splitMode).toBe('shares');
  expect(saved.splits).toEqual(stay.splits);
  expect(nightRate(saved)).toBe(8420);
  expect(() => validateEntry({...stay, splits: stay.splits.map((s, i) => ({...s, nights: i === 0 ? 2.5 : s.nights}))}, ids)).toThrow();
  expect(() => validateEntry({...stay, spread: {start: '2026-02-30', end: '2026-03-05'}}, ids)).toThrow();
  expect(() => validateEntry({...stay, spread: {...stay.spread!, end: '2026-11-15'}}, ids)).toThrow();
  expect(() => validateEntry({...stay, splits: stay.splits.map((s, i) => ({...s, amount: s.amount + (i === 0 ? 1 : i === 1 ? -1 : 0)}))}, ids)).toThrow();
  expect(() => validateEntry(stay, ids.slice(0, -1))).toThrow();
});

it('adds daily items in original currency and retains every cent across dates', () => {
  const dinner: Entry = {
    ...stay, id: 'night-dinner', title: 'Dinner', amount: 3100, spread: undefined, splitMode: 'exact',
    createdAt: '2026-11-12T20:00:00Z', splits: [{memberID: ids[0], amount: 3100}],
  };
  const days = dailyCosts([stay, dinner], ids[0]);
  expect(days.map(d => d.day)).toEqual(['2026-11-14', '2026-11-13', '2026-11-12']);
  expect(days[2]).toMatchObject({amount: 11_521, items: [{title: 'Airbnb', amount: 8421}, {title: 'Dinner', amount: 3100}]});
  expect(dailyCosts([stay], ids[3]).map(d => d.amount)).toEqual([8420, 8420, 8420, 8421]);
  expect(dailyCosts([{...dinner, spread: stay.spread}], ids[0]).map(d => d.amount)).toEqual([775, 775, 775, 775]);
});

it('round-trips dates and counts through editing after settlement and undo', async () => {
  await handle(request('/v1/groups', group), env, owner);
  await expect(handle(request('/v1/entries', stay), env, 'stranger')).rejects.toThrow('not a member');
  const old: Entry = {
    ...stay, splitMode: 'shares',
    splits: ids.map((memberID, i) => ({memberID, amount: allocate(amount, [1, 1, 1, 1])[i]})),
  };
  await handle(request('/v1/entries', old), env, owner);
  const payments: Entry[] = old.splits.slice(1).map((s, i) => ({
    ...old, id: 'night-payment-' + i, amount: s.amount, paidBy: s.memberID, kind: 'settlement',
    splitMode: 'exact', spread: undefined, splits: [{memberID: ids[0], amount: s.amount}],
  }));
  expect(balances([old, ...payments], 'USD')).toEqual(Object.fromEntries(ids.map(id => [id, 0])));
  await expect(handle(request('/v1/entries/' + stay.id + '/edit', {original: old, entry: stay}), env, 'stranger')).rejects.toThrow();
  const response = await handle(request('/v1/entries/' + stay.id + '/edit', {original: old, entry: stay}), env, owner);
  expect(response.status).toBe(200);
  const {entries} = await (await handle(request('/v1/snapshot'), env, owner)).json<{entries: Entry[]}>();
  expect(entries[0]).toMatchObject({spread: stay.spread, splits: stay.splits});
  expect(balances([entries[0], ...payments], 'USD')[ids[3]]).toBe(old.splits[3].amount - stay.splits[3].amount);
  expect((await handle(request('/v1/entries/' + stay.id + '/edit', {original: entries[0], entry: old}), env, owner)).status).toBe(200);
});

it('uses the existing membership-protected CLI and MCP paths for daily costs', async () => {
  await handle(request('/v1/groups', group), env, owner);
  await operate('expenses_add', {
    group: group.id, title: 'Airbnb', amount: '1094.62', payer: ids[0], mode: 'nights',
    participants: ids, values: ['3', '3', '3', '4'],
    spreadStart: '2026-11-12', spreadEnd: '2026-11-16',
  }, env, owner, handle);
  const args = {group: group.id, member: ids[3]};
  const costs = await operate('groups_daily', args, env, owner, handle);
  expect(costs).toMatchObject([{memberID: ids[3], days: [{day: '2026-11-15', amount: 8420}, {}, {}, {}]}]);
  await expect(operate('groups_daily', args, env, 'stranger', handle)).rejects.toThrow();
});
