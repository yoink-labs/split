import type { LedgerHandler } from './cli/operations';
import type { DeviceIdentity } from './cli/devices';
import { settlementEntry } from './exchange';
import { impliedRate } from './fx';
import { HTTPError, json } from './http';
import { currencies, validID } from './ledger';
import { grossItems, itemPortions } from './items';
import type { Entry } from './ledger';
import { purchaseRoute, viewerAmounts } from './receipts';

interface Snapshot {
  groups: { id: string; name: string; members: { id: string; userID: string | null; name: string }[] }[];
  entries: Entry[];
}

const endpoint = '/v1/integrations/finance';
const pageSize = 25;

export async function financeRoute(request: Request, env: Env, user: string, handle: LedgerHandler, device?: DeviceIdentity) {
  const url = new URL(request.url);
  const capabilities = device?.capabilities ? device.capabilities.split(',') : [];
  if (url.pathname === endpoint + '/capabilities' && request.method === 'GET') return json({ capabilities });
  const charge = url.pathname.match(/^\/v1\/integrations\/finance\/expenses\/([\w-]{8,80})\/charge$/);
  if (charge && request.method === 'POST') {
    if (!device || !capabilities.includes('charges:write'))
      return json({ error: 'Approve Finance again and allow it to update card charges.', code: 'scope_required' }, 403);
    return chargeRoute(request, env, user, handle, device, charge[1]);
  }
  const receipt = url.pathname.match(/^\/v1\/integrations\/finance\/receipts\/([\w-]{8,80})\/([\w-]{8,80})$/);
  if (request.method !== 'GET') throw new HTTPError(403, 'Finance has read-only access.');
  if (receipt) {
    const path = '/v1/entries/' + receipt[1] + '/receipts/' + receipt[2];
    const response = await purchaseRoute(new Request(new URL(path, url)), env, user, true);
    if (response) return response;
  }
  if (url.pathname !== endpoint + '/expenses') throw new HTTPError(403, 'This device only has access to Finance.');

  const snapshot = await (await handle(new Request(new URL('/v1/snapshot', url)), env, user)).json<Snapshot>();
  const groups = new Map(snapshot.groups.map(group => [group.id, {
    name: group.name,
    viewer: group.members.find(member => member.userID === user)?.id,
    members: new Map(group.members.map(member => [member.id, member.name])),
  }]));
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120).toLowerCase();
  const receiptsOnly = url.searchParams.get('receipts') === '1';
  const requestedPage = Number(url.searchParams.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const expenses = snapshot.entries.flatMap(entry => {
    const group = groups.get(entry.groupID);
    if (!group?.viewer || entry.kind !== 'expense') return [];
    const { paid, share } = viewerAmounts(entry, group.viewer);
    if (!paid && !share) return [];
    const receiptIDs = entry.receiptIDs ?? [];
    if (receiptsOnly && !receiptIDs.length && !entry.bill) return [];
    if (query && ![entry.title, group.name, entry.category, ...(entry.bill?.items.map(item => item.title) ?? [])]
      .some(value => value?.toLowerCase().includes(query))) return [];
    return [{ entry, group, viewer: group.viewer, paid, share, receiptIDs }];
  }).sort((a,b) => Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt) || a.entry.id.localeCompare(b.entry.id));

  return json({
    page, pageSize, total: expenses.length,
    expenses: expenses.slice((page - 1) * pageSize, page * pageSize).map(({ entry, group, viewer, paid, share, receiptIDs }) => {
      const converted = entry.exchange ? settlementEntry(entry) : undefined;
      return {
        id: entry.id, title: entry.title, date: entry.createdAt, group: group.name,
        amount: entry.amount, currency: entry.currency, paid, share, receiptIDs,
        category: entry.category, notes: entry.notes, ...(entry.pending ? { pending: true } : {}),
        conversion: converted && { currency: converted.currency, total: converted.amount, ...viewerAmounts(converted, viewer) },
        exchange: entry.exchange && { target: entry.exchange.target, rateE8: entry.exchange.rateE8, source: entry.exchange.source,
          ...(entry.exchange.statementAmount === undefined ? {} : { statementAmount: entry.exchange.statementAmount }) },
        bill: entry.bill && {
          closed: entry.bill.closed, tax: entry.bill.tax, tip: entry.bill.tip,
          items: grossItems(entry.bill).map(item => ({
            id: item.id, title: item.title, amount: item.amount,
            mine: item.memberIDs.includes(viewer),
            share: itemPortions(item, entry.paidBy).reduce((sum, portion) =>
              sum + (portion.memberID === viewer ? portion.amount : 0), 0),
            claimants: item.memberIDs.map(id => group.members.get(id) ?? 'Group member'),
          })),
        },
      };
    }),
  });
}

const fail = (status: number, code: string, error: string) => json({ error, code }, status);
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  b => b.toString(16).padStart(2, '0')).join('');

/**
 * Sets the amount a card actually charged for a foreign expense the viewer
 * recorded and paid in full. Stored as Split's own statement amount, so every
 * member's share in the charged currency is re-spread from the unchanged
 * original-currency shares, and charged_amount_history keeps the previous
 * figure. The Idempotency-Key makes a retry return the first answer.
 */
