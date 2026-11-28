import type { LedgerHandler } from './cli/operations';
import { settlementEntry } from './exchange';
import { HTTPError, json } from './http';
import { grossItems, itemPortions } from './items';
import type { Entry } from './ledger';
import { purchaseRoute, viewerAmounts } from './receipts';

interface Snapshot {
  groups: { id: string; name: string; members: { id: string; userID: string | null; name: string }[] }[];
  entries: Entry[];
}

const endpoint = '/v1/integrations/finance';
const pageSize = 25;

export async function financeRoute(request: Request, env: Env, user: string, handle: LedgerHandler) {
  const url = new URL(request.url);
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
        conversion: converted && { currency: converted.currency, ...viewerAmounts(converted, viewer) },
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
