import { useEffect, useRef, useState } from "react";
import { Picker } from "./picker";
import { currencies, dateText, money } from "./data";
import {
  convert, fx, impliedRate, isPublishedSource, rateE8, rateInput, rateText, sourceLabel, today, useFxVersion,
  useHomeCurrency, type Exchange, type Quote,
} from "./fx";

const currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });
const currencyLabel = (code: string) => `${code} · ${currencyNames.of(code)}`;
const validDay = (day: string) => /^\d{4}-\d\d-\d\d$/.test(day) && day <= today();
const quoteLabel = (quote: Quote) => [
  sourceLabel({ ...quote, date: "" }),
  dateText(quote.date + "T12:00:00"),
  quote.fallback ? "latest available" : "",
  quote.saved ? "saved quote" : "",
].filter(Boolean).join(" · ");

export function CurrencySelect({
  label, value, onChange, name, exclude, searchable,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
  name?: string;
  exclude?: string;
  searchable?: boolean;
}) {
  if (searchable) {
    const options = [value, ...currencies.filter((code) => code !== value && code !== exclude)]
      .map((code) => ({ value: code, label: currencyLabel(code) }));
    return (
      <div className="field">
        <span>{label}</span>
        <Picker label={label} value={value} onChange={onChange} search options={options} />
        {name && <input type="hidden" name={name} value={value} />}
      </div>
    );
  }
  return (
    <label className="field">
      {label}
      <select name={name} value={value} onChange={(e) => onChange(e.target.value)}>
        {currencies.filter((code) => code !== exclude).map((code) => (
          <option key={code} value={code}>{currencyLabel(code)}</option>
        ))}
      </select>
    </label>
  );
}

function useReferenceRate(from: string, to: string, day: string) {
  const [revision, setRevision] = useState(0);
  const [lookup, setLookup] = useState<{ key: string; quote: Quote | null }>();
  const key = `${from}|${to}|${day}|${revision}`;
  const enabled = from !== to && validDay(day);
  const retry = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const force = retry.current;
    retry.current = false;
    fx.forDate(from, to, day, today(), force).then(
      (quote) => { if (active) setLookup({ key, quote }); },
      () => { if (active) setLookup({ key, quote: null }); },
    );
    return () => { active = false; };
  }, [key, enabled, from, to, day]);
  return {
    quote: lookup?.key === key ? lookup.quote : null,
    loading: enabled && lookup?.key !== key,
    refresh() {
      retry.current = true;
      setRevision((value) => value + 1);
    },
  };
}

type RateMode = "saved" | "trip" | "published" | "manual" | "statement";