async function chargeRoute(request: Request, env: Env, user: string, handle: LedgerHandler, device: DeviceIdentity, id: string) {
  const key = request.headers.get('Idempotency-Key') ?? '';
  if (!/^[\w-]{16,100}$/.test(key)) return fail(422, 'idempotency_key_required', 'Send an Idempotency-Key header.');
  const input = await request.json<Record<string, unknown>>().catch(() => null);
  const basis = input?.basis as Record<string, unknown> | undefined;
  const charged = input?.chargedAmount, target = input?.chargedCurrency, rate = input?.rateE8;
  if (!input || !Number.isSafeInteger(charged) || (charged as number) < 1 || (charged as number) > 100_000_000_000
      || typeof target !== 'string' || !currencies.includes(target as typeof currencies[number]) || !Number.isSafeInteger(rate)
      || !basis || !Number.isSafeInteger(basis.amount) || typeof basis.currency !== 'string'
      || !(basis.statementAmount === null || Number.isSafeInteger(basis.statementAmount)))
    return fail(422, 'invalid', 'Check the charged amount, currency, rate and basis.');
  const hash = await sha256(JSON.stringify([id, charged, target, rate, basis.amount, basis.currency, basis.statementAmount]));
  const scoped = device.id + ':' + key;

  const replay = async () => {
    const row = await env.DB.prepare('SELECT request_hash,response,user_id FROM finance_charge_updates WHERE idempotency_key=?').bind(scoped)
      .first<{ request_hash: string; response: string | null; user_id: string }>();
    if (!row) return null;
    if (row.user_id !== user || row.request_hash !== hash) return fail(422, 'idempotency_conflict', 'This Idempotency-Key was used for a different update.');
    if (!row.response) return fail(409, 'in_progress', 'This update is still being applied. Try again shortly.');
    return json({ ...JSON.parse(row.response), applied: false });
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const snapshot = await (await handle(new Request(new URL('/v1/snapshot', request.url)), env, user)).json<{ groups: Snapshot['groups']; entries: (Entry & { editable?: boolean })[] }>();
  const entry = snapshot.entries.find(row => row.id === id && row.kind === 'expense');
  const group = entry && snapshot.groups.find(row => row.id === entry.groupID);
  const viewer = group?.members.find(member => member.userID === user)?.id;
  if (!entry || !viewer || !validID(id)) return fail(404, 'expense_not_found', 'This expense is not in your Split groups.');
  const { paid } = viewerAmounts(entry, viewer);
  if (paid !== entry.amount) return fail(409, 'not_sole_payer', 'Only an expense you paid in full can take your card charge.');
  if (!entry.editable) return fail(403, 'not_author', 'Only the person who recorded this expense can change its charged amount.');
  if (entry.pending) return fail(409, 'pending', 'Confirm this pending expense in Split first.');
  if (entry.currency === target) return fail(422, 'same_currency', 'A charged amount needs a foreign-currency expense.');
  if (entry.exchange && entry.exchange.target !== target) return fail(409, 'expense_changed', 'This expense converts to a different currency in Split.');
  const current = entry.exchange ? settlementEntry(entry).amount : null;
  if (entry.amount !== basis.amount || entry.currency !== basis.currency || current !== basis.statementAmount)
    return fail(409, 'expense_changed', 'This expense changed in Split. Review the match again.');
  if (impliedRate(entry.amount, charged as number) !== rate) return fail(422, 'invalid', 'The rate does not match the charged amount.');

  const claimed = await env.DB.prepare(`INSERT INTO finance_charge_updates(idempotency_key,token_id,user_id,entry_id,request_hash,
      previous_currency,previous_amount,charged_currency,charged_amount,rate_e8) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(scoped, device.id, user, id, hash, entry.exchange?.target ?? null, current, target, charged, rate).run();
  if (!claimed.meta.changes) return (await replay())!;
  try {
    const { recurrence, receiptIDs, editable, commentCount, likeCount, likedByMe, ...original } = entry as Entry & Record<string, unknown>;
    void recurrence; void receiptIDs; void editable; void commentCount; void likeCount; void likedByMe;
    const updated: Entry = { ...original as Entry, exchange: { target, rateE8: rate as number, date: entry.createdAt.slice(0, 10), source: 'Statement', statementAmount: charged as number } };
    const saved = await handle(new Request(new URL('/v1/entries/' + id + '/edit', request.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ original, entry: updated, reason: 'Card charge updated through Finance.' }),
    }), env, user);
    if (!saved.ok) throw new HTTPError(saved.status, (await saved.json<{ error?: string }>().catch(() => ({ error: undefined }))).error ?? 'Could not save.');
    const converted = settlementEntry(updated);
    const result = { expense: { id, exchange: updated.exchange, conversion: { currency: converted.currency, total: converted.amount, ...viewerAmounts(converted, viewer) } } };
    await env.DB.prepare('UPDATE finance_charge_updates SET response=? WHERE idempotency_key=?').bind(JSON.stringify(result), scoped).run();
    return json({ ...result, applied: true });
  } catch (error) {
    await env.DB.prepare('DELETE FROM finance_charge_updates WHERE idempotency_key=? AND response IS NULL').bind(scoped).run();
    if (error instanceof HTTPError && error.status === 409) return fail(409, 'expense_changed', 'This expense changed in Split. Review the match again.');
    throw error;
  }
}
