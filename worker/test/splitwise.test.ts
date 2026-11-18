import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handle } from '../src/index';
import { balances, type Entry } from '../src/ledger';
import { csvTable, detectSplitwise, groupNameFromFile, importGroupID, importedBalances, isoDay, mainCurrency, minor, parseSplitwise, reconcile } from '../src/splitwiseCsv';
import trip from '../../fixtures/splitwise/buenos-aires-trip_2026-11-18_export.csv?raw';
import piso from '../../fixtures/splitwise/piso-compartido_2026-11-18_export.csv?raw';
import wg from '../../fixtures/splitwise/wg-kasse_2026-11-18_export.csv?raw';
import friend from '../../fixtures/splitwise/friend-maya_2026-11-18_export.csv?raw';
import excel from '../../fixtures/splitwise/excel-resaved.csv?raw';
import edited from '../../fixtures/splitwise/edited-totals_export.csv?raw';

const user = 'user-harris';
function call(path: string, body?: unknown, who = user) {
  return handle(new Request('https://split.test' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, who);
}
async function snapshot(who = user) {
  return (await call('/v1/snapshot', undefined, who)).json<{ groups: { id: string; name: string; currency: string; members: { id: string; name: string; userID: string | null }[] }[]; entries: Entry[] }>();
}

describe('Splitwise CSV', () => {
  it('reads amounts, dates and file names exactly', () => {
    expect(minor('184000.50')).toBe(18400050);
    expect(minor('-46000.13')).toBe(-4600013);
    expect(minor('-20')).toBe(-2000);
    expect(minor(' ')).toBe(0);
    expect(minor('1,234.00')).toBeNull();
    expect(minor('12.345')).toBeNull();
    expect(isoDay('2026-11-18')).toBe('2026-11-18');
    expect(isoDay('3/22/26')).toBe('2026-03-22');
    expect(isoDay('2026-02-30')).toBeNull();
    expect(groupNameFromFile('buenos-aires-trip_2026-11-18_export.csv')).toBe('Buenos Aires Trip');
    expect(groupNameFromFile('WG Kasse_2026-11-18_export.csv')).toBe('WG Kasse');
    expect(csvTable('a,"b, ""c"""\n')).toEqual([['a', 'b, "c"']]);
  });

  it('parses a multi-currency group with payments, multiple payers and quoted descriptions', async () => {
    expect(detectSplitwise(trip)).toBe(true);
    const g = await parseSplitwise(trip, 'buenos-aires-trip_2026-11-18_export.csv');
    expect(g.name).toBe('Buenos Aires Trip');
    expect(g.members).toEqual(['Harris', 'Maya', 'Alex', 'Sam']);
    expect(g.rows).toHaveLength(7);
    expect(g.skipped).toEqual(['Souvenirs (Maya only) (no effect on balances)']);
    expect(g.rows.filter(r => r.payment).map(r => r.title)).toEqual(['Harris paid Alex', 'Maya paid Sam']);
    const dinner = g.rows[1];
    expect(dinner).toMatchObject({ title: 'Parrilla dinner, Don Julio', payer: 'Maya', amount: 18400050, currency: 'ARS', category: 'Dining' });
    expect(dinner.splits).toEqual([{ name: 'Harris', amount: 4600013 }, { name: 'Maya', amount: 4600012 }, { name: 'Alex', amount: 4600013 }, { name: 'Sam', amount: 4600012 }]);
    expect(g.rows[3].title).toBe('Wine tasting "Malbec flight"');
    const asado = g.rows[4];
    expect(asado.amount).toBe(4125000);
    expect(asado.payers!.reduce((a, p) => a + p.amount, 0)).toBe(4125000);
    expect(asado.splits.reduce((a, s) => a + s.amount, 0)).toBe(4125000);
    expect(Object.keys(g.totals).sort()).toEqual(['ARS', 'USD']);
    expect(reconcile(g)).toEqual([]);
    expect(importedBalances(g).USD).toEqual({ Harris: -2000, Maya: -12000, Alex: 26000, Sam: -12000 });
    expect(mainCurrency(g)).toBe('ARS');
  });

  it('handles non-ASCII names, CRLF, translated labels, friend preambles and spreadsheet re-saves', async () => {
    const p = await parseSplitwise(piso, 'piso-compartido_2026-11-18_export.csv');
    expect(p.members).toEqual(['José Núñez', 'Zoë Brontë', 'Ana-María', 'Søren']);
    expect(p.rows[1].title).toBe('"Big" shop at Mercadoña, Calle Mayor');
    expect(reconcile(p)).toEqual([]);
    const german = await parseSplitwise(wg, 'wg-kasse_2026-11-18_export.csv');
    expect(german.rows.map(r => r.payment)).toEqual([false, false, false, true]);
    expect(german.rows[1].category).toBeUndefined();
    expect(german.totals.EUR).toEqual({ Person1: -49, Person2: -20, Person3: 69 });
    expect(reconcile(german)).toEqual([]);
    const f = await parseSplitwise(friend, 'friend-maya_2026-11-18_export.csv');
    expect(f.members).toEqual(['Alex', 'Maya']);
    expect(reconcile(f)).toEqual([]);
    const x = await parseSplitwise(excel, 'excel-resaved.csv');
    expect(x.rows.map(r => r.day)).toEqual(['2026-03-22', '2026-03-23']);
    expect(reconcile(x)).toEqual([]);
  });

  it('reports a mismatch when the totals disagree and rejects non-exports', async () => {
    const g = await parseSplitwise(edited, 'edited-totals_export.csv');
    expect(reconcile(g)).toEqual([
      { currency: 'USD', member: 'Alex', expected: 25000, imported: 26000 },
      { currency: 'USD', member: 'Sam', expected: -11000, imported: -12000 },
    ]);
    await expect(parseSplitwise('Date,Title,Amount\n2026-01-01,x,1', 'other.csv')).rejects.toThrow('isn’t a Splitwise export');
    await expect(parseSplitwise('Date,Description,Category,Cost,Currency,A,B\n2026-01-01,x,General,1.00,USD,1.00,-0.50\n', 'bad.csv')).rejects.toThrow('doesn’t balance');
  });
});

describe('Splitwise import route', () => {
  async function request(raw: string, file: string, people: { name: string; me?: boolean; memberID?: string }[], extra: Record<string, unknown> = {}) {
    const g = await parseSplitwise(raw, file);
    return { g, body: { group: { id: await importGroupID(g.fingerprint, user), name: g.name, kind: 'trip', currency: mainCurrency(g) }, people, rows: g.rows, ...extra } };
  }
  const tripPeople = [{ name: 'Harris', me: true }, { name: 'Maya' }, { name: 'Alex' }, { name: 'Sam' }];

  it('creates the group, placeholders and entries atomically, and matches Splitwise to the cent', async () => {
    const { g, body } = await request(trip, 'buenos-aires-trip_2026-11-18_export.csv', tripPeople);
    const res = await call('/v1/import/splitwise', body);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: true, inserted: 7, duplicates: 0 });
    const snap = await snapshot();
    const group = snap.groups[0];
    expect(group).toMatchObject({ name: 'Buenos Aires Trip', currency: 'ARS' });
    expect(group.members.map(m => m.userID === user ? 'me' : m.name).sort()).toEqual(['Alex', 'Maya', 'Sam', 'me']);
    const byName = new Map(group.members.map(m => [m.userID === user ? 'Harris' : m.name, m.id]));
    for (const currency of ['ARS', 'USD']) {
      const b = balances(snap.entries, currency);
      for (const name of g.members) expect(b[byName.get(name)!] ?? 0).toBe(g.totals[currency][name]);
    }
    expect(snap.entries.find(e => e.title === 'Groceries for the asado')!.payers).toHaveLength(2);
    expect(snap.entries.filter(e => e.kind === 'settlement')).toHaveLength(2);
  });

  it('detects a repeated file and inserts nothing twice', async () => {
    const { body } = await request(trip, 'buenos-aires-trip_2026-11-18_export.csv', tripPeople);
    await call('/v1/import/splitwise', body);
    const again = await call('/v1/import/splitwise', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, inserted: 0, duplicates: 7 });
    const snap = await snapshot();
    expect(snap.groups).toHaveLength(1);
    expect(snap.entries).toHaveLength(7);
  });

  it('maps names onto existing members and rolls back everything on a bad row', async () => {
    await call('/v1/groups', { id: 'existing-group', name: 'Trip', kind: 'trip', currency: 'ARS', members: [{ id: 'seat-harris', userID: user, name: 'Harris K' }, { id: 'seat-maya', name: 'Maya R' }] });
    const g = await parseSplitwise(trip, 'buenos-aires-trip_2026-11-18_export.csv');
    const people = [{ name: 'Harris', me: true }, { name: 'Maya', memberID: 'seat-maya' }, { name: 'Alex' }, { name: 'Sam' }];
    const broken = [...g.rows, { ...g.rows[0], amount: g.rows[0].amount + 1 }];
    await expect(call('/v1/import/splitwise', { groupID: 'existing-group', people, rows: broken })).rejects.toThrow('split must match');
    expect((await snapshot()).groups[0].members).toHaveLength(2);
    const ok = await call('/v1/import/splitwise', { groupID: 'existing-group', people, rows: g.rows });
    expect(await ok.json()).toMatchObject({ created: false, inserted: 7 });
    const snap = await snapshot();
    expect(snap.groups[0].members).toHaveLength(4);
    expect(balances(snap.entries, 'USD')['seat-maya']).toBe(-12000);
    expect(balances(snap.entries, 'ARS')['seat-harris']).toBe(-2614596);
  });

  it('enforces membership and mapping rules', async () => {
    await call('/v1/groups', { id: 'private-group', name: 'Home', kind: 'home', currency: 'EUR', members: [{ id: 'seat-owner', userID: 'someone-else', name: 'Owner' }] }, 'someone-else');
    const g = await parseSplitwise(piso, 'piso-compartido_2026-11-18_export.csv');
    const people = g.members.map((name, i) => ({ name, me: i === 0 }));
    await expect(call('/v1/import/splitwise', { groupID: 'private-group', people, rows: g.rows })).rejects.toThrow('Join the group');
    await expect(call('/v1/import/splitwise', { groupID: 'private-group', people: people.map(p => ({ ...p, memberID: 'seat-owner', me: false })), rows: g.rows }, 'someone-else')).rejects.toThrow('same person');
    const { body } = await request(piso, 'piso-compartido_2026-11-18_export.csv', g.members.map(name => ({ name })));
    await expect(call('/v1/import/splitwise', body)).rejects.toThrow('which Splitwise name is you');
    const taken = { ...body, people, group: { ...body.group, id: 'private-group' } };
    await expect(call('/v1/import/splitwise', taken)).rejects.toThrow('already used');
    await expect(call('/v1/import/splitwise', { ...body, people, rows: g.rows.map(r => ({ ...r, splits: [{ name: 'Stranger', amount: r.amount }] })) })).rejects.toThrow('needs a person');
    expect((await snapshot()).groups).toHaveLength(0);
  });
});
