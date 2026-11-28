// Group exports for the CLI and MCP. Amounts stay in integer minor units until formatted as decimals.
import { settlementEntry } from '../exchange';
import { breakdown, entryItems, grossItems } from '../items';
import { Entry, entryPayers, entrySign } from '../ledger';

interface Member { id: string; name: string; userID: string|null; removed?: boolean; payment?: Record<string,string> }
interface Group { id: string; name: string; currency: string; kind?: string; description?: string; startDate?: string; endDate?: string; members: Member[] }

const decimal = (minor: number) => (minor < 0 ? '-' : '') + (Math.abs(minor) / 100).toFixed(2);
// RFC 4180 quoting, and a leading apostrophe so spreadsheets never evaluate text as a formula.
function cell(value: string | number) {
  const text = typeof value === 'number' ? decimal(value) : value;
  const safe = typeof value === 'string' && /^[\s﻿]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
const table = (rows: (string|number)[][]) => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

export function exportGroup(group: Group, entries: Entry[], format: 'ledger'|'summary'|'json', comments: Record<string, unknown> = {}) {
  const sorted = entries.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const nameOf = (id: string) => group.members.find(m => m.id === id)?.name ?? id;
  const slug = group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'split';
  if (format === 'json') {
    return { filename: slug + '.json', mimeType: 'application/json', content: JSON.stringify({
      exportedAt: new Date().toISOString(), group,
      entries: sorted.map(e => ({ ...e, items: e.bill ? grossItems(e.bill) : entryItems(e), comments: comments[e.id] })),
      summary: currencies(sorted, group).map(c => breakdown(sorted.map(settlementEntry), group.members, c))
    }, null, 2) + '\n' };
  }
  if (format === 'summary') {
    const rows: (string|number)[][] = [['Currency', 'Member', 'Status', 'Paid', 'Share', 'Net']];
    const transfers: (string|number)[][] = [];
    for (const c of currencies(sorted, group)) {
      const report = breakdown(sorted.map(settlementEntry), group.members, c);
      for (const m of report.members) rows.push([c, m.name, group.members.find(x => x.id === m.id)?.removed ? 'archived' : 'active', m.paid, m.share, m.net]);
      for (const t of report.settlements) transfers.push([c, nameOf(t.from), nameOf(t.to), t.amount]);
    }
    const plan = transfers.length ? '\r\n' + table([['Currency', 'From', 'To', 'Amount'], ...transfers]) : '';
    return { filename: slug + '-summary.csv', mimeType: 'text/csv', content: table(rows) + plan };
  }
  const header = ['Date', 'Type', 'Title', 'Category', 'Notes', 'Original Currency', 'Original Amount', 'FX Rate', 'FX Source',
    'Settlement Currency', 'Settlement Amount', 'Paid By', 'Split', 'Receipt Items', 'Expense Status', 'Refund Of', ...group.members.map(m => m.name)];
  const rows = sorted.map(e => {
    const se = settlementEntry(e), payers = entryPayers(se);
    return [e.createdAt.slice(0, 10), e.kind, e.title, e.category ?? '', e.notes ?? '', e.currency, e.amount,
      e.exchange ? (e.exchange.rateE8 / 1e8).toFixed(8) : '', e.exchange?.statementAmount !== undefined ? 'Charged amount override' : e.exchange?.source ?? '', se.currency, se.amount,
      payers.map(p => nameOf(p.memberID) + ' ' + decimal(p.amount)).join('; '),
      se.splits.map(p => nameOf(p.memberID) + ' ' + decimal(p.amount)).join('; '),
      entryItems(e).map(i => i.title + ' ' + decimal(i.gross) + ' [' + (i.open ? 'open' : i.portions.map(p => nameOf(p.memberID)).join('+')) + ']').join('; '),
      e.handled ? 'Handled' : e.pending ? 'Pending' + (e.pendingNote ? ': ' + e.pendingNote : '') : '',
      e.refundOf ? sorted.find(o => o.id === e.refundOf)?.title ?? e.refundOf : '',
      ...group.members.map(m => entrySign(e) * (payers.filter(p => p.memberID === m.id).reduce((s, p) => s + p.amount, 0) - (se.splits.find(p => p.memberID === m.id)?.amount ?? 0)))];
  });
  return { filename: slug + '.csv', mimeType: 'text/csv', content: table([header, ...rows]) };
}
function currencies(entries: Entry[], group: Group) {
  return [...new Set([group.currency, ...entries.map(e => e.exchange?.target ?? e.currency)])];
}