export function RateField({
  from, to, amount, date, saved, tripRate, onChange,
}: {
  from: string;
  to: string;
  amount: number | null;
  date: string;
  saved?: Exchange;
  tripRate?: number;
  onChange: (x: Exchange | null) => void;
}) {
  const [choice, setMode] = useState<RateMode>(saved ? "saved" : tripRate ? "trip" : "published");
  const mode = choice === "trip" && !tripRate ? "published" : choice;
  const [text, setText] = useState("");
  const [charged, setCharged] = useState(saved?.statementAmount ? (saved.statementAmount / 100).toFixed(2) : "");
  const [converter, setConverter] = useState(false);
  const { quote, loading, refresh } = useReferenceRate(from, to, date);
  let exchange: Exchange | null = null;
  const manual = rateE8(text);
  const statementAmount = parseAmount(charged, 2);
  const chargedRate = amount && statementAmount ? impliedRate(amount, statementAmount) : null;
  if (mode === "saved" && saved) {
    exchange = saved.source === "Statement"
      ? (chargedRate ? { ...saved, rateE8: chargedRate } : { ...saved, source: "Manual" })
      : saved;
  }
  if (mode === "trip" && tripRate) exchange = { target: to, rateE8: tripRate, date, source: "Trip" };
  if (mode === "published" && quote) exchange = { target: to, rateE8: quote.rateE8, date: quote.date, source: quote.source };
  if (mode === "manual" && manual) exchange = { target: to, rateE8: manual, date, source: "Manual" };
  if ((mode === "statement" || (mode === "published" && !quote)) && chargedRate && statementAmount)
    exchange = { target: to, rateE8: chargedRate, date, source: "Statement", statementAmount };
  if (exchange && mode !== "statement")
    exchange = { ...exchange, statementAmount: statementAmount ?? undefined };
  if (charged.trim() && !statementAmount) exchange = null;
  let converted: number | null = null;
  try {
    if (exchange && amount) {
      converted = exchange.statementAmount ?? convert(amount, exchange.rateE8);
      if (converted < (isPublishedSource(exchange.source) ? 0 : 1) || converted > 100_000_000_000) throw new Error();
    }
  } catch {
    converted = null;
    exchange = null;
  }
  const key = exchange ? JSON.stringify(exchange) : "";
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    onChange(exchange);
  });
  return (
    <section className="rate">
      <div className="rate-head">
        <strong>Settles in {to}</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConverter(true)}>Open converter</button>
      </div>
      <label className="field">
        Exchange rate
        <select value={mode} onChange={(event) => {
          const next = event.target.value as RateMode;
          const currentRate = (exchange ?? quote)?.rateE8;
          if (next === "manual" && !text && currentRate) setText(rateInput(currentRate));
          setMode(next);
        }}>
          {saved && <option value="saved">Saved transaction rate</option>}
          {tripRate && <option value="trip">Trip rate</option>}
          <option value="published">Published rate for charge date</option>
          <option value="manual">Custom transaction rate</option>
          <option value="statement">Calculate from statement amount</option>
        </select>
      </label>
      {mode === "manual" && (
        <label className="field">
          {to} per 1 {from}
          <input type="text" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!text && !manual} />
        </label>
      )}
      <label className="field">
        Actually charged in {to} (optional)
        <input type="text" inputMode="decimal" value={charged} onChange={(e) => {
          setCharged(e.target.value);
          if (!e.target.value.trim() && (mode === "statement" || (mode === "saved" && saved?.source === "Statement"))) {
            if (tripRate) setMode("trip");
            else if (quote || !saved) setMode("published");
            else setMode("saved");
          }
        }} aria-invalid={!!charged && !statementAmount} />
        <small>The posted card total overrides the saved rate. Clear it to use the exchange rate.</small>
      </label>
      <div aria-live="polite">
        {exchange ? (
          <p className="rate-line">
            {converted !== null && <b>{exchange.statementAmount ? "" : "≈ "}{money(converted, to)}{exchange.statementAmount !== undefined && " · Charged amount override"}</b>}
            <span>1 {from} ≈ {rateText(exchange.rateE8)} {to}{" "}
              <small>({mode === "published" && quote ? quoteLabel(quote) : sourceLabel(exchange)})</small>
            </span>
          </p>
        ) : mode === "published" && !quote ? (
          <p className="muted">
            {!validDay(date) ? "Choose today or an earlier charge date." : loading ? "Looking up the published rate…" : "Published rate unavailable. Enter a custom rate or a statement amount."}
            {!loading && validDay(date) && <button type="button" className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button>}
          </p>
        ) : mode === "statement" ? (
          <small>Enter both amounts to calculate the effective rate.</small>
        ) : (
          <small>Enter a valid exchange rate and amount.</small>
        )}
        {exchange?.statementAmount !== undefined && quote && converted !== null && amount && (
          <p className="muted"><StatementComparison original={amount} charged={converted} to={to} quote={quote} fromDigits={2} toDigits={2} /></p>
        )}
      </div>
      <small>The original charge and selected rate are saved with this transaction.</small>
      <ConverterDialog open={converter} onClose={() => setConverter(false)} from={from} to={to} amount={amount} date={date} />
    </section>
  );
}

function currencyDigits(code: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
}

