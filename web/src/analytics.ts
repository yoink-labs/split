import { categoryMeta } from "./categories";
import { entryPayers, isSpend, sign, type Expense } from "./data";

/** Pure, integer-cent aggregation behind the group Analytics tab. No floating point touches an amount. */

export type Granularity = "day" | "week" | "month";

export interface AnalyticsFilter {
  /** Inclusive `YYYY-MM-DD` bounds; empty means open-ended. */
  from?: string;
  to?: string;
  /** When set, only expenses this member paid for or shares in, measured by their share. */
  memberID?: string;
}

export interface AnalyticsRow {
  entry: Expense;
  /** The expense converted to the home currency, or null when no rate is available. */
  home: Expense | null;
  day: string;
  category: string;
  /** The measured amount in home cents (whole expense, or the member's share). Null without a rate. */
  amount: number | null;
  /** The measured amount in the expense's own currency. */
  original: number;
  estimated: boolean;
}

export interface Bucket { key: string; amount: number; count: number; parts: Map<string, number> }
export interface CategoryTotal { id: string; amount: number; count: number; percent: number }
export interface PersonTotal { memberID: string; paid: number; share: number; net: number; count: number }
export interface CurrencyTotal { currency: string; original: number; home: number | null; count: number; percent: number }

export interface Analytics {
  rows: AnalyticsRow[];
  /** Rows with a home amount; every chart in the home currency uses only these. */
  priced: AnalyticsRow[];
  excluded: number;
  total: number;
  estimated: boolean;
  granularity: Granularity;
  buckets: Bucket[];
  categories: CategoryTotal[];
  people: PersonTotal[];
  currencies: CurrencyTotal[];
}

const DAY = 86_400_000;
const dayMs = (day: string) => Date.parse(day + "T00:00:00Z");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `day`, `week` or `month` for a span of days, so a chart stays readable at any range. */
export function autoGranularity(from: string, to: string): Granularity {
  const span = Math.round((dayMs(to) - dayMs(from)) / DAY) + 1;
  return span <= 45 ? "day" : span <= 210 ? "week" : "month";
}

/** The bucket a day falls in. Weeks start on Monday (UTC). */
export function bucketKey(day: string, granularity: Granularity) {
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const ms = dayMs(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDay(ms - weekday * DAY);
}

/** Every bucket key from `from` to `to`, inclusive, so empty periods still show as gaps. */
export function bucketRange(from: string, to: string, granularity: Granularity, limit = 400) {
  const keys: string[] = [];
  if (granularity === "month") {
    let [y, m] = from.slice(0, 7).split("-").map(Number);
    const end = to.slice(0, 7);
    for (let key = from.slice(0, 7); key <= end && keys.length < limit;) {
      keys.push(key);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      key = `${y}-${String(m).padStart(2, "0")}`;
    }
    return keys;
  }
  const step = granularity === "week" ? 7 * DAY : DAY;
  const last = dayMs(bucketKey(to, granularity));
  for (let ms = dayMs(bucketKey(from, granularity)); ms <= last && keys.length < limit; ms += step) keys.push(isoDay(ms));
  return keys;
}

/** Whole percentages that always add up to 100, by largest remainder. */
export function percents(amounts: number[]) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return amounts.map(() => 0);
  const denominator = BigInt(total);
  const parts = amounts.map((amount, index) => {
    const scaled = BigInt(Math.max(0, amount)) * 100n;
    return { index, percent: Number(scaled / denominator), remainder: scaled % denominator };
  });
  let left = 100 - parts.reduce((sum, part) => sum + part.percent, 0);
  for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (left <= 0) break;
    part.percent += 1;
    left -= 1;
  }
  return parts.map((part) => part.percent);
}

const portion = (parts: { memberID: string; amount: number }[], id: string) =>
  parts.reduce((sum, part) => sum + (part.memberID === id ? part.amount : 0), 0);

/** The rows an analytics view covers: expenses and refunds (negative amounts, so spending is net of refunds), inside the date range, involving the member. */
export function analyticsRows(entries: Expense[], project: (entry: Expense) => Expense | null, home: string, filter: AnalyticsFilter) {
  const rows: AnalyticsRow[] = [];
  for (const entry of entries) {
    if (!isSpend(entry)) continue;
    const day = entry.createdAt.slice(0, 10);
    if (filter.from && day < filter.from) continue;
    if (filter.to && day > filter.to) continue;
    const member = filter.memberID;
    if (member && !entry.splits.some((s) => s.memberID === member && s.amount > 0)
      && !entryPayers(entry).some((p) => p.memberID === member && p.amount > 0)) continue;
    const projected = project(entry);
    const direction = sign(entry);
    const amount = projected ? direction * (member ? portion(projected.splits, member) : projected.amount) : null;
    rows.push({
      entry, home: projected, day, category: categoryMeta(entry.category).id,
      amount, original: direction * (member ? portion(entry.splits, member) : entry.amount),
      estimated: (entry.exchange?.statementAmount !== undefined ? entry.exchange.target : entry.currency) !== home,
    });
  }
  return rows;
}

