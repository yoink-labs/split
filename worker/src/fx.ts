// Free currency conversion shared by the web client and its tests. Amounts are integer minor
// units and rates are E8 fixed point (1 USD = 1,200 ARS is 120_000_000_000). No floating point
// touches an amount. Frankfurter v2 supplies reference rates.

export const SCALE = 100_000_000n;
export const FRESH_MS = 6 * 3600 * 1000;
export type Source = 'Frankfurter' | 'Frankfurter blended' | 'BCRA' | 'Manual' | 'Trip' | 'Statement';
export interface Quote { base: string; quote: string; rateE8: number; date: string; source: Source; fetchedAt: number; fallback?: boolean; saved?: boolean }
export interface Exchange { target: string; rateE8: number; date: string; source: Source; statementAmount?: number }

export function isPublishedSource(source: Source) {
  return source === 'Frankfurter' || source === 'Frankfurter blended' || source === 'BCRA';
}

/** minor × rateE8 / 1e8, rounded half away from zero. BigInt, so large amounts never lose a cent. */
export function convert(minor: number, rateE8: number, fromDigits = 2, toDigits = 2): number {
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(rateE8) || rateE8 <= 0) throw new Error('Invalid conversion.');
  const negative = minor < 0;
  const product = BigInt(Math.abs(minor)) * BigInt(rateE8) * 10n ** BigInt(toDigits);
  const divisor = SCALE * 10n ** BigInt(fromDigits);
  const value = (product + divisor / 2n) / divisor;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converted amount is too large.');
  return negative ? -Number(value) : Number(value);
}

/** The rate implied by the original total and the amount that posted. */
export function impliedRate(original: number, charged: number, fromDigits = 2, toDigits = 2): number | null {
  if (!Number.isSafeInteger(original) || original <= 0 || !Number.isSafeInteger(charged) || charged <= 0) return null;
  const divisor = BigInt(original) * 10n ** BigInt(toDigits);
  const value = (BigInt(charged) * SCALE * 10n ** BigInt(fromDigits) + divisor / 2n) / divisor;
  return value >= 1n && value <= 10_000_000n * SCALE ? Number(value) : null;
}

/** A decimal rate ("1200", "0.00064433", 1552) to E8 units, rounded half up at the eighth place. */
export function rateE8(input: string | number): number | null {
  let text = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input.trim().replace(',', '.');
  if (/e/i.test(text)) { const n = Number(text); text = Number.isFinite(n) && n > 0 ? n.toFixed(12) : ''; }
  const m = text.match(/^(\d{1,8})(?:\.(\d+))?$/);
  if (!m) return null;
  const digits = (m[2] ?? '').padEnd(9, '0');
  let units = BigInt(m[1]) * SCALE + BigInt(digits.slice(0, 8));
  if (Number(digits[8]) >= 5) units += 1n;
  if (units <= 0n || units > 10_000_000n * SCALE) return null;
  return Number(units);
}

/** The rate for the opposite direction, 1e16 / rateE8, rounded half up. */
export function inverse(rate: number): number | null {
  if (!Number.isSafeInteger(rate) || rate <= 0) return null;
  const value = (10n ** 16n + BigInt(rate) / 2n) / BigInt(rate);
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** "1,200", "0.9031" or "0.000644" without floating-point drift. */
export function rateText(rate: number): string {
  const whole = BigInt(rate) / SCALE, fraction = (BigInt(rate) % SCALE).toString().padStart(8, '0');
  const places = whole >= 100n ? 2 : whole >= 1n ? 4 : Math.max(6, fraction.search(/[1-9]/) + 3);
  const shown = fraction.slice(0, places).replace(/0+$/, '');
  return whole.toLocaleString('en-US') + (shown ? '.' + shown : '');
}

const ecbCurrencies = new Set('AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR'.split(' '));
export function sourceFor(base: string, quote: string): Source {
  if (base === 'ARS' || quote === 'ARS') return 'BCRA';
  return ecbCurrencies.has(base) && ecbCurrencies.has(quote) ? 'Frankfurter' : 'Frankfurter blended';
}
export function quoteURL(base: string, quote: string, date?: string, source = sourceFor(base, quote)) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (source === 'BCRA') params.set('providers', 'bcra');
  if (source === 'Frankfurter') params.set('providers', 'ecb');
  const query = params.toString();
  return `https://api.frankfurter.dev/v2/rate/${base}/${quote}${query ? '?' + query : ''}`;
}

