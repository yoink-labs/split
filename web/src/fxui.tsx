// Currency conversion UI: the "Show in" picker, approximate totals, the composer
// rate line and the standalone converter. All rates are free (Frankfurter, BCRA).
import { useEffect, useRef, useState } from "react";
import { currencies, minor, money } from "./data";
import {
  convert,
  fx,
  rateE8,
  rateText,
  sourceLabel,
  today,
  useFxVersion,
  useHomeCurrency,
  useRates,
  type Exchange,
  type Quote,
} from "./fx";

export function CurrencySelect({
  label,
  value,
  onChange,
  name,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
  name?: string;
}) {
  return (
    <label className="show-in">
      {label}
      <select name={name} value={value} onChange={(e) => onChange(e.target.value)}>
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </label>
  );
}

/** "Show in" defaults to the home currency set under You. */
export function useShowIn(): [string, (c: string) => void] {
  const [home] = useHomeCurrency();
  const [chosen, setChosen] = useState<string | null>(null);
  return [chosen ?? home, setChosen];
}

function rateNote(quotes: Quote[]) {
  const unique = [...new Map(quotes.map((q) => [q.source + q.date, q])).values()];
  const label = unique.map(sourceLabel).join(" · ");
  const old = quotes.some((q) => q.fetchedAt && Date.now() - q.fetchedAt > 24 * 3600 * 1000);
  return (old || fx.offline ? "Saved rates · " : "") + label;
}

/** "≈ USD 123.45" for a set of per-currency amounts, clearly approximate. */
export function Approx({
  amounts,
  target,
  signed = false,
  prefix = "≈",
  className = "approx",
}: {
  amounts: Record<string, number>;
  target: string;
  signed?: boolean;
  prefix?: string;
  className?: string;
}) {
  const codes = Object.keys(amounts).filter((c) => amounts[c]);
  useRates(codes, target);
  if (!codes.length || (codes.length === 1 && codes[0] === target)) return null;
  const { amount, missing, quotes } = fx.total(amounts, target);
  if (missing.length === codes.length)
    return <small className={className}>Rates unavailable offline</small>;
  return (
    <p className={className}>
      <b>
        {prefix} {signed && amount ? (amount > 0 ? "+" : "−") : ""}
        {money(signed ? Math.abs(amount) : amount, target)}
      </b>
      <small>
        Approximate, at today’s rate · {rateNote(quotes)}
        {missing.length ? ` · ${missing.join(", ")} not included` : ""}
      </small>
    </p>
  );
}

/**
 * The composer and settle-up rate line. Fetches the rate for the date, shows
 * "≈ ARS 14,400.00 at 1 USD = 1,200 ARS (Frankfurter · ECB, Nov 18)", and lets
 * people type their own rate (for example the ARS blue rate).
 */
export function RateField({
  from,
  to,
  amount,
  date,
  onChange,
}: {
  from: string;
  to: string;
  amount: number | null;
  date: string;
  onChange: (x: Exchange | null) => void;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [converter, setConverter] = useState(false);
  useEffect(() => {
    let live = true;
    setQuote(null);
    setError("");
    setEditing(false);
    const own = fx.manual(from, to);
    if (own) {
      setText(rateText(own).replace(/,/g, ""));
      setEditing(true);
    }
    fx.forDate(from, to, date, today()).then(
      (q) => live && setQuote(q),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [from, to, date]);
  const manual = editing ? rateE8(text) : null;
  const exchange: Exchange | null = editing
    ? manual
      ? { target: to, rateE8: manual, date, source: "Manual" }
      : null
    : quote
      ? { target: to, rateE8: quote.rateE8, date: quote.date, source: quote.source }
      : null;
  const key = exchange ? JSON.stringify(exchange) : "";
  const last = useRef("");
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    onChange(exchange);
  });
  const converted = exchange && amount ? convert(amount, exchange.rateE8) : null;
  return (
    <section className="rate" aria-live="polite">
      <div className="rate-head">
        <strong>Settles in {to}</strong>
        <span className="rate-actions">
          <button type="button" className="link" onClick={() => setConverter(true)}>
            Converter
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              if (!editing && quote) setText(rateText(quote.rateE8).replace(/,/g, ""));
              setEditing(!editing);
            }}
          >
            {editing ? "Use published rate" : "Edit rate"}
          </button>
        </span>
      </div>
      {editing ? (
        <label>
          1 {from} in {to}
          <input
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="1200"
            aria-invalid={!!text && !manual}
          />
          <small>Your rate is saved with this entry. Use it for the ARS blue rate.</small>
        </label>
      ) : error ? (
        <p className="error">{error}</p>
      ) : !quote ? (
        <small>Looking up the {from}→{to} rate…</small>
      ) : null}
      {exchange && (
        <p className="rate-line">
          {converted !== null ? <b>≈ {money(converted, to)}</b> : null}{" "}
          at 1 {from} = {rateText(exchange.rateE8)} {to}{" "}
          <small>
            ({sourceLabel(exchange)}
            {fx.offline && exchange.source !== "Manual" ? ", saved rate" : ""})
          </small>
        </p>
      )}
      <small>Split keeps the original {from} amount and freezes this rate. Conversion is free.</small>
      <ConverterDialog open={converter} onClose={() => setConverter(false)} from={from} to={to} amount={amount} />
    </section>
  );
}