function parseAmount(text: string, digits: number) {
  const match = text.trim().match(/^(\d{1,12})(?:[.,](\d*))?$/);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const amount = Number(match[1]) * 10 ** digits + Number((match[2] ?? "").padEnd(digits, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function formatAmount(amount: number, digits: number) {
  const units = BigInt(amount);
  const scale = 10n ** BigInt(digits);
  const whole = (units / scale).toLocaleString();
  if (!digits) return whole;
  const decimal = new Intl.NumberFormat().formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  return whole + decimal + (units % scale).toString().padStart(digits, "0");
}

function StatementComparison({ original, charged, to, quote, fromDigits, toDigits }: {
  original: number;
  charged: number;
  to: string;
  quote: Quote;
  fromDigits: number;
  toDigits: number;
}) {
  let expected: number;
  try {
    expected = convert(original, quote.rateE8, fromDigits, toDigits);
  } catch {
    return null;
  }
  const diff = charged - expected;
  if (diff === 0) return <>Matches the published estimate ({quoteLabel(quote)}).</>;
  const formatted = formatAmount(Math.abs(diff), toDigits);
  return <>{formatted} {to} {diff > 0 ? "more" : "less"} than the published estimate ({quoteLabel(quote)}).</>;
}

export function Converter({
  from: initialFrom, to: initialTo, amount: initialAmount, date: initialDate,
}: {
  from?: string;
  to?: string;
  amount?: number | null;
  date?: string;
}) {
  const [home] = useHomeCurrency();
  const [to, setTo] = useState(initialTo ?? home);
  const [from, setFrom] = useState(initialFrom ?? ((initialTo ?? home) === "USD" ? "EUR" : "USD"));
  const [text, setText] = useState(() => {
    if (initialAmount == null) return "100";
    return String(initialAmount / 100);
  });
  const [date, setDate] = useState(() => initialDate || today());
  const [chargedText, setChargedText] = useState("");
  const [own, setOwn] = useState("");
  const [custom, setCustom] = useState(false);
  useFxVersion();

  const { quote, loading, refresh } = useReferenceRate(from, to, date);
  // An expense passes the ledger's two-decimal amount, including for zero-decimal currencies.
  const fromDigits = initialFrom === from && initialAmount != null ? Math.max(2, currencyDigits(from)) : currencyDigits(from);
  const toDigits = currencyDigits(to);
  const amount = parseAmount(text, fromDigits);
  const charged = parseAmount(chargedText, toDigits);
  const manual = from === to ? null : fx.rate(from, to);
  const saved = manual?.source === "Manual" ? manual : null;
  const appliedRate = from === to ? 100_000_000 : custom ? saved?.rateE8 : quote?.rateE8;
  const effective = amount && charged ? impliedRate(amount, charged, fromDigits, toDigits) : null;
  const customRate = rateE8(own);
  let result: number | null = null;
  try {
    if (appliedRate && amount !== null) result = convert(amount, appliedRate, fromDigits, toDigits);
  } catch {
    // Unsupported totals have no estimate.
  }

  function changePair(base: string, target: string) {
    setFrom(base);
    setTo(target);
    setOwn("");
    setChargedText("");
    setCustom(false);
  }
  function swap() {
    if (result !== null) {
      const units = BigInt(result).toString().padStart(toDigits + 1, "0");
      setText(toDigits ? units.slice(0, -toDigits) + "." + units.slice(-toDigits) : units);
    }
    changePair(to, from);
  }

  return (
    <div className="converter">
      <section className="converter-board" aria-label="Convert currency">
        <div className="converter-pair">
          <div className="converter-side">
            <CurrencySelect label="From" value={from} onChange={(code) => changePair(code, to)} />
            <label className="field">
              Amount in {from}
              <input type="text" className="converter-number num" inputMode="decimal" value={text}
                onChange={(event) => setText(event.target.value)} aria-invalid={!!text && amount === null} />
            </label>
          </div>
          <button type="button" className="btn converter-swap" aria-label="Swap currencies" onClick={swap}>⇄</button>
          <div className="converter-side converter-target">
            <CurrencySelect label="To" value={to} onChange={(code) => changePair(from, code)} />
            <div className="converter-result" aria-live="polite">
              <span>{from === to ? "Amount" : "Estimated amount"} in {to}</span>
              <output className="converter-number num">{result === null ? "—" : formatAmount(result, toDigits)}</output>
            </div>
          </div>
        </div>
        {from !== to && (
          <div className="converter-rate">
            <div className="converter-quote" aria-live="polite">
              {appliedRate && (
                <strong className="num">1 {from} ≈ {rateText(appliedRate)} {to}</strong>
              )}
              <p className="muted">
                {custom && saved ? "Custom rate"
                  : !validDay(date) ? "Choose today or an earlier charge date."
                  : loading ? "Looking up the published rate…"
                  : quote ? quoteLabel(quote) : "Published rate unavailable for this pair."}
              </p>
              {!custom && quote?.fallback && <small className="muted">The charge-date quote was unavailable.</small>}
              {!custom && !loading && validDay(date) && (!quote || date === today() || quote.fallback) && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={refresh}>{quote ? "Refresh rate" : "Retry lookup"}</button>
              )}
            </div>
            <label className="field">
              Charge date
              <input type="date" max={today()} value={date} onChange={(event) => {
                setDate(event.target.value);
                setCustom(false);
              }} />
            </label>
          </div>
        )}
      </section>
      {from !== to && (
        <div className="converter-extras">
          <section className="converter-statement">
            <h2>What did you actually pay?</h2>
            <p className="muted">Compare the estimate with the total that posted to your bank or card.</p>
            <label className="field">
              Statement amount in {to}
              <input type="text" inputMode="decimal" value={chargedText} placeholder="0"
                onChange={(event) => setChargedText(event.target.value)} aria-invalid={!!chargedText && charged === null} />
            </label>
            {effective && amount && charged && (
              <div className="converter-effective" aria-live="polite">
                <strong className="num">Effective rate ≈ {rateText(effective)} {to} per {from}</strong>
                {quote && <p className="muted"><StatementComparison original={amount} charged={charged} to={to} quote={quote} fromDigits={fromDigits} toDigits={toDigits} /></p>}
              </div>
            )}
          </section>
          <details className="converter-manual" key={from + to} onToggle={(event) => {
            if (event.currentTarget.open && !own && saved) setOwn(rateInput(saved.rateE8));
          }}>
            <summary>Custom rate</summary>
            <label className="field">
              {to} per 1 {from}
              <input type="text" inputMode="decimal" value={own} onChange={(event) => setOwn(event.target.value)} />
            </label>
            <p className="muted">Saved on this device. Set trip and transaction rates in the trip workspace.</p>
            <div className="converter-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={!customRate} onClick={() => {
                fx.setManual(from, to, customRate);
                setCustom(true);
              }}>Use custom rate</button>
              {custom && <button type="button" className="btn btn-sm" onClick={() => setCustom(false)}>Use published rate</button>}
              {saved && <button type="button" className="btn btn-sm" onClick={() => {
                fx.setManual(from, to, null);
                setOwn("");
                setCustom(false);
              }}>Remove saved rate</button>}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

export function ConverterDialog({
  open, onClose, from, to, amount, date,
}: {
  open: boolean;
  onClose: () => void;
  from?: string;
  to?: string;
  amount?: number | null;
  date?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="converter-dialog"
      onClose={onClose}
      aria-label="Currency converter"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text")
          event.preventDefault();
      }}
    >
      {open && (
        <>
          <div className="converter-titlebar">
            <h2>Currency converter</h2>
            <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" onClick={onClose}>×</button>
          </div>
          <Converter from={from} to={to} amount={amount} date={date} />
        </>
      )}
    </dialog>
  );
}

export function ConverterScreen() {
  return (
    <div className="converter-page">
      <div className="page-head"><h1 className="page-title">Currency converter</h1></div>
      <Converter />
    </div>
  );
}
