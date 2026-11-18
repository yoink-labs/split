import { describe, expect, it } from 'vitest';
import { convert, decodeQuote, FxCache, inverse, quoteURL, rateE8, rateText, sourceLabel, type Fetcher } from '../src/fx';

function memory() {
  const map = new Map<string, string>();
  return { get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) };
}
function fetcher(responses: Record<string, unknown>, log: string[] = []): Fetcher {
  return async (url) => {
    log.push(url);
    const key = Object.keys(responses).find(k => url.includes(k));
    if (!key || responses[key] === 'offline') throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => responses[key] };
  };
}

describe('conversion math', () => {
  it('converts integer cents with E8 rates, half away from zero', () => {
    expect(convert(1200, 120_000_000_000)).toBe(1_440_000); // USD 12.00 at 1,200 → ARS 14,400.00
    expect(convert(101, 103_950_000_000)).toBe(104_990);
    expect(convert(1, 50_000_000)).toBe(1); // 0.5 cent rounds up
    expect(convert(-1, 50_000_000)).toBe(-1); // and away from zero for negatives
    expect(convert(3, 16_666_667)).toBe(1); // 0.5000001
    expect(convert(-2614596, 64_433)).toBe(-1685);
    expect(convert(100_000_000_000, 1_000_000_000_000)).toBe(1_000_000_000_000_000);
    expect(() => convert(100_000_000_000, 1_000_000_000_000_000)).toThrow('too large'); // no float overflow or drift
    expect(() => convert(1, 0)).toThrow();
  });
  it('parses decimal rates without floating point and formats them', () => {
    expect(rateE8('1200')).toBe(120_000_000_000);
    expect(rateE8('1,552.0'.replace(',', ''))).toBe(155_200_000_000);
    expect(rateE8('0.00064433')).toBe(64_433);
    expect(rateE8('0.000000005')).toBe(1); // half up at the eighth place
    expect(rateE8(0.90344)).toBe(90_344_000);
    expect(rateE8(6.4e-7)).toBe(64);
    expect(rateE8('0')).toBeNull();
    expect(rateE8('-1')).toBeNull();
    expect(rateE8('abc')).toBeNull();
    expect(inverse(120_000_000_000)).toBe(83_333);
    expect(rateText(120_000_000_000)).toBe('1,200');
    expect(rateText(90_344_000)).toBe('0.90344');
    expect(rateText(110_730_000)).toBe('1.1073');
    expect(rateText(64_433)).toBe('0.000644');
    expect(sourceLabel({ source: 'Frankfurter', date: '2026-11-18' })).toBe('Frankfurter · ECB, Nov 18');
    expect(sourceLabel({ source: 'BCRA', date: '2026-11-13' })).toBe('BCRA official, Nov 13');
  });
  it('uses BCRA for ARS and ECB otherwise', () => {
    expect(quoteURL('USD', 'ARS', '2026-11-15')).toBe('https://api.frankfurter.dev/v2/rate/USD/ARS?date=2026-11-15&providers=bcra');
    expect(quoteURL('EUR', 'GBP')).toBe('https://api.frankfurter.dev/v2/rate/EUR/GBP?providers=ecb');
  });
});

describe('dates and caching', () => {
  it('accepts the previous business day for a weekend and rejects later or mismatched quotes', () => {
    const friday = { date: '2026-11-13', base: 'USD', quote: 'ARS', rate: 1543.5 };
    expect(decodeQuote(friday, 'USD', 'ARS', '2026-11-15', 0)).toMatchObject({ date: '2026-11-13', rateE8: 154_350_000_000, source: 'BCRA' });
    expect(decodeQuote({ ...friday, date: '2026-11-16' }, 'USD', 'ARS', '2026-11-15', 0)).toBeNull();
    expect(decodeQuote({ ...friday, quote: 'EUR' }, 'USD', 'ARS', '2026-11-15', 0)).toBeNull();
    expect(decodeQuote({ status: 404, message: 'not found' }, 'USD', 'ARS', undefined, 0)).toBeNull();
  });
  it('fetches the dated rate for a past expense and falls back to an older cached rate offline', async () => {
    let now = Date.parse('2026-11-18T12:00:00Z');
    const log: string[] = [];
    const responses: Record<string, unknown> = {
      'USD/ARS?date=2026-11-15': { date: '2026-11-13', base: 'USD', quote: 'ARS', rate: 1543.5 },
      'USD/ARS?providers': { date: '2026-11-17', base: 'USD', quote: 'ARS', rate: 1552 },
    };
    const cache = new FxCache(memory(), () => now, fetcher(responses, log));
    expect((await cache.forDate('USD', 'ARS', '2026-11-15', '2026-11-18')).date).toBe('2026-11-13');
    expect((await cache.forDate('USD', 'ARS', '2026-11-18', '2026-11-18')).rateE8).toBe(155_200_000_000);
    responses['USD/ARS?date=2026-11-17'] = 'offline';
    expect((await cache.forDate('USD', 'ARS', '2026-11-17', '2026-11-18')).date).toBe('2026-11-17');
    expect(cache.offline).toBe(true);
    await expect(cache.forDate('USD', 'ARS', '2026-11-10', '2026-11-18')).rejects.toThrow('Enter your own rate');
  });
  it('reuses fresh rates for six hours, persists them, and serves cached rates offline', async () => {
    let now = 1_000_000;
    const store = memory(), log: string[] = [];
    const responses: Record<string, unknown> = { 'EUR/USD': { date: '2026-11-18', base: 'EUR', quote: 'USD', rate: 1.1073 } };
    const cache = new FxCache(store, () => now, fetcher(responses, log));
    await cache.latest('EUR', 'USD');
    await cache.latest('EUR', 'USD');
    expect(log).toHaveLength(1);
    now += 7 * 3600 * 1000;
    responses['EUR/USD'] = 'offline';
    const stale = await cache.latest('EUR', 'USD');
    expect(log).toHaveLength(2);
    expect(stale?.rateE8).toBe(110_730_000);
    expect(cache.offline).toBe(true);
    const reloaded = new FxCache(store, () => now, fetcher({}));
    expect(reloaded.rate('EUR', 'USD')?.rateE8).toBe(110_730_000);
    expect(reloaded.rate('USD', 'EUR')?.rateE8).toBe(inverse(110_730_000));
  });
  it('prefers your own rate (ARS blue) and totals mixed currencies', async () => {
    const cache = new FxCache(memory(), () => 0, fetcher({ 'USD/ARS': { date: '2026-11-17', base: 'USD', quote: 'ARS', rate: 1552 } }));
    await cache.latest('USD', 'ARS');
    expect(cache.total({ ARS: 1_552_000, USD: -500 }, 'ARS')).toMatchObject({ amount: 776_000, missing: [] });
    cache.setManual('USD', 'ARS', rateE8('1630'));
    expect(cache.rate('USD', 'ARS')).toMatchObject({ source: 'Manual', rateE8: 163_000_000_000 });
    expect(cache.rate('ARS', 'USD')?.source).toBe('Manual');
    expect(cache.total({ USD: 100, EUR: 100 }, 'ARS')).toMatchObject({ amount: 163_000, missing: ['EUR'] });
    cache.setManual('USD', 'ARS', null);
    expect(cache.rate('USD', 'ARS')?.source).toBe('BCRA');
  });
});
