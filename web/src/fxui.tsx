// Currency selection, the composer rate line, and the standalone converter.
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
          <small>Saved with this expense. Use it for the blue or card rate.</small>
        </label>
      ) : error ? (
        <p className="error">{error}</p>
      ) : !quote ? (
        <small>Looking up the {from}→{to} rate…</small>
      ) : null}
      {exchange && (
        <p className="rate-line">
          {converted !== null && <b>≈ {money(converted, to)}</b>}
          <span>
            at 1 {from} = {rateText(exchange.rateE8)} {to}{" "}
            <small>
              ({exchange.source === "Manual" ? "your rate" : sourceLabel(exchange)}
              {fx.offline && exchange.source !== "Manual" ? ", saved rate" : ""})
            </small>
          </span>
        </p>
      )}
      <small>Split keeps the original {from} amount and freezes this rate. Conversion is free.</small>
      <ConverterDialog open={converter} onClose={() => setConverter(false)} from={from} to={to} amount={amount} />
    </section>
  );
}

/** Reference-rate lookup shared by the Account page and expense form. */
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
  const [from, setFrom] = useState(initialFrom ?? ((initialTo ?? home) === "USD" ? "ARS" : "USD"));
  const [text, setText] = useState(initialAmount != null ? (initialAmount / 100).toFixed(2) : "100");
  const [historical, setHistorical] = useState(false);
  const [date, setDate] = useState(today);
  const [revision, setRevision] = useState(0);
  const forceNextLookup = useRef(false);
  const [lookup, setLookup] = useState<{ key: string; quote: Quote | null; saved: boolean }>();
  const [own, setOwn] = useState("");
  const [editing, setEditing] = useState(false);
  useFxVersion();

  const currentDay = today();
  const selectedDay = historical ? date : "";
  const validDate = !historical || (/^\d{4}-\d\d-\d\d$/.test(date) && date <= currentDay);
  const key = [from, to, historical, selectedDay, revision].join("|");
  useEffect(() => {
    if (from === to || !validDate) return;
    let active = true;
    const force = forceNextLookup.current;
    forceNextLookup.current = false;
    async function load() {
      let quote: Quote | null = null;
      let saved = false;
      try {
        if (selectedDay && selectedDay < currentDay) {
          quote = await fx.forDate(from, to, selectedDay, currentDay);
          saved = fx.published(from, to, selectedDay) === null;
        } else {
          quote = await fx.latest(from, to, force);
          saved = fx.offline;
        }
      } catch {
        // The UI offers retry and a custom rate when no quote is available.
      }
      if (active) setLookup({ key, quote, saved });
    }
    void load();
    return () => { active = false; };
  }, [key, from, to, validDate, selectedDay, currentDay, revision]);

  const pending = from !== to && validDate && lookup?.key !== key;
  const current = lookup?.key === key ? lookup : undefined;
  const latest = !historical && from !== to ? fx.rate(from, to) : null;
  const manual = latest?.source === "Manual" ? latest : null;
  const quote = from === to ? fx.rate(from, to) : manual ?? current?.quote;
  const customRate = rateE8(own);
  let result: number | null = null;
  try {
    if (quote) result = convert(minor(text), quote.rateE8);
  } catch {
    // Blank, invalid, or unsupported amounts have no estimate.
  }

  function changePair(base: string, target: string) {
    setFrom(base);
    setTo(target);
    setEditing(false);
    setOwn("");
  }

  return (
    <div className="converter">
      <div className="card card-pad converter-amount">
        <div className="converter-pair">
          <CurrencySelect label="From" value={from} onChange={(code) => changePair(code, to)} />
          <button type="button" className="btn converter-swap" aria-label="Swap currencies" onClick={() => changePair(to, from)}>⇄</button>
          <CurrencySelect label="To" value={to} onChange={(code) => changePair(from, code)} />
        </div>
        <label className="field">
          Amount in {from}
          <input type="text" inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="converter-result" aria-live="polite">
          <span>{from === to ? `Amount in ${to}` : `Estimated amount in ${to}`}</span>
          <output className="num">{result === null ? "—" : (from === to ? "" : "≈ ") + money(result, to)}</output>
        </div>
      </div>
      {from !== to && (
        <section className="card card-pad converter-rate" aria-label="Exchange rate">
          <div className="converter-rate-head">
            <h2>Exchange rate</h2>
            <div className="seg" role="group" aria-label="Rate date">
              <button type="button" aria-pressed={!historical} onClick={() => setHistorical(false)}>Latest</button>
              <button type="button" aria-pressed={historical} onClick={() => setHistorical(true)}>By date</button>
            </div>
          </div>
          {historical && (
            <label className="field">
              Rate date
              <input type="date" max={currentDay} value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
          )}
          <div className="converter-quote" aria-live="polite">
            {quote ? (
              <>
                <strong className="num">1 {from} = {rateText(quote.rateE8)} {to}</strong>
                {manual ? <p className="muted">Your rate · saved on this device</p> : (
                  <>
                    <dl className="converter-details">
                      <dt>Source</dt><dd>{quote.source === "BCRA" ? "BCRA via Frankfurter" : "ECB via Frankfurter"}</dd>
                      <dt>Published</dt>
                      <dd><time dateTime={quote.date}>{new Date(quote.date + "T00:00:00").toLocaleDateString(undefined, { dateStyle: "medium" })}</time></dd>
                    </dl>
                    {current?.saved ? (
                      <p className="muted">Showing a saved quote. The service couldn’t be reached.</p>
                    ) : historical && quote.date !== selectedDay ? (
                      <p className="muted">Showing the last published rate before the selected date.</p>
                    ) : null}
                  </>
                )}
              </>
            ) : <p className="muted">{!validDate ? "Choose today or an earlier date." : pending ? "Getting the exchange rate…" : "No published rate was available for this lookup."}</p>}
          </div>
          {!manual && (!historical || (validDate && !pending && !quote)) && (
            <button type="button" className="btn btn-sm" disabled={pending} onClick={() => {
              forceNextLookup.current = !historical;
              setRevision((value) => value + 1);
            }}>
              {historical ? "Retry lookup" : "Refresh rate"}
            </button>
          )}
          <p className="muted">Reference rates are estimates. Your card or bank may charge a different rate or fees.</p>
        </section>
      )}
      {from !== to && !historical && (
        <details className="card card-pad converter-manual" open={editing} onToggle={(event) => {
          const open = event.currentTarget.open;
          if (open && !editing) setOwn(manual ? (manual.rateE8 / 100_000_000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "");
          setEditing(open);
        }}>
          <summary>{manual ? "Edit your rate" : "Enter your own rate"}</summary>
          <label className="field">
            How many {to} for 1 {from}?
            <input type="text" inputMode="decimal" value={own} onChange={(event) => setOwn(event.target.value)} />
          </label>
          <p className="muted">Used for balance estimates on this device. Saved expenses keep their original rates.</p>
          <div className="converter-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={customRate === null} onClick={() => {
              fx.setManual(from, to, customRate);
              setEditing(false);
            }}>Save rate</button>
            {manual && <button type="button" className="btn btn-sm" onClick={() => {
              fx.setManual(from, to, null);
              setEditing(false);
              setRevision((value) => value + 1);
            }}>Use published rate</button>}
          </div>
        </details>
      )}
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
    <div className="converter-page">
      <div className="page-head"><h1 className="page-title">Currency converter</h1></div>
      <Converter />
    </div>
  );
}