/** A small standalone converter. */
export function Converter({
  from: initialFrom,
  to: initialTo,
  amount: initialAmount,
}: {
  from?: string;
  to?: string;
  amount?: number | null;
}) {
  const [home] = useHomeCurrency();
  const [to, setTo] = useState(initialTo ?? home);
  const [from, setFrom] = useState(
    initialFrom ?? (home !== (initialTo ?? home) ? home : (initialTo ?? home) === "USD" ? "ARS" : "USD"),
  );
  const [text, setText] = useState(initialAmount ? (initialAmount / 100).toFixed(2) : "100");
  const [own, setOwn] = useState("");
  useFxVersion();
  useEffect(() => {
    if (from !== to) void fx.latest(from, to);
    const m = fx.manual(from, to);
    setOwn(m ? rateText(m).replace(/,/g, "") : "");
  }, [from, to]);
  let parsed: number | null = null;
  try {
    parsed = minor(text);
  } catch {
    parsed = null;
  }
  const q = fx.rate(from, to);
  const result = q && parsed !== null ? convert(parsed, q.rateE8) : null;
  return (
    <div className="converter">
      <div className="columns">
        <label>
          Amount
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <CurrencySelect label="From" value={from} onChange={setFrom} />
      </div>
      <button
        type="button"
        className="secondary swap"
        aria-label="Swap currencies"
        onClick={() => {
          setFrom(to);
          setTo(from);
        }}
      >
        ⇅ Swap
      </button>
      <CurrencySelect label="To" value={to} onChange={setTo} />
      <div className="summary">
        <small>{from === to ? "Same currency" : "Converted"}</small>
        <h2>{result !== null ? money(result, to) : "—"}</h2>
        {q && from !== to ? (
          <small>
            1 {from} = {rateText(q.rateE8)} {to} · {sourceLabel(q)}
            {fx.offline && q.source !== "Manual" ? " · saved rate" : ""}
          </small>
        ) : from !== to ? (
          <small>Looking up the rate…</small>
        ) : null}
      </div>
      {from !== to && (
        <label>
          Your rate (optional, for example the ARS blue rate)
          <input
            inputMode="decimal"
            value={own}
            placeholder={q && q.source !== "Manual" ? rateText(q.rateE8).replace(/,/g, "") : ""}
            onChange={(e) => {
              setOwn(e.target.value);
              fx.setManual(from, to, e.target.value.trim() ? rateE8(e.target.value) : null);
            }}
          />
          <small>Leave empty to use the published rate. Your rate stays on this device.</small>
        </label>
      )}
      <small>Free: ECB reference rates via Frankfurter, BCRA official rates for ARS.</small>
    </div>
  );
}

export function ConverterDialog({
  open,
  onClose,
  from,
  to,
  amount,
}: {
  open: boolean;
  onClose: () => void;
  from?: string;
  to?: string;
  amount?: number | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-label="Currency converter">
      {open && (
        <>
          <div className="titlebar">
            <h2>Currency converter</h2>
            <button type="button" className="icon" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <Converter from={from} to={to} amount={amount} />
        </>
      )}
    </dialog>
  );
}

export function ConverterScreen() {
  return (
    <>
      <h1>Currency converter</h1>
      <section className="panel">
        <Converter />
      </section>
    </>
  );
}
