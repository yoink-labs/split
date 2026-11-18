// Browser wiring for free currency conversion: one shared cache in localStorage,
// the home currency, and hooks that re-render when rates arrive.
import { useEffect, useState, useSyncExternalStore } from "react";
import { FxCache, type Quote } from "../../worker/src/fx";
import { currencies } from "./data";
export * from "../../worker/src/fx";

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};
export const fx = new FxCache(storage, Date.now, (url) => fetch(url));

const supported = (c: string | null | undefined): c is string =>
  !!c && (currencies as readonly string[]).includes(c);
const REGION: Record<string, string> = {
  US: "USD", AR: "ARS", GB: "GBP", BR: "BRL", CA: "CAD", AU: "AUD", MX: "MXN",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", PT: "EUR", IE: "EUR",
  AT: "EUR", BE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", MT: "EUR", CY: "EUR", HR: "EUR",
};
function regionCurrency() {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const region = tag.split("-")[1]?.toUpperCase();
    if (region && REGION[region]) return REGION[region];
  }
  return "USD";
}
const HOME = "split-home-currency";
const homeListeners = new Set<() => void>();
export function homeCurrency() {
  const stored = storage.get(HOME);
  return supported(stored) ? stored : regionCurrency();
}
export function setHomeCurrency(code: string) {
  storage.set(HOME, code);
  for (const l of homeListeners) l();
}
export function useHomeCurrency(): [string, (c: string) => void] {
  const value = useSyncExternalStore(
    (l) => {
      homeListeners.add(l);
      return () => homeListeners.delete(l);
    },
    homeCurrency,
  );
  return [value, setHomeCurrency];
}

/** Re-renders whenever a rate, a manual rate or the offline flag changes. */
export function useFxVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => fx.subscribe(() => setVersion((v) => v + 1)), []);
  return version;
}

/** Fetches today's rate from each currency into `target` (cached for six hours). */
export function useRates(codes: string[], target: string) {
  const version = useFxVersion();
  const key = [...new Set(codes)].sort().join(",");
  useEffect(() => {
    for (const c of key.split(","))
      if (c && c !== target) void fx.latest(c, target);
  }, [key, target]);
  return version;
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export type { Quote };