/** "Nov 18" from "2026-11-18". */
export function shortDay(day: string) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = day.match(/^\d{4}-(\d\d)-(\d\d)$/);
  return m ? `${months[Number(m[1]) - 1]} ${Number(m[2])}` : day;
}
export function sourceLabel(q: Pick<Quote, 'source' | 'date'>) {
  const names: Record<Source, string> = {
    Frankfurter: 'Frankfurter · ECB', 'Frankfurter blended': 'Frankfurter', BCRA: 'BCRA official',
    Manual: 'Your rate', Trip: 'Trip rate', Statement: 'From statement amount',
  };
  const name = names[q.source];
  return q.date ? `${name}, ${shortDay(q.date)}` : name;
}

/**
 * Validates a Frankfurter v2 `/rate/{base}/{quote}` body. A weekend or holiday request returns the
 * previous business day, so any published date on or before the requested one is accepted.
 */
export function decodeQuote(body: unknown, base: string, quote: string, requested: string | undefined, now: number, source = sourceFor(base, quote)): Quote | null {
  const b = body as { base?: unknown; quote?: unknown; date?: unknown; rate?: unknown } | null;
  if (!b || b.base !== base || b.quote !== quote || typeof b.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(b.date)) return null;
  if (requested && b.date > requested) return null;
  const units = typeof b.rate === 'number' || typeof b.rate === 'string' ? rateE8(b.rate) : null;
  return units ? { base, quote, rateE8: units, date: b.date, source, fetchedAt: now } : null;
}

export interface KeyValue { get(key: string): string | null; set(key: string, value: string): void }
export type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
interface Stored { quotes: Record<string, Quote>; manual: Record<string, number> }
const KEY = 'split-fx-v1';
const pair = (base: string, quote: string) => base + '>' + quote;

