import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { handle } from '../src/index';
import { manageDevices } from '../src/cli/devices';
import { operate } from '../src/cli/operations';
import { deleteGroup } from '../src/social';
import tripCSV from '../../fixtures/splitwise/buenos-aires-trip_2026-11-18_export.csv?raw';

const file = 'buenos-aires-trip_2026-11-18_export.csv';
function req(path: string, data?: unknown, token?: string) {
  return new Request(env.APP_URL + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
}
const fetch = (path: string, data?: unknown, token?: string) => worker.fetch(req(path, data, token), env);
async function authorize(user: string) {
  const pending = await (await fetch('/v1/device/start', { name: 'Parity ' + user })).json<{ code: string; device: string }>();
  await manageDevices(req('/v1/device/approve', { code: pending.code }), env, user);
  return (await (await fetch('/v1/device/poll', { device: pending.device })).json<{ token: string }>()).token;
}
function runner(token: string) {
  const send = (name: string, args: object) => fetch('/v1/cli', { name, arguments: args }, token);
  const run = async (name: string, args: object): Promise<any> => {
    const response = await send(name, args);
    const result = await response.json<any>();
    if (!response.ok) throw Object.assign(new Error(JSON.stringify(result)), { status: response.status });
    return result;
  };
  return { send, run };
}

describe('CLI parity', () => {
  it('deletes a group only for its active creator after a fresh preview', async () => {
    const alex = runner(await authorize('parity-alex')), maya = runner(await authorize('parity-maya'));
    const { id: group, members: [me, sam] } = await alex.run('groups_create', { name: 'Lisbon', self: 'Alex', placeholders: ['Sam', 'Maya'] });
    const mayaSeat = (await alex.run('members_list', { group })).find((m: any) => m.name === 'Maya').id;
    await maya.run('join', { invite: (await alex.run('invite', { group, member: mayaSeat })).url });
    await alex.run('expenses_add', { group, title: 'Tram', amount: '9.00', payer: me.id });

    const preview = await alex.run('groups_delete', { group });
    expect(preview).toMatchObject({ preview: true, name: 'Lisbon', expenses: 1, settlements: 0 });
    expect(preview.revision).toMatch(/^[a-f0-9]{64}$/);
    // No silent confirmation, and other members cannot delete or preview.
    await expect(alex.run('groups_delete', { group, yes: true })).rejects.toMatchObject({ status: 409 });
    await expect(maya.run('groups_delete', { group })).rejects.toMatchObject({ status: 403 });
    await expect(maya.run('groups_delete', { group, yes: true, revision: preview.revision })).rejects.toMatchObject({ status: 403 });

    // A change after the preview makes it stale.
    await maya.run('expenses_add', { group, title: 'Pastéis', amount: '6.00', payer: mayaSeat, participants: [mayaSeat, sam.id] });
    await expect(alex.run('groups_delete', { group, yes: true, revision: preview.revision })).rejects.toMatchObject({ status: 409 });
    expect(await alex.run('groups_list', {})).toHaveLength(1);

    const fresh = await alex.run('groups_delete', { group });
    expect(fresh.expenses).toBe(2);
    expect(await alex.run('groups_delete', { group, yes: true, revision: fresh.revision })).toMatchObject({ deleted: true, id: group });
    expect(await alex.run('groups_list', {})).toEqual([]);
    expect(await maya.run('groups_list', {})).toEqual([]);
  });

  it('lists pending payments and lets the recipient approve or decline and the payer cancel', async () => {
    const alex = runner(await authorize('pay-alex')), maya = runner(await authorize('pay-maya'));
    const observer = runner(await authorize('pay-observer'));
    const { id: group, members: [me] } = await alex.run('groups_create', { name: 'Flat', self: 'Alex', placeholders: ['Maya'] });
    const mayaSeat = (await alex.run('members_list', { group })).find((m: any) => m.name === 'Maya').id;
    await maya.run('join', { invite: (await alex.run('invite', { group, member: mayaSeat })).url });
    await observer.run('join', { invite: (await alex.run('invite', { group })).url });
    const first = await maya.run('settle_up', { group, from: mayaSeat, to: me.id, amount: '12.50' });
    const second = await maya.run('settle_up', { group, from: mayaSeat, to: me.id, amount: '3.00' });

    expect(await alex.run('activity', { group })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, status: 'pending' }),
      expect.objectContaining({ id: second.id, status: 'pending' })
    ]));
    expect(await maya.run('activity', {})).toEqual(await maya.run('activity', { group }));
    expect(await observer.run('activity', { group })).toEqual([]);
    const forAlex = await alex.run('settlements_pending', { group });
    expect(forAlex).toHaveLength(2);
    expect(forAlex.find((p: any) => p.id === first.id)).toMatchObject({ amount: 1250, youAre: 'recipient', canDo: ['approve', 'decline'], from: { name: 'Maya' } });
    expect((await maya.run('settlements_pending', { group }))[0]).toMatchObject({ youAre: 'payer', canDo: ['cancel'] });

    await expect(maya.run('settlements_respond', { group, settlement: first.id, action: 'approve' })).rejects.toMatchObject({ status: 422 });
    await expect(alex.run('settlements_respond', { group, settlement: first.id, action: 'cancel' })).rejects.toMatchObject({ status: 422 });
    expect(await alex.run('settlements_respond', { group, settlement: first.id, action: 'approve' })).toMatchObject({ status: 'approved' });
    expect(await maya.run('settlements_respond', { group, settlement: second.id, action: 'cancel' })).toMatchObject({ status: 'cancelled' });
    expect(await alex.run('settlements_pending', { group })).toEqual([]);
    await expect(alex.run('settlements_respond', { group, settlement: second.id, action: 'decline' })).rejects.toMatchObject({ status: 404 });
    const received = await alex.run('settle_up', { group, from: mayaSeat, to: me.id, amount: '85.00' });
    expect(received).toMatchObject({ status: 'approved', amount: 8500, paidBy: mayaSeat });
    const activity = (await alex.run('activity', { group })).filter((e: any) => e.kind === 'settlement');
    expect(activity.map((e: any) => e.id).sort()).toEqual([first.id, received.id].sort());
    expect(activity.every((e: any) => e.status !== 'pending')).toBe(true);
  });

  it('plans a Splitwise import without saving, suggests only unique matches and keeps explicit mappings', async () => {
    const alex = runner(await authorize('import-alex'));
    // Two members named Sam are ambiguous; one Maya is a unique suggestion.
    const { id: group, members } = await alex.run('groups_create', { name: 'BA', self: 'Alex A', placeholders: ['Maya', 'Sam', 'sam ', 'Harris K'] });
    const id = (n: string) => members.find((m: any) => m.name === n).id;

    // Released clients: no me and no group still previews; me alone imports straight away (checked in cli.test.ts).
    const names = await alex.run('import_splitwise', { csv: tripCSV, file });
    expect(names).toMatchObject({ preview: true, members: ['Harris', 'Maya', 'Alex', 'Sam'], target: 'new group' });
    expect(names.next).toContain('me');

    const plan = await alex.run('import_splitwise', { csv: tripCSV, file, group, me: 'Alex', mapping: { Harris: id('Harris K') }, preview: true });
    expect(plan).toMatchObject({ preview: true, target: { id: group, name: 'BA' }, rows: names.rows });
    expect(plan.dates.from <= plan.dates.to).toBe(true);
    expect(plan.people).toEqual([
      { name: 'Harris', becomes: 'existing member Harris K', memberID: id('Harris K') },
      { name: 'Maya', becomes: 'new placeholder (possible match: Maya)' },
      { name: 'Alex', becomes: 'you (Alex A)' },
      { name: 'Sam', becomes: 'new placeholder (several members share this name)' },
    ]);
    expect(plan.suggestedMapping).toEqual({ Harris: id('Harris K'), Maya: id('Maya') });
    expect(Object.keys(plan.ambiguous)).toEqual(['Sam']);
    expect(await alex.run('expenses_list', { group })).toEqual([]);

    // An explicit mapping wins over a suggestion, even to a differently named member.
    const remapped = await alex.run('import_splitwise', { csv: tripCSV, file, group, me: 'Alex', mapping: { Maya: id('Harris K') }, preview: true });
    expect(remapped.people[1]).toEqual({ name: 'Maya', becomes: 'existing member Harris K', memberID: id('Harris K') });
    // Harris K is taken by the explicit mapping, so it is not offered again.
    expect(remapped.suggestedMapping).toBeUndefined();
    expect(remapped.people[0].becomes).toBe('new placeholder');
    await expect(alex.run('import_splitwise', { csv: tripCSV, file, group, me: 'Alex', mapping: { Maya: 'not-a-member-id' }, preview: true }))
      .rejects.toMatchObject({ status: 422 });

    // Without preview the reviewed request imports, and only the accepted suggestion is linked.
    const imported = await alex.run('import_splitwise', { csv: tripCSV, file, group, me: 'Alex', mapping: plan.suggestedMapping });
    expect(imported).toMatchObject({ groupID: group, inserted: names.rows });
    const roster = await alex.run('members_list', { group });
    expect(roster.filter((m: any) => m.name.trim().toLowerCase() === 'sam')).toHaveLength(3);
    expect(roster.filter((m: any) => m.name === 'Maya')).toHaveLength(1);
  });

  it('saves payment methods for any platform through members payment', async () => {
    const alex = runner(await authorize('methods-alex'));
    const { id: group } = await alex.run('groups_create', { name: 'Pay', self: 'Alex' });
    await alex.run('members_payment', { group, methods: [{ platform: 'Wise', handle: '@alex', preferred: true }, { platform: 'Venmo', handle: 'alex-a' }] });
    const saved = await env.DB.prepare('SELECT details FROM payment_profiles p JOIN members m ON m.id=p.member_id WHERE m.group_id=?').bind(group).first<string>('details');
    expect(JSON.parse(saved!)).toEqual([{ platform: 'Wise', handle: '@alex', preferred: true }, { platform: 'Venmo', handle: 'alex-a' }]);
    await expect(alex.run('members_payment', { group, methods: [{ platform: 'A', handle: 'a', preferred: true }, { platform: 'B', handle: 'b', preferred: true }] }))
      .rejects.toMatchObject({ status: 422 });
  });

  it('guards a confirmed delete atomically on the name, members and counts the preview showed', async () => {
    const alex = runner(await authorize('guard-alex'));
    const { id: group, members: [me, sam] } = await alex.run('groups_create', { name: 'Guard', self: 'Alex', placeholders: ['Sam'] });
    await alex.run('expenses_add', { group, title: 'Taxi', amount: '8.00', payer: me.id });
    const shown = { name: 'Guard', members: [{ id: me.id, name: 'Alex' }, { id: sam.id, name: 'Sam' }], expenses: 1, settlements: 0, receipts: 0 };
    await expect(deleteGroup(env, group, 'guard-maya', shown)).rejects.toMatchObject({ status: 403 });
    for (const stale of [{ ...shown, name: 'Other' }, { ...shown, members: [shown.members[0]] }, { ...shown, members: [shown.members[0], { id: sam.id, name: 'Sammy' }] },
      { ...shown, members: [...shown.members].reverse() }, { ...shown, expenses: 0 }, { ...shown, settlements: 1 }, { ...shown, receipts: 1 }])
      await expect(deleteGroup(env, group, 'guard-alex', stale)).rejects.toMatchObject({ status: 409 });
    expect(await alex.run('groups_list', {})).toHaveLength(1);
    expect((await deleteGroup(env, group, 'guard-alex', shown)).status).toBe(200);
    expect(await alex.run('groups_list', {})).toEqual([]);
  });

  it('refuses a confirmed CLI delete when the group changes after the fingerprint check', async () => {
    const alex = runner(await authorize('race-alex'));
    const { id: group, members: [me] } = await alex.run('groups_create', { name: 'Race', self: 'Alex', placeholders: ['Sam'] });
    await alex.run('expenses_add', { group, title: 'Taxi', amount: '8.00', payer: me.id });
    const { revision } = await alex.run('groups_delete', { group });
    // Serve the confirm call a snapshot that still matches the revision, then let another write land
    // before the delete runs. Only the atomic guard can catch this.
    const racing = async (request: Request, e: Env, user: string) => {
      const response = await handle(request, e, user);
      if (new URL(request.url).pathname === '/v1/snapshot')
        await handle(req('/v1/groups/' + group + '/update', { name: 'Renamed' }), e, user);
      return response;
    };
    await expect(operate('groups_delete', { group, yes: true, revision }, env, 'race-alex', racing)).rejects.toMatchObject({ status: 409 });
    expect((await alex.run('groups_show', { group })).name).toBe('Renamed');
    const fresh = await alex.run('groups_delete', { group });
    expect(await alex.run('groups_delete', { group, yes: true, revision: fresh.revision })).toMatchObject({ deleted: true });
  });

  it('keeps the public delete route unchanged for current clients', async () => {
    const alex = runner(await authorize('route-alex'));
    const { id: web } = await alex.run('groups_create', { name: 'Web', self: 'Alex' });
    await expect(handle(req('/v1/groups/' + web + '/delete', {}), env, 'route-maya')).rejects.toMatchObject({ status: 403 });
    // Extra JSON is ignored, as before; the guard is only reachable through the CLI.
    expect((await handle(req('/v1/groups/' + web + '/delete', { expected: { name: 'Nope' } }), env, 'route-alex')).status).toBe(200);
    const { id: bare } = await alex.run('groups_create', { name: 'Bare', self: 'Alex' });
    expect((await handle(new Request(env.APP_URL + '/v1/groups/' + bare + '/delete', { method: 'POST' }), env, 'route-alex')).status).toBe(200);
  });

  it('lets only a payer mark an expense handled or unhandled', async () => {
    const alex = runner(await authorize('handled-alex')), maya = runner(await authorize('handled-maya'));
    const { id: group, members: [me] } = await alex.run('groups_create', { name: 'Handled', self: 'Alex', placeholders: ['Maya'] });
    const mayaSeat = (await alex.run('members_list', { group })).find((m: any) => m.name === 'Maya').id;
    await maya.run('join', { invite: (await alex.run('invite', { group, member: mayaSeat })).url });
    const expense = await alex.run('expenses_add', { group, title: 'Rent', amount: '100.00', payer: me.id });
    const shown = async () => (await alex.run('expenses_show', { group, expense: expense.id })).handled;

    expect(await alex.run('expenses_handled', { group, expense: expense.id })).toEqual({ id: expense.id, handled: true });
    expect(await shown()).toBe(true);
    expect((await alex.run('groups_breakdown', { group }))[0]).toMatchObject({
      members: [expect.objectContaining({ paid: 10000, share: 5000, net: 5000 }), expect.objectContaining({ net: -5000 })],
      settlements: []
    });
    expect((await alex.run('balances', { group }))[0].settlements).toEqual([]);
    expect((await alex.run('groups_export', { group })).content).toContain('Handled,,50.00,-50.00');
    expect((await alex.run('groups_export', { group, format:'summary' })).content).toContain('USD,Alex,active,100.00,50.00,50.00');
    await expect(maya.run('expenses_handled', { group, expense: expense.id, state: 'unhandled' })).rejects.toMatchObject({ status: 403 });
    expect(await alex.run('expenses_handled', { group, expense: expense.id, state: 'unhandled' })).toMatchObject({ handled: false });
    expect(Boolean(await shown())).toBe(false);
    const outsider = runner(await authorize('handled-out'));
    await expect(outsider.run('expenses_handled', { group, expense: expense.id })).rejects.toMatchObject({ status: 404 });
  });

  it('infers group types and filters trip expenses by automatic and overridden phase', async () => {
    const alex = runner(await authorize('phase-alex'));
    const outsider = runner(await authorize('phase-outsider'));
    const { id: group, members: [me] } = await alex.run('groups_create', {
      name: 'Trip', self: 'Alex', start: '2026-11-12', end: '2026-11-21',
    });
    const { id: home } = await alex.run('groups_create', { name: 'Flat', self: 'Alex' });
    expect(await alex.run('groups_list', {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: group, kind: 'trip' }),
      expect.objectContaining({ id: home, kind: 'home' }),
    ]));
    await expect(outsider.run('groups_update', { group, kind: 'home' })).rejects.toMatchObject({ status: 404 });

    const add = (date: string, phase?: string) => alex.run('expenses_add', {
      group, payer: me.id, amount: '10.01', title: 'Trip expense', date, phase,
    });
    const beforeTrip = await add('2026-11-11');
    const start = await add('2026-11-12');
    const end = await add('2026-11-21');
    const afterTrip = await add('2026-11-22');
    expect([beforeTrip.phase, start.phase, end.phase, afterTrip.phase]).toEqual(['pre','during','during','post']);
    const override = await add('2026-11-13','pre');
    const list = (phase: string) => alex.run('expenses_list', { group, phase });
    expect((await list('pre')).map((e: {id:string}) => e.id)).toEqual(expect.arrayContaining([beforeTrip.id,override.id]));
    expect(await list('pre')).toHaveLength(2);
    expect((await alex.run('groups_breakdown', { group }))[0].phases.pre).toEqual({ count: 2, amount: 2002 });

    const edit = { group, expense: override.id, phase: 'auto' };
    const preview = await alex.run('expenses_edit', edit);
    expect(preview.after.phase).toBe('during');
    await alex.run('expenses_edit', { ...edit, yes: true, revision: preview.revision });
    expect(await list('pre')).toHaveLength(1);
    expect(await list('during')).toHaveLength(3);

    await alex.run('groups_update', { group, start: '2026-11-14' });
    expect(await list('pre')).toHaveLength(3);
    await alex.run('groups_update', { group, kind: 'home' });
    expect(await list('pre')).toEqual([]);
    expect((await alex.run('expenses_list', { group })).every((entry: object) => !('phase' in entry))).toBe(true);
    await expect(add('2026-11-13','pre')).rejects.toMatchObject({ status: 422 });
    await expect(outsider.run('expenses_list', { group, phase: 'pre' })).rejects.toMatchObject({ status: 404 });
  });

  it('sets and clears trip exchange rates for active trip members only', async () => {
    const alex = runner(await authorize('rate-alex')), maya = runner(await authorize('rate-maya'));
    const { id: trip } = await alex.run('groups_create', { name: 'Rio', self: 'Alex', kind: 'trip', start: '2026-11-20', end: '2026-11-25', currency: 'USD', placeholders: ['Maya'] });
    const rates = async () => (await alex.run('groups_show', { group: trip })).tripRates;
    const payer = (await alex.run('members_list', { group: trip })).find((m: any) => m.name === 'Alex').id;
    const args = { group: trip, title: 'Lunch', payer, amount: '50.00', currency: 'BRL', date: '2026-11-21' };
    const unconverted = await alex.run('expenses_add', args);
    expect(unconverted).toMatchObject({ currency: 'BRL', exchange: null, warning: expect.stringContaining('separate balance') });
    expect(await alex.run('groups_rate', { group: trip, currency: 'BRL', rate: '0.18' })).toMatchObject({ target: 'USD', rate: '0.18' });
    expect(await rates()).toEqual({ BRL: 18_000_000 });
    const converted = await alex.run('expenses_add', args);
    expect(converted).toMatchObject({ amount: 5000, settlementAmount: 900,
      exchange: { source: 'Trip', date: args.date, rateE8: 18_000_000, target: 'USD' } });
    expect(await alex.run('expenses_add', { ...args, rate: '0.185' })).toMatchObject({
      exchange: { source: 'Manual', rateE8: 18_500_000 }, settlementAmount: 925 });
    const listing = (await alex.run('expenses_list', { group: trip })).find((e: any) => e.id === converted.id);
    expect(listing).toMatchObject({ date: args.date, shortID: converted.id.slice(0,8), payerNames: [{ memberID: payer, name: 'Alex', amount: 5000 }] });
    expect(await alex.run('expenses_show', { group: trip, expense: listing.shortID })).toMatchObject({ id: converted.id });
    await alex.run('groups_rate', { group: trip, currency: 'ARS', rate: '0.00105' });
    expect((await rates()).ARS).toBe(105_000);
    await alex.run('groups_rate', { group: trip, currency: 'BRL', rate: 'none' });
    expect(await rates()).toEqual({ ARS: 105_000 });
    await expect(alex.run('groups_rate', { group: trip, currency: 'USD', rate: '1' })).rejects.toMatchObject({ status: 422 });
    await expect(alex.run('groups_rate', { group: trip, currency: 'BRL', rate: '0' })).rejects.toMatchObject({ status: 422 });
    await expect(alex.run('groups_rate', { group: trip, currency: 'BRL', rate: '1e3' })).rejects.toMatchObject({ status: 422 });
    await expect(maya.run('groups_rate', { group: trip, currency: 'BRL', rate: '0.2' })).rejects.toMatchObject({ status: 404 });
    const { id: home } = await alex.run('groups_create', { name: 'Home', self: 'Alex', kind: 'home' });
    await expect(alex.run('groups_rate', { group: home, currency: 'BRL', rate: '0.2' })).rejects.toMatchObject({ status: 403 });
  });

  it('shows and replaces account payment methods and resets a group override', async () => {
    const alex = runner(await authorize('acct-alex')), maya = runner(await authorize('acct-maya'));
    expect(await alex.run('profile_payment', {})).toEqual({ methods: [] });
    const account = [{ platform: 'Venmo', handle: 'alex-a', preferred: true }];
    await alex.run('profile_payment', { methods: account });
    expect(await alex.run('profile_payment', {})).toEqual({ methods: account });
    expect(await maya.run('profile_payment', {})).toEqual({ methods: [] });
    await expect(alex.run('profile_payment', { methods: [{ platform: 'x', handle: 'line\nbreak' }] })).rejects.toMatchObject({ status: 422 });

    const { id: group } = await alex.run('groups_create', { name: 'Override', self: 'Alex' });
    const override = () => env.DB.prepare('SELECT count(*) AS n FROM payment_profiles p JOIN members m ON m.id=p.member_id WHERE m.group_id=?').bind(group).first<number>('n');
    await alex.run('members_payment', { group, methods: [{ platform: 'Wise', handle: '@alex' }] });
    expect(await override()).toBe(1);
    await expect(alex.run('members_payment', { group, reset: true, venmo: 'alex' })).rejects.toMatchObject({ status: 422 });
    await alex.run('members_payment', { group, reset: true });
    expect(await override()).toBe(0);
    await expect(maya.run('members_payment', { group, reset: true })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects unknown import flags with the message older-Worker detection in the CLI relies on', async () => {
    const alex = runner(await authorize('flag-alex'));
    const response = await alex.send('import_splitwise', { csv: tripCSV, file, me: 'Alex', futureFlag: true });
    expect(response.status).toBe(422);
    expect((await response.json<{ error: string }>()).error).toMatch(/additional propert/i);
    expect(await alex.run('groups_list', {})).toEqual([]);
  });
});
