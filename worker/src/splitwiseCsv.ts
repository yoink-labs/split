// Parser for Splitwise's per-group "Export as spreadsheet" CSV. Shared by the web client and
// covered by Worker tests; the iOS app has the same rules in SplitwiseImport.swift.
import { allocate, currencies } from './ledger';

export interface ImportShare { name: string; amount: number }
export interface ImportRow {
  title: string; day: string; payer: string; amount: number; currency: string; category?: string;
  payment: boolean; splits: ImportShare[]; payers?: ImportShare[];
}
export interface SplitwiseGroup {
  name: string; members: string[]; rows: ImportRow[];
  /** Splitwise's own "Total balance" rows: currency → member → minor units. */
  totals: Record<string, Record<string, number>>;
  skipped: string[]; fingerprint: string;
}
export interface Mismatch { currency: string; member: string; expected: number; imported: number }
export const MAX_ROWS = 1500;

export function csvTable(raw: string): string[][] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === delimiter || c === '\n')) {
      row.push(cell); cell = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed quotation mark in CSV.');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}

const key = (s: string) => s.trim().toLowerCase();
// Splitwise translates the header, categories and the total label into the account language,
// so columns are matched by position and rows by shape. These lists only add confidence.
const PAYMENT = ['payment', 'zahlung', 'pago', 'paiement', 'pagamento', 'betaling', 'betalning', 'płatność', 'platba', 'платеж', 'ödeme'];
const TOTAL = ['total balance', 'gesamtbilanz', 'saldo total', 'solde total', 'saldo totale', 'totaal saldo', 'saldo całkowite', 'общий баланс'];
const CATEGORY: Record<string, string> = {'dining out': 'Dining', 'groceries': 'Groceries', 'liquor': 'Liquor', 'rent': 'Rent', 'mortgage': 'Rent', 'household supplies': 'Home', 'furniture': 'Home', 'maintenance': 'Home', 'pets': 'Home', 'services': 'Home', 'electronics': 'Home', 'home - other': 'Home', 'electricity': 'Utilities', 'heat/gas': 'Utilities', 'water': 'Utilities', 'tv/phone/internet': 'Utilities', 'trash': 'Utilities', 'cleaning': 'Utilities', 'utilities - other': 'Utilities', 'taxi': 'Transport', 'bus/train': 'Transport', 'car': 'Transport', 'gas/fuel': 'Transport', 'parking': 'Transport', 'bicycle': 'Transport', 'transportation - other': 'Transport', 'plane': 'Travel', 'hotel': 'Travel', 'movies': 'Entertainment', 'music': 'Entertainment', 'sports': 'Entertainment', 'games': 'Entertainment', 'entertainment - other': 'Entertainment', 'clothing': 'Shopping', 'gifts': 'Gifts', 'medical expenses': 'Health', 'education': 'Education', 'childcare': 'Education', 'insurance': 'Fees', 'taxes': 'Fees', 'food and drink - other': 'Dining', 'life - other': 'Other', 'other': 'Other', 'entertainment': 'Entertainment'};
/** Splitwise's English category names mapped onto Split's; anything else keeps its own name. */
export function splitCategory(name: string) { return CATEGORY[key(name)] ?? name.slice(0, 50); }
/** The header is the first row with 6+ cells whose first cell isn't a date and fourth isn't an amount. */
function isHeader(row: string[]) {
  return row.length >= 6 && row.slice(0, 5).every(c => c.trim()) && !isoDay(row[0]) && minor(row[3]) === null;
}
export function detectSplitwise(raw: string) {
  try { return csvTable(raw).slice(0, 5).some(isHeader); } catch { return false; }
}
export function groupNameFromFile(file: string) {
  let name = file.replace(/\.[^.]+$/, '').replace(/_\d{4}-\d{2}-\d{2}_export$/, '').replace(/[-_]+/g, ' ').trim();
  if (!name) return 'Splitwise group';
  if (name === name.toLowerCase()) name = name.replace(/\b\p{L}/gu, c => c.toUpperCase());
  return name.slice(0, 80);
}
/** Signed decimal with up to two places, to integer minor units. Empty is zero. */
export function minor(text: string): number | null {
  let s = text.trim();
  if (!s) return 0;
  const negative = s.startsWith('-');
  if (negative || s.startsWith('+')) s = s.slice(1);
  const m = s.match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const value = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (value > 100_000_000_000) return null;
  return negative ? -value : value;
}
export function isoDay(text: string): string | null {
  const t = text.trim();
  const valid = (d: string) => { if (!/^\d{4}-\d\d-\d\d$/.test(d)) return false; const t = Date.parse(d + 'T12:00:00Z'); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d; };
  if (valid(t.slice(0, 10))) return t.slice(0, 10);
  const p = t.split('/');
  if (p.length === 3 && /^\d{1,2}$/.test(p[0]) && /^\d{1,2}$/.test(p[1]) && /^\d{2}(\d{2})?$/.test(p[2])) {
    const d = `${p[2].length === 2 ? '20' + p[2] : p[2]}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}`;
    if (valid(d)) return d;
  }
  return null;
}
async function sha256(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function parseSplitwise(raw: string, fileName: string): Promise<SplitwiseGroup> {
  const rows = csvTable(raw);
  const start = rows.findIndex(isHeader);
  if (start < 0) throw new Error(`${fileName} isn’t a Splitwise export. In Splitwise, open the group, then Settings → Export as spreadsheet.`);
  const header = rows[start];
  const columns: [number, string][] = [];
  for (let i = 5; i < header.length; i++) { const n = header[i].trim(); if (n) columns.push([i, n.slice(0, 60)]); }
  if (!columns.length || columns.length > 50) throw new Error(`${fileName} needs 1–50 member columns.`);
  if (new Set(columns.map(c => key(c[1]))).size !== columns.length) throw new Error(`Two people in ${fileName} share a name. Rename one in Splitwise and export again.`);
  const order = columns.map(c => c[1]);
  const out: ImportRow[] = [], totals: SplitwiseGroup['totals'] = {}, skipped: string[] = [];
  for (let r = start + 1; r < rows.length; r++) {
    const row = rows[r], line = r + 1, cell = (i: number) => (row[i] ?? '').trim();
    if (row.every(c => !c.trim())) continue;
    const bad = () => new Error(`Check row ${line} of ${fileName}.`);
    const title = cell(1), currency = cell(4).toUpperCase();
    const nets: [string, number][] = columns.map(([i, n]) => { const v = minor(cell(i)); if (v === null) throw bad(); return [n, v]; });
    if (TOTAL.includes(key(title)) || (!cell(2) && !cell(3) && currency)) {
      if (!currency) throw bad();
      totals[currency] = Object.fromEntries(nets);
      continue;
    }
    const day = isoDay(cell(0)), cost = minor(cell(3));
    if (!day || !title || cost === null) throw bad();
    if (!currencies.includes(currency as typeof currencies[number])) { skipped.push(`${title} (${currency || 'no currency'} isn’t supported yet)`); continue; }
    const positive = nets.filter(n => n[1] > 0), negative = nets.filter(n => n[1] < 0);
    const credit = positive.reduce((a, n) => a + n[1], 0), debit = -negative.reduce((a, n) => a + n[1], 0);
    if (credit !== debit) throw new Error(`Row ${line} of ${fileName} doesn’t balance.`);
    if (credit === 0) { skipped.push(`${title} (no effect on balances)`); continue; }
    const clean = title.slice(0, 120), category = cell(2);
    if (PAYMENT.includes(key(category)) && positive.length === 1 && negative.length === 1) {
      out.push({ title: clean, day, payer: positive[0][0], amount: credit, currency, payment: true, splits: [{ name: negative[0][0], amount: credit }] });
      continue;
    }
    const total = Math.max(Math.abs(cost), credit), extra = total - credit;
    const own = positive.length === 1 ? [extra] : extra === 0 ? positive.map(() => 0) : allocate(extra, positive.map(p => p[1]));
    const payers: ImportShare[] = [], splits: ImportShare[] = [];
    positive.forEach(([name, net], i) => { payers.push({ name, amount: net + own[i] }); if (own[i] > 0) splits.push({ name, amount: own[i] }); });
    for (const [name, net] of negative) splits.push({ name, amount: -net });
    splits.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    out.push({ title: clean, day, payer: payers[0].name, amount: total, currency, payment: false, splits,
      ...(category && !['general', 'allgemein', 'general ', 'général', 'generale', 'geral', 'algemeen'].includes(key(category)) ? { category: splitCategory(category) } : {}),
      ...(payers.length > 1 ? { payers } : {}) });
  }
  if (!out.length) throw new Error(`${fileName} has no expenses to import.`);
  if (out.length > MAX_ROWS) throw new Error(`${fileName} has ${out.length} entries. Split imports up to ${MAX_ROWS} per group.`);
  return { name: groupNameFromFile(fileName), members: order, rows: out, totals, skipped, fingerprint: await sha256(raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')) };
}

export function importedBalances(g: Pick<SplitwiseGroup, 'rows'>) {
  const result: Record<string, Record<string, number>> = {};
  for (const r of g.rows) {
    const c = (result[r.currency] ??= {});
    for (const p of r.payers ?? [{ name: r.payer, amount: r.amount }]) c[p.name] = (c[p.name] ?? 0) + p.amount;
    for (const s of r.splits) c[s.name] = (c[s.name] ?? 0) - s.amount;
  }
  return result;
}
/** Imported balances against Splitwise's "Total balance" rows. Empty means exact to the cent. */
export function reconcile(g: SplitwiseGroup): Mismatch[] {
  const imported = importedBalances(g), out: Mismatch[] = [];
  for (const currency of [...new Set([...Object.keys(g.totals), ...Object.keys(imported)])].sort()) {
    if (!currencies.includes(currency as typeof currencies[number])) continue;
    for (const member of g.members) {
      const expected = g.totals[currency]?.[member] ?? 0, got = imported[currency]?.[member] ?? 0;
      if (expected !== got) out.push({ currency, member, expected, imported: got });
    }
  }
  return out;
}
export function mainCurrency(g: Pick<SplitwiseGroup, 'rows'>) {
  const counts = new Map<string, number>();
  for (const r of g.rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? 'USD';
}
export async function importGroupID(fingerprint: string, user: string) {
  return 'sw-' + (await sha256(user + ':' + fingerprint)).slice(0, 40);
}