export function analyze(
  entries: Expense[],
  project: (entry: Expense) => Expense | null,
  home: string,
  filter: AnalyticsFilter,
  memberIDs: string[],
  granularity?: Granularity,
): Analytics {
  const rows = analyticsRows(entries, project, home, filter);
  const priced = rows.filter((row) => row.amount !== null);
  const total = priced.reduce((sum, row) => sum + row.amount!, 0);
  const days = rows.map((row) => row.day).sort();
  const from = filter.from || days[0] || "";
  const to = filter.to || days[days.length - 1] || "";
  const grain = granularity ?? (from && to ? autoGranularity(from, to) : "month");

  const buckets = new Map<string, Bucket>();
  if (from && to) for (const key of bucketRange(from, to, grain)) buckets.set(key, { key, amount: 0, count: 0, parts: new Map() });
  for (const row of priced) {
    const key = bucketKey(row.day, grain);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = { key, amount: 0, count: 0, parts: new Map() });
    bucket.amount += row.amount!;
    bucket.count += 1;
    bucket.parts.set(row.category, (bucket.parts.get(row.category) ?? 0) + row.amount!);
  }

  const byCategory = new Map<string, { amount: number; count: number }>();
  for (const row of priced) {
    const current = byCategory.get(row.category) ?? { amount: 0, count: 0 };
    current.amount += row.amount!;
    current.count += 1;
    byCategory.set(row.category, current);
  }
  const categoryList = [...byCategory].map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
  const categoryPercents = percents(categoryList.map((item) => Math.max(0, item.amount)));

  const people = (filter.memberID ? [filter.memberID] : memberIDs).map((memberID) => {
    let paid = 0, share = 0, count = 0;
    for (const row of priced) {
      const direction = sign(row.entry);
      const p = direction * portion(entryPayers(row.home!), memberID);
      const s = direction * portion(row.home!.splits, memberID);
      paid += p;
      share += s;
      if (p || s) count += 1;
    }
    return { memberID, paid, share, net: paid - share, count };
  }).filter((person) => person.count > 0);

  const byCurrency = new Map<string, { original: number; home: number | null; count: number }>();
  for (const row of rows) {
    const current = byCurrency.get(row.entry.currency) ?? { original: 0, home: 0, count: 0 };
    current.original += row.original;
    current.home = current.home === null || row.amount === null ? null : current.home + row.amount;
    current.count += 1;
    byCurrency.set(row.entry.currency, current);
  }
  const currencyList = [...byCurrency].map(([currency, value]) => ({ currency, ...value }))
    .sort((a, b) => (b.home ?? -1) - (a.home ?? -1) || a.currency.localeCompare(b.currency));
  const currencyPercents = percents(currencyList.map((item) => Math.max(0, item.home ?? 0)));

  return {
    rows, priced, excluded: rows.length - priced.length, total,
    estimated: priced.some((row) => row.estimated),
    granularity: grain,
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    categories: categoryList.map((item, index) => ({ ...item, percent: categoryPercents[index] })),
    people,
    currencies: currencyList.map((item, index) => ({ ...item, percent: currencyPercents[index] })),
  };
}

/** Rows behind one chart segment, for the drill-down table. */
export type Drill =
  | { kind: "bucket"; key: string }
  | { kind: "category"; id: string }
  | { kind: "person"; memberID: string }
  | { kind: "currency"; currency: string };

export function drillRows(analytics: Analytics, drill: Drill | null) {
  if (!drill) return analytics.rows;
  switch (drill.kind) {
    case "bucket": return analytics.priced.filter((row) => bucketKey(row.day, analytics.granularity) === drill.key);
    case "category": return analytics.priced.filter((row) => row.category === drill.id);
    case "currency": return analytics.rows.filter((row) => row.entry.currency === drill.currency);
    case "person": return analytics.priced.filter((row) =>
      portion(entryPayers(row.home!), drill.memberID) > 0 || portion(row.home!.splits, drill.memberID) > 0);
  }
}
