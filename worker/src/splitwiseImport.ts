// Imports one Splitwise group export as a single atomic D1 batch: the new group (or an existing
// one the caller belongs to), placeholders for unmatched names, and every expense and payment.
import { HTTPError, json } from './http';
import { currencies, Entry, InputError, validID, validateEntry } from './ledger';
import { MAX_ROWS } from './splitwiseCsv';

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
const key = (name: string) => name.trim().toLowerCase();
type Person = { name: string; memberID?: string; me?: boolean };
type Share = { name: string; amount: number };
type Row = { title: unknown; day: unknown; payer: unknown; amount: unknown; currency: unknown; category?: unknown; payment?: unknown; splits: unknown; payers?: unknown };

export async function importSplitwise(db: D1Database, user: string, b: Record<string, unknown>) {
  const rows = b.rows as Row[], people = b.people as Person[];
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new InputError(`Import 1–${MAX_ROWS} entries per group.`);
  if (!Array.isArray(people) || !people.length || people.length > 50 ||
    people.some(p => !p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 ||
      (p.memberID !== undefined && p.memberID !== null && !validID(p.memberID)) || (p.me !== undefined && p.me !== null && typeof p.me !== 'boolean')))
    throw new InputError('Check the people in this import.');
  if (new Set(people.map(p => key(p.name))).size !== people.length) throw new InputError('Each Splitwise name can only appear once.');
  if (people.filter(p => p.me).length > 1) throw new InputError('Choose yourself once.');

  const spec = b.group as { id: unknown; name: unknown; kind: unknown; currency: unknown } | undefined;
  let group: string, creating = false;
  const statements: D1PreparedStatement[] = [];
  if (spec) {
    if (!spec || typeof spec !== 'object' || !validID(spec.id) || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 80 ||
      !['trip', 'home', 'friend'].includes(String(spec.kind)) || !currencies.includes(spec.currency as typeof currencies[number]))
      throw new InputError('Check the group name and currency.');
    if (!people.some(p => p.me)) throw new InputError('Choose which Splitwise name is you.');
    group = spec.id;
    const existing = await db.prepare('SELECT creator FROM groups WHERE id=?').bind(group).first<{ creator: string }>();
    if (existing && existing.creator !== user) throw new HTTPError(409, 'Group ID already used.');
    creating = !existing;
  } else {
    if (!validID(b.groupID)) throw new InputError('Choose a group.');
    group = b.groupID;
  }
  const seat = await db.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(group, user).first<{ id: string }>();
  if (!creating && !seat) throw new HTTPError(403, 'Join the group first.');

  // The snapshot serves up to 5,000 entries; an import must not push an account past it.
  const visible = await db.prepare('SELECT count(*) AS n FROM entries e JOIN members m ON m.group_id=e.group_id WHERE m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries)')
    .bind(user).first<{ n: number }>();
  if ((visible?.n ?? 0) + rows.length > 5000) throw new HTTPError(409, 'This import would pass the 5,000-entry beta limit. Archive or delete older entries first.');

  const roster = creating ? [] : (await db.prepare('SELECT id,user_id AS userID FROM members WHERE group_id=? AND id NOT IN (SELECT member_id FROM member_aliases)')
    .bind(group).all<{ id: string; userID: string | null }>()).results;
  const ids = new Map<string, string>(), used = new Set<string>();
  let myID = seat?.id;
  if (creating) {
    myID = await digest(['splitwise-me', group, user]);
    const profile = await db.prepare('SELECT name FROM split_profiles WHERE user_id=?').bind(user).first<{ name: string }>();
    const me = people.find(p => p.me)!;
    const count = await db.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').bind(user).first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw new HTTPError(409, 'Group limit reached.');
    statements.push(db.prepare('INSERT INTO groups(id,name,kind,currency,creator,created_at) VALUES (?,?,?,?,?,?)')
      .bind(group, (spec!.name as string).trim(), spec!.kind, spec!.currency, user, new Date().toISOString()));
    statements.push(db.prepare('INSERT INTO members VALUES (?,?,?,?)').bind(myID, group, user, (profile?.name ?? me.name).trim().slice(0, 60)));
  }
  for (const p of people) {
    let id: string;
    if (p.me) id = myID!;
    else if (p.memberID) {
      if (!roster.some(m => m.id === p.memberID)) throw new InputError('Choose people from this group.');
      id = p.memberID;
    } else {
      // Same id as the generic CSV import, so a repeated import reuses the placeholder.
      id = await digest(['csv-person', group, key(p.name)]);
      if (!roster.some(m => m.id === id)) statements.push(db.prepare('INSERT INTO members VALUES (?,?,NULL,?) ON CONFLICT(id) DO NOTHING').bind(id, group, p.name.trim()));
    }
    if (used.has(id)) throw new InputError('Two Splitwise names point to the same person.');
    used.add(id); ids.set(key(p.name), id);
  }
  const memberIDs = [...new Set([...roster.map(m => m.id), ...used])];
  const resolve = (name: unknown) => {
    const id = typeof name === 'string' ? ids.get(key(name)) : undefined;
    if (!id) throw new InputError('Every name in the import needs a person.');
    return id;
  };
  const shares = (list: unknown): Share[] => {
    if (!Array.isArray(list) || !list.length || list.length > 50) throw new InputError('Invalid import row.');
    return list as Share[];
  };

  const records: [string, string, string][] = [], copies = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(row.day)) throw new InputError('Invalid import row.');
    const payment = row.payment === true;
    const splits = shares(row.splits).map(s => ({ memberID: resolve(s.name), amount: s.amount }));
    const payers = row.payers === undefined || row.payers === null ? undefined : shares(row.payers).map(s => ({ memberID: resolve(s.name), amount: s.amount }));
    const paidBy = resolve(row.payer);
    const e: Entry = validateEntry({
      id: 'splitwise-entry', groupID: group, title: row.title, paidBy, amount: row.amount, currency: row.currency,
      kind: payment ? 'settlement' : 'expense', category: payment || row.category == null ? undefined : row.category,
      splitMode: 'exact', createdAt: row.day + 'T12:00:00Z', splits, ...(payers && payers.length > 1 ? { payers } : {}),
    }, memberIDs);
    const fingerprint = await digest(e), ordinal = copies.get(fingerprint) ?? 0;
    copies.set(fingerprint, ordinal + 1);
    e.id = await digest([group, fingerprint, ordinal]);
    records.push([e.id, JSON.stringify(e), e.createdAt]);
  }
  // One statement inserts every entry, so the import is all-or-nothing and stays within D1's per-request query budget.
  statements.push(db.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at)
    SELECT json_extract(value,'$[0]'),?,?,json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?) WHERE true
    ON CONFLICT(id) DO NOTHING`).bind(group, user, JSON.stringify(records)));
  const result = await db.batch(statements);
  const inserted = result[result.length - 1].meta.changes;
  return json({ groupID: group, created: creating, inserted, duplicates: rows.length - inserted }, creating ? 201 : 200);
}