/** Last known rates with timestamps, manual overrides, and offline fallback. */
export class FxCache {
  private state: Stored;
  private listeners = new Set<() => void>();
  private failedHistory = new Map<string, number>();
  private inflight = new Map<string, Promise<Quote | null>>();
  offline = false;
  constructor(private storage: KeyValue, private now: () => number, private fetcher: Fetcher) {
    let state: Stored = { quotes: {}, manual: {} };
    try { const raw = storage.get(KEY); if (raw) state = { quotes: {}, manual: {}, ...JSON.parse(raw) }; } catch { /* start empty */ }
    this.state = state;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() {
    try { this.storage.set(KEY, JSON.stringify(this.state)); } catch { /* storage full or private mode */ }
    for (const l of this.listeners) l();
  }
  manual(base: string, quote: string) { return this.state.manual[pair(base, quote)]; }
  setManual(base: string, quote: string, rate: number | null) {
    delete this.state.manual[pair(quote, base)];
    if (rate) this.state.manual[pair(base, quote)] = rate; else delete this.state.manual[pair(base, quote)];
    this.changed();
  }
  cached(base: string, quote: string): Quote | undefined { return this.state.quotes[pair(base, quote)]; }
  stale(base: string, quote: string) {
    const q = this.cached(base, quote);
    return !q || this.now() - q.fetchedAt > FRESH_MS;
  }
  /** The rate to display: your rate first, then a published one in either direction. */
  rate(base: string, quote: string): Quote | null {
    if (base === quote) return { base, quote, rateE8: Number(SCALE), date: '', source: 'Manual', fetchedAt: 0 };
    const own = this.manual(base, quote), reverseOwn = this.manual(quote, base);
    if (own) return { base, quote, rateE8: own, date: '', source: 'Manual', fetchedAt: 0 };
    if (reverseOwn) { const r = inverse(reverseOwn); if (r) return { base, quote, rateE8: r, date: '', source: 'Manual', fetchedAt: 0 }; }
    return this.published(base, quote);
  }
  published(base: string, quote: string, date?: string): Quote | null {
    const suffix = date ? '@' + date : '';
    const direct = this.state.quotes[pair(base, quote) + suffix];
    if (direct) return direct;
    const reverse = this.state.quotes[pair(quote, base) + suffix], r = reverse && inverse(reverse.rateE8);
    return reverse && r ? { ...reverse, base, quote, rateE8: r } : null;
  }
  private async fetchQuote(base: string, quote: string, date?: string): Promise<Quote> {
    const source = sourceFor(base, quote);
    const sources: Source[] = source === 'Frankfurter blended' ? [source] : [source, 'Frankfurter blended'];
    for (const provider of sources) {
      const res = await this.fetcher(quoteURL(base, quote, date, provider));
      const q = res.ok ? decodeQuote(await res.json(), base, quote, date, this.now(), provider) : null;
      if (q) return q;
    }
    throw new Error('No published rate is available. Enter your own rate.');
  }
  /** Latest published rate, reusing a fresh cache entry. Falls back to the cached one offline. */
  latest(base: string, quote: string, force = false): Promise<Quote | null> {
    if (base === quote) return Promise.resolve(this.rate(base, quote));
    if (!force && !this.stale(base, quote)) return Promise.resolve(this.cached(base, quote)!);
    const k = pair(base, quote), running = this.inflight.get(k);
    if (running) return running;
    const task = this.fetchQuote(base, quote).then(q => {
      this.state.quotes[k] = q; this.offline = false; this.changed(); return q;
    }, () => { this.offline = true; this.changed(); const cached = this.published(base, quote); return cached ? { ...cached, saved: true } : null; })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, task);
    return task;
  }
  historical(base: string, quote: string, date: string, retry = false): Promise<Quote | null> {
    const cached = this.published(base, quote, date);
    if (cached) return Promise.resolve(cached);
    const key = pair(base, quote) + '@' + date;
    const failedAt = this.failedHistory.get(key);
    if (!retry && failedAt !== undefined && this.now() - failedAt < FRESH_MS) return Promise.resolve(null);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.fetchQuote(base, quote, date).then(result => {
      this.failedHistory.delete(key);
      this.state.quotes[key] = result;
      this.changed();
      return result;
    }, () => { this.failedHistory.set(key, this.now()); return null; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  /** Prefer the charge day's quote, then fall back to the latest available reference rate. */
  async forDate(base: string, quote: string, date: string, today: string, retry = false): Promise<Quote> {
    if (date < today) {
      const historic = await this.historical(base, quote, date, retry);
      if (historic) return historic;
    }
    const latest = await this.latest(base, quote, retry);
    if (latest) return date < today ? { ...latest, fallback: true } : latest;
    throw new Error('No published rate is available. Enter your own rate.');
  }
  /** Per-currency amounts summed into one currency. `missing` lists currencies without a known rate. */
  total(amounts: Record<string, number>, target: string) {
    let amount = 0; const missing: string[] = [], quotes: Quote[] = [];
    for (const [currency, value] of Object.entries(amounts).sort()) {
      if (!value) continue;
      const q = this.rate(currency, target);
      if (!q) { missing.push(currency); continue; }
      try {
        const next = amount + convert(value, q.rateE8);
        if (!Number.isSafeInteger(next)) { missing.push(currency); continue; }
        if (currency !== target) quotes.push(q);
        amount = next;
      } catch { missing.push(currency); }
    }
    return { amount, missing, quotes };
  }
}
