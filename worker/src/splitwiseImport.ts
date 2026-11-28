// Imports one Splitwise group export as a single atomic D1 batch: the new group (or an existing
// one the caller belongs to), placeholders for unmatched names, and every expense and payment.
import { HTTPError, json } from './http';
import { isPublishedSource } from './fx';
import { currencies, Entry, InputError, validID, validateEntry } from './ledger';
import { MAX_ROWS, isoDay } from './splitwiseCsv';

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
const key = (name: string) => name.trim().toLowerCase();
type Person = { name: string; displayName?: string; memberID?: string; userID?: string; me?: boolean };
type Seat = { id: string; userID: string | null; removedAt: string | null; canonicalID: string | null };
type Share = { name: string; amount: number };
type Row = { title: unknown; day: unknown; payer: unknown; amount: unknown; currency: unknown; category?: unknown; payment?: unknown; refund?: unknown; splits: unknown; payers?: unknown; exchange?: Entry['exchange'] };

export async function importSplitwise(db: D1Database, user: string, b: Record<string, unknown>) {
  const rows = b.rows as Row[], people = b.people as Person[];
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new InputError(`Import 1–${MAX_ROWS} entries per group.`);
  if (!Array.isArray(people) || !people.length || people.length > 50 ||
    people.some(p => !p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 ||
      (p.displayName !== undefined && (typeof p.displayName !== 'string' || !p.displayName.trim() || p.displayName.trim().length > 60)) ||
      (p.memberID != null && !validID(p.memberID)) || (p.userID != null && !validID(p.userID)) ||
      (p.me != null && typeof p.me !== 'boolean') || [p.me, p.memberID, p.userID].filter(Boolean).length > 1 || p.userID === user))
    throw new InputError('Check the people in this import.');
  if (new Set(people.map(p => key(p.name))).size !== people.length) throw new InputError('Each Splitwise name can only appear once.');
  if (people.filter(p => p.me).length > 1) throw new InputError('Choose yourself once.');

  const spec = b.group as { id: unknown; name: unknown; kind: unknown; currency: unknown } | undefined;
  const settlement = b.settlementCurrency;
  if (settlement !== undefined && (typeof settlement !== 'string' || !currencies.includes(settlement) || (spec && spec.currency !== settlement)))
    throw new InputError('Choose a supported import currency.');
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
  const seat = await db.prepare('SELECT id FROM members WHERE group_id=? AND user_id=? AND removed_at IS NULL').bind(group, user).first<{ id: string }>();
  if (!creating && !seat) throw new HTTPError(403, 'Join the group first.');

  // The snapshot serves up to 5,000 entries; an import must not push an account past it.
  const visible = await db.prepare('SELECT count(*) AS n FROM entries e JOIN members m ON m.group_id=e.group_id WHERE m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries)')
    .bind(user).first<{ n: number }>();
  if ((visible?.n ?? 0) + rows.length > 5000) throw new HTTPError(409, 'This import would pass the 5,000-entry beta limit. Archive or delete older entries first.');

  const roster = creating ? [] : (await db.prepare(`SELECT m.id,m.user_id AS userID,m.removed_at AS removedAt,a.canonical_id AS canonicalID
    FROM members m LEFT JOIN member_aliases a ON a.member_id=m.id WHERE m.group_id=?`).bind(group).all<Seat>()).results;
  const linkedUsers = people.flatMap(p => p.userID ? [p.userID] : []);
  if (new Set(linkedUsers).size !== linkedUsers.length) throw new InputError('Two Splitwise names point to the same person.');
  const profiles = linkedUsers.length ? (await db.prepare(`SELECT user_id AS userID,name FROM split_profiles
    WHERE user_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(linkedUsers)).all<{userID: string; name: string}>()).results : [];
  if (profiles.length !== linkedUsers.length) throw new InputError('Choose a Split user from search results.');
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
    statements.push(db.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)').bind(myID, group, user, (me.displayName ?? profile?.name ?? me.name).trim().slice(0, 60)));
  }
  for (const p of people) {
    // Keep the original CSV name as the identity key even when a display name changes.
    const sourceID = await digest(['csv-person', group, key(p.name)]);
    const sourceSeat = roster.find(m => m.id === sourceID);
    const sourceOwner = sourceSeat?.canonicalID ? roster.find(m => m.id === sourceSeat.canonicalID) : sourceSeat;
    const linkUser = p.me && sourceSeat ? user : p.userID;
    const accountSeat = linkUser ? roster.find(m => m.userID === linkUser) : undefined;
    const explicitSeat = p.memberID ? roster.find(m => m.id === p.memberID && !m.canonicalID && !m.removedAt) : undefined;
    if (p.memberID && !explicitSeat) throw new InputError('Choose active people from this group.');
    if (accountSeat?.removedAt) throw new InputError('Restore this person in the group before linking their history.');
    if (linkUser && sourceOwner?.userID && sourceOwner.userID !== linkUser)
      throw new InputError('This Splitwise name is already linked to another account.');
    if (linkUser && (sourceSeat?.removedAt || sourceOwner?.removedAt)) throw new InputError('Restore this person in the group before linking their history.');

    let id = p.me ? myID! : explicitSeat?.id ?? accountSeat?.id ?? sourceID;
    // A previously imported seat keeps its historical ID after it becomes an alias.
    if ((linkUser && sourceSeat) || (explicitSeat && sourceSeat?.canonicalID === explicitSeat.id)) id = sourceID;
    const canonical = p.me ? myID! : explicitSeat?.id ?? accountSeat?.id ?? sourceOwner?.id ?? id;
    if (used.has(canonical)) throw new InputError('Two Splitwise names point to the same person.');
    used.add(canonical);
    ids.set(key(p.name), id);

    if (!p.me && !explicitSeat && id === sourceID && !sourceSeat) {
      const name = p.displayName ?? profiles.find(profile => profile.userID === p.userID)?.name ?? p.name;
      statements.push(db.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id, group, p.userID ?? null, name.trim()));
    } else if (linkUser && sourceSeat && !sourceOwner?.userID) {
      if (accountSeat) {
        statements.push(db.prepare(`INSERT INTO member_aliases(member_id,canonical_id)
          SELECT id,? FROM members WHERE id=? AND group_id=? AND user_id IS NULL AND removed_at IS NULL
          ON CONFLICT(member_id) DO NOTHING`).bind(accountSeat.id, sourceID, group));
      } else {
        statements.push(db.prepare(`UPDATE members SET user_id=?, name=COALESCE(?,name)
          WHERE id=? AND group_id=? AND user_id IS NULL AND removed_at IS NULL
          AND id NOT IN (SELECT member_id FROM member_aliases)`).bind(linkUser, p.displayName?.trim() ?? null, sourceID, group));
      }
    } else if (p.displayName && !p.me && !p.userID) {
      statements.push(db.prepare(`UPDATE members SET name=? WHERE id=? AND group_id=? AND user_id IS NULL
        AND removed_at IS NULL AND id NOT IN (SELECT member_id FROM member_aliases)`).bind(p.displayName.trim(), id, group));
    }
  }
  const memberIDs = [...new Set([...roster.map(m => m.id), ...ids.values()])];
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
  const importedPayments: string[] = [];
  const hasOtherAccounts = roster.some(member => member.userID && member.userID !== user);
  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(row.day)) throw new InputError('Invalid import row.');
    const payment = row.payment === true, refund = row.refund === true;
    if (refund && (payment || row.payers != null)) throw new InputError('Invalid import row.');
    const splits = shares(row.splits).map(s => ({ memberID: resolve(s.name), amount: s.amount }));
    const payers = row.payers === undefined || row.payers === null ? undefined : shares(row.payers).map(s => ({ memberID: resolve(s.name), amount: s.amount }));
    const paidBy = resolve(row.payer);
    let exchange: Entry['exchange'];
    if (settlement !== undefined && row.currency !== settlement) {
      const x = row.exchange;
      if (!x || x.target !== settlement || !isPublishedSource(x.source) ||
        typeof x.date !== 'string' || isoDay(x.date) !== x.date || x.date > row.day || x.date > today ||
        x.statementAmount !== undefined)
        throw new InputError('Each foreign entry needs a published rate from its date or earlier.');
      exchange = x;
    } else if (row.exchange !== undefined && row.exchange !== null) {
      throw new InputError('Only foreign entries need an import exchange rate.');
    }
    const e = validateEntry({
      id: 'splitwise-entry', groupID: group, title: row.title, paidBy, amount: row.amount, currency: row.currency,
      kind: payment ? 'settlement' : refund ? 'refund' : 'expense', category: payment || row.category == null ? undefined : row.category,
      splitMode: 'exact', createdAt: row.day + 'T12:00:00Z', splits, exchange, ...(payers && payers.length > 1 ? { payers } : {}),
    }, memberIDs);
    // Hash the original transaction so a rate change can't create a duplicate.
    const { exchange: _estimate, ...original } = e;
    const fingerprint = await digest(original), ordinal = copies.get(fingerprint) ?? 0;
    copies.set(fingerprint, ordinal + 1);
    e.id = await digest([group, fingerprint, ordinal]);
    if (payment && hasOtherAccounts) importedPayments.push(e.id);
    records.push([e.id, JSON.stringify(e), e.createdAt]);
  }
  if (importedPayments.length) {
    const known = await db.prepare(`SELECT count(*) AS n FROM entries
      WHERE group_id=? AND id IN (SELECT value FROM json_each(?))`)
      .bind(group, JSON.stringify(importedPayments)).first<number>('n');
    if (known !== importedPayments.length)
      throw new InputError('Import payment history into a new group or request approval from Settle up.');
  }
  // One statement inserts every entry, so the import is all-or-nothing and stays within D1's per-request query budget.
  statements.push(db.prepare(`INSERT INTO entries(id,group_id,author,payload,created_at)
    SELECT json_extract(value,'$[0]'),?,?,json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?) WHERE true
    ON CONFLICT(id) DO NOTHING`).bind(group, user, JSON.stringify(records)));
  const result = await db.batch(statements);
  const inserted = result[result.length - 1].meta.changes;
  const importedPeople = people.map(p => ({ name: p.name, memberID: ids.get(key(p.name))! }));
  return json({ groupID: group, created: creating, inserted, duplicates: rows.length - inserted, people: importedPeople }, creating ? 201 : 200);
}
