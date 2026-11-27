import { useEffect } from "react";
import { allocate, balances, entryPayers, moneyCompact, settlementEntry, type Expense } from "./data";
import { convert, fx, type FxCache, today, useFxVersion, useHomeCurrency, useRates } from "./fx";

function historicPair(entry: Expense) {
  return [entry.currency, entry.exchange?.date ?? entry.createdAt.slice(0, 10)] as const;
}

export function useLedgerRates(entries: Expense[], groupCurrencies: string[]) {
  const [home] = useHomeCurrency();
  useRates([...groupCurrencies, ...entries.flatMap((entry) => [entry.currency, historicPair(entry)[0]])], home);
  const date = today();
  const keys = new Set<string>();
  for (const entry of entries) {
    const [base, day] = historicPair(entry);
    if (entry.exchange?.target !== home && base !== home && /^\d{4}-\d\d-\d\d$/.test(day) && day < date) keys.add(base + "@" + day);
  }
  const schedule = [...keys].sort().reverse().join(",");
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const keys = schedule.split(",").filter(Boolean);
      for (let start = 0; start < keys.length && !cancelled; start += 4) {
        await Promise.all(keys.slice(start, start + 4).map((key) => {
          const [base, day] = key.split("@");
          return fx.historical(base, home, day);
        }));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [home, schedule]);
}

export function memberBalances(entries: Expense[], memberID: string) {
  const codes = new Set(entries.map((entry) => entry.exchange?.target ?? entry.currency));
  return Object.fromEntries([...codes].map((code) => [code, balances(entries, code)[memberID] ?? 0]));
}

function publishedRate(entry: Expense, home: string, cache: FxCache) {
  const [base, day] = historicPair(entry);
  return cache.published(base, home, day) ?? cache.published(base, home) ?? cache.rate(base, home);
}

export function projectHomeEntry(entry: Expense, home: string, cache: FxCache): Expense | null {
  if (entry.currency === home) return entry.exchange ? { ...entry, exchange: undefined } : entry;
  if (entry.exchange?.target === home) return { ...entry, ...settlementEntry(entry) };
  const quote = publishedRate(entry, home, cache);
  if (!quote) return null;
  try {
    const amount = convert(entry.amount, quote.rateE8);
    const distribute = (weights: number[]) => amount === 0 ? weights.map(() => 0) : allocate(amount, weights, Number.MAX_SAFE_INTEGER);
    const shares = distribute(entry.splits.map((split) => split.amount));
    const payers = entry.payers?.length ? distribute(entry.payers.map((payer) => payer.amount)) : undefined;
    return {
      ...entry, amount, currency: home, exchange: undefined,
      splits: entry.splits.map((split, index) => ({ ...split, amount: shares[index] })),
      payers: payers && entry.payers?.map((payer, index) => ({ ...payer, amount: payers[index] })),
    };
  } catch {
    return null;
  }
}

export function useHomeMoney() {
  const [home] = useHomeCurrency();
  useFxVersion();

  const format = (amount: number, approximate = false, signed = false) =>
    (approximate ? "≈ " : "") + (amount < 0 ? "−" : signed && amount > 0 ? "+" : "") + moneyCompact(Math.abs(amount), home);
  const project = (entry: Expense) => projectHomeEntry(entry, home, fx);
  const entry = (expense: Expense, amount = expense.amount) => {
    if (expense.currency === home || amount === 0) return format(amount);
    if (amount === expense.amount) {
      const projected = project(expense);
      return projected ? format(projected.amount, true) : "Rate unavailable";
    }
    try {
      const quote = expense.exchange?.target === home ? expense.exchange : publishedRate(expense, home, fx);
      return quote ? format(convert(amount, quote.rateE8), true) : "Rate unavailable";
    } catch {
      return "Rate unavailable";
    }
  };
  const portion = (expense: Expense, memberID: string, paid = false) => {
    const projected = project(expense);
    if (!projected) return "Rate unavailable";
    const portions = paid ? entryPayers(projected) : projected.splits;
    return format(portions.find((part) => part.memberID === memberID)?.amount ?? 0, expense.currency !== home);
  };
  const total = (amounts: Record<string, number>) => fx.total(amounts, home);
  const totalText = (amounts: Record<string, number>, signed = false) => {
    const result = total(amounts);
    return result.missing.length ? "Rate unavailable" : format(result.amount, !!result.quotes.length, signed);
  };
  const spend = (entries: Expense[]) => {
    const expenses = entries.filter((entry) => entry.kind === "expense");
    const projected = expenses.map(project);
    return projected.some((entry) => !entry)
      ? "Rate unavailable"
      : format(projected.reduce((sum, entry) => sum + (entry?.amount ?? 0), 0), expenses.some((entry) => entry.currency !== home));
  };
  return { home, format, project, entry, portion, total, totalText, spend };
}
