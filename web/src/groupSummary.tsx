// Printable group report with a direct PDF download in three modes. Amounts lead with the
// preferred (home) currency using the same projection as the rest of the app, with the recorded or
// settlement amounts underneath and labelled. When a rate is missing, the recorded amount leads
// instead, so the document never depends on an estimate.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { categoryMeta } from "./categories";
import { useLedger } from "./context";
import {
  allocate,
  balances,
  billConsumption,
  entryItems,
  breakdown,
  consumptionReport,
  entryPayers,
  groupTransfers,
  money,
  settlementEntry,
  tripRangeText,
  type Expense,
  type Group,
} from "./data";
import { fx, rateText, sourceLabel } from "./fx";
import { downloadReportPDF } from "./groupSummaryPDF";
import { homeRate, memberBalances, useHomeMoney } from "./homeMoney";

type Mode = "summary" | "detailed" | "receipts";
const MODES: { id: Mode; label: string; title: string }[] = [
  { id: "summary", label: "Summary", title: "Tables of expenses and recorded payments" },
  { id: "detailed", label: "Detailed ledger", title: "Every entry with who paid and each person’s share" },
  { id: "receipts", label: "Itemized receipts", title: "Each receipt item, who had it and each person’s share" },
];
const REPORT_SECTIONS = [
  { id: "totals", label: "Expense totals" },
  { id: "balances", label: "Balances and suggested payments" },
  { id: "history", label: "Transaction history" },
  { id: "consumption", label: "Consumption by person" },
] as const;
const BREAKDOWNS = [
  { id: "categories", label: "By category" },
  { id: "months", label: "By month" },
  { id: "people", label: "By person" },
] as const;
type ReportSection = (typeof REPORT_SECTIONS | typeof BREAKDOWNS)[number]["id"];

function sectionEnabled(query: URLSearchParams, mode: Mode, id: ReportSection) {
  const value = query.get(id);
  if (value === "on" || value === "off") return value === "on";
  if (id === "consumption") return mode === "receipts";
  return id === "history" || (mode !== "receipts" && (id === "totals" || id === "balances"));
}

const REPORT_TITLE: Record<Mode, string> = {
  summary: "Expense summary",
  detailed: "Detailed ledger",
  receipts: "Itemized receipts",
};

type Part = { memberID: string; amount: number };
type Format = (amount: number, approximate?: boolean, signed?: boolean) => string;
const sumBy = (parts: Part[], id: string) =>
  parts.filter((p) => p.memberID === id).reduce((s, p) => s + p.amount, 0);
const rateSource = (r: { date: string; source: string }) => sourceLabel(r as Parameters<typeof sourceLabel>[0]);
const kindLabel = (g: Group) => (g.kind === "trip" ? "Trip" : g.kind === "home" ? "Long-term group" : "Friends");

/** The ledger's recorded day (the date part of `createdAt`), never shifted by time zone. */
function recordedDay(stamp: string) {
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Exact per-currency amounts, e.g. "EUR 40.00 · USD 12.50". */
const perCurrency = (amounts: Record<string, number>, signed = false) =>
  Object.entries(amounts)
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, v]) => (v < 0 ? "−" : signed && v > 0 ? "+" : "") + money(Math.abs(v), c))
    .join(" · ");

/**
 * One money cell. `converted` is the preferred-currency figure, or null when no rate is available;
 * `recorded` is the exact amount Split stores. A missing rate makes the recorded amount lead.
 */
function Amount({ converted, recorded, label, quiet }: { converted: string | null; recorded?: string; label: string; quiet?: boolean }) {
  if (converted === null && recorded && quiet)
    return (
      <span className="sum-stack">
        <span className="sum-main">{recorded}</span>
      </span>
    );
  if (converted === null && recorded)
    return (
      <span className="sum-stack">
        {recorded.split(" · ").map((part) => (
          <span className="sum-main" key={part}>
            {part}
          </span>
        ))}
        <span className="sum-orig">
          <span className="sum-orig-label">{label}</span> · no rate
        </span>
      </span>
    );
  return (
    <span className="sum-stack">
      <span className="sum-main">{converted ?? "Rate unavailable"}</span>
      {recorded && (
        <span className="sum-orig">
          <span className="sum-orig-label">{label}</span> {recorded}
        </span>
      )}
    </span>
  );
}

function PrintIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9V3h12v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M6 14h12v7H6z" />
      <path d="M17.5 12h.01" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
    </svg>
  );
}

/** One entry's money in the preferred currency (`converted`) and as recorded (`recorded`). */
function entryMoney(e: Expense, projected: Expense | null, home: string, format: Format) {
  const foreign = e.currency !== home;
  return {
    foreign,
    converted: (amount: number) => (projected ? format(amount, foreign) : null),
    recorded: (amount: number) => (foreign ? money(amount, e.currency) : undefined),
  };
}

type Breakdown = { amount: number; items: number; tax: number; tip: number };

/**
 * Converted (preferred-currency) figures for one person's recorded parts of one expense. Their
 * converted share is allocated across the parts by largest remainder, then each part across its
 * item price, tax and tip the same way, so converted parts add up exactly to the converted share.
 * Null when the share cannot be allocated.
 */
function convertParts(parts: Breakdown[], target: number): (Breakdown | null)[] {
  // Refund lines are negative; convert their magnitudes and give the sign back.
  if (parts.length && parts.every((p) => p.amount <= 0 && p.items <= 0 && p.tax <= 0 && p.tip <= 0) && parts.some((p) => p.amount < 0)) {
    const flip = (b: Breakdown) => ({ amount: -b.amount, items: -b.items, tax: -b.tax, tip: -b.tip });
    return convertParts(parts.map(flip), Math.abs(target)).map((b) => (b ? flip(b) : null));
  }
  const spread = (total: number, weights: number[]) =>
    total === 0 || weights.every((w) => w === 0) ? weights.map(() => 0) : allocate(total, weights, Number.MAX_SAFE_INTEGER);
  try {
    const totals = spread(target, parts.map((p) => p.amount));
    return parts.map((p, index) => {
      const [items, tax, tip] = spread(totals[index], [p.items, p.tax, p.tip]);
      return { amount: totals[index], items, tax, tip };
    });
  } catch {
    return parts.map(() => null);
  }
}

/** Column sums of converted parts, or null when any part has no converted figure. */
function sumConverted(parts: (Breakdown | null | undefined)[]): Breakdown | null {
  if (parts.some((p) => !p)) return null;
  return parts.reduce<Breakdown>(
    (sum, p) => ({ amount: sum.amount + p!.amount, items: sum.items + p!.items, tax: sum.tax + p!.tax, tip: sum.tip + p!.tip }),
    { amount: 0, items: 0, tax: 0, tip: 0 },
  );
}

const PART_COLUMNS = [
  { key: "items", label: "Items" },
  { key: "tax", label: "Tax" },
  { key: "tip", label: "Tip" },
  { key: "amount", label: "Total" },
] as const;

type PersonLabel = (id: string) => ReactNode;

function peopleList(parts: Part[], person: PersonLabel) {
  return [...new Set(parts.map((p) => p.memberID))].map((id, index) => (
    <Fragment key={id}>{index > 0 && ", "}{person(id)}</Fragment>
  ));
}

export function GroupSummary() {
  const { data, user } = useLedger();
  const { gid } = useParams();
  const [query, setQuery] = useSearchParams();
  const g = data.groups.find((x) => x.id === gid);
  const homeMoney = useHomeMoney();
  const home = homeMoney.home;
  const mode: Mode = MODES.some((m) => m.id === query.get("view")) ? (query.get("view") as Mode) : "summary";
  const included = (id: ReportSection) => sectionEnabled(query, mode, id);
  const hasSections = [...REPORT_SECTIONS, ...BREAKDOWNS].some(({ id }) => included(id));
  const reportTitle = included("history") ? REPORT_TITLE[mode] : "Expense report";
  const me = g?.members.find((member) => member.userID === user && !member.removed);
  const personal = query.get("audience") === "personal" ? me : undefined;
  const audienceTitle = personal ? "Personal" : "Group";
  const title = g ? `${g.name} – ${reportTitle} – ${audienceTitle}` : undefined;
  const report = useRef<HTMLElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    // Browsers use the document title as the default "Save as PDF" file name.
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const entries = useMemo(
    () =>
      data.entries
        .filter((e) => e.groupID === gid)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [data.entries, gid],
  );

  if (!g) {
    return (
      <div className="card card-pad">
        <p>
          Group unavailable. <Link to="/">Return to Overview</Link>
        </p>
      </div>
    );
  }

  async function download() {
    if (!report.current || !title || downloading || !hasSections) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      await downloadReportPDF(report.current, title);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  function setReportOption(key: "view" | "audience" | ReportSection, value?: string) {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    setQuery(next, { replace: true });
  }

  const format = homeMoney.format;
  const expenses = entries.filter((e) => e.kind === "expense" || e.kind === "refund");
  const payments = entries.filter((e) => e.kind === "settlement");
  const receipts = personal ? entries : expenses;
  const projected = new Map(entries.map((e) => [e.id, homeMoney.project(e)] as const));
  const visibleEntries = !included("history") ? [] : mode === "receipts" ? receipts : entries;
  const unrated = visibleEntries.filter((e) => !projected.get(e.id));
  const spendRated = expenses.every((e) => projected.get(e.id));
  const foreign = visibleEntries.some((e) => e.currency !== home);
  const foreignSpend = expenses.some((e) => e.currency !== home);
  const homeSpend = breakdown(
    entries.map((e) => projected.get(e.id)).filter((e): e is Expense => !!e),
    g.members,
    home,
  );

  // Settlement currencies: what each debt is actually owed in (the expense currency, or the
  // currency a stored exchange converts it to).
  const settled = entries.map(settlementEntry);
  const codes = [...new Set([g.currency, ...settled.map((e) => e.currency)])].sort();
  const byCurrency = codes.map((c) => breakdown(settled, g.members, c));
  const onlyHome = codes.every((c) => c === home);

  const recordedSpend: Record<string, number> = {};
  for (const e of expenses) recordedSpend[e.currency] = (recordedSpend[e.currency] ?? 0) + (e.kind === "refund" ? -e.amount : e.amount);

  const spendText = (amount: number) => (spendRated ? format(amount, foreignSpend) : null);
  /** Settlement amounts beneath a converted figure; omitted when everything already settles in `home`. */
  const settlementText = (amounts: Record<string, number>, signed = false) =>
    onlyHome ? undefined : perCurrency(amounts, signed) || money(0, codes[0] ?? home);

  const involved = new Set(entries.flatMap((e) => [...entryPayers(e), ...e.splits].map((p) => p.memberID)));
  const people = g.members.filter((m) => !m.removed || involved.has(m.id));
  const rows = people.map((m) => {
    const paid: Record<string, number> = {};
    const share: Record<string, number> = {};
    for (const b of byCurrency) {
      const row = b.members.find((x) => x.id === m.id);
      if (row?.paid) paid[b.currency] = row.paid;
      if (row?.share) share[b.currency] = row.share;
    }
    const net = memberBalances(entries, m.id);
    return { m, paid, share, net, total: homeMoney.total(net), spend: homeSpend.members.find((x) => x.id === m.id) };
  });

  const transfers = codes.flatMap((c) => groupTransfers(g, balances(entries, c)).map((t) => ({ ...t, currency: c })));
  const range = tripRangeText(g.startDate, g.endDate);
  const generated = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const person: PersonLabel = (id) => {
    const name = g.members.find((member) => member.id === id)?.name ?? "Former member";
    return id === personal?.id ? <mark className="sum-self">{name}</mark> : name;
  };
  const unratedCodes = [...new Set(unrated.map((e) => e.currency))];

  const overview = (
    <>
      {included("totals") && <section className="sum-section">
        <h2 className="sum-h2">Totals</h2>
        <div className="sum-figures">
          <div className="sum-figure">
            <div className="sum-figure-label">Total spend</div>
            <Amount
              converted={spendText(homeSpend.total)}
              recorded={Object.keys(recordedSpend).every((c) => c === home) ? undefined : perCurrency(recordedSpend)}
              label="Recorded"
            />
          </div>
          <Figure label="Expenses">{expenses.length}</Figure>
          <Figure label="Payments">{payments.length}</Figure>
          <Figure label="Transfers due">{transfers.length || "None"}</Figure>
        </div>
      </section>}

      {included("balances") && <section className="sum-section">
        <h2 className="sum-h2">Balances</h2>
        <table className="sum-table">
          <colgroup>
            <col className="c-name" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Person</th>
              <th className="r">Paid</th>
              <th className="r">Share</th>
              <th className="r">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, paid, share, net, total, spend }) => {
              const known = !total.missing.length;
              return (
                <tr key={m.id}>
                  <td>
                    {person(m.id)}
                    {m.removed && <span className="sum-tag">Removed</span>}
                  </td>
                  <td className="r">
                    <Amount converted={spendText(spend?.paid ?? 0)} recorded={settlementText(paid)} label="Settlement" />
                  </td>
                  <td className="r">
                    <Amount converted={spendText(spend?.share ?? 0)} recorded={settlementText(share)} label="Settlement" />
                  </td>
                  <td className={"r " + (known && total.amount > 0 ? "pos" : known && total.amount < 0 ? "neg" : "")}>
                    <Amount
                      converted={known ? format(total.amount, !!total.quotes.length, true) : null}
                      recorded={settlementText(net, true) ?? (known ? undefined : perCurrency(net, true))}
                      label="Settlement"
                    />
                    {known && <span className="sum-orig">{total.amount > 0 ? "is owed" : total.amount < 0 ? "owes" : "settled"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sum-small">Paid and share count expenses net of refunds. Balance includes payments and pending entries and leaves out entries marked as already handled.</p>
      </section>}

      {included("balances") && <section className="sum-section">
        <h2 className="sum-h2">Settle up</h2>
        {transfers.length ? (
          <table className="sum-table">
            <colgroup>
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => {
                const total = homeMoney.total({ [t.currency]: t.amount });
                return (
                  <tr key={t.currency + t.from + t.to}>
                    <td>{person(t.from)}</td>
                    <td>{person(t.to)}</td>
                    <td className="r">
                      <Amount
                        converted={total.missing.length ? null : format(total.amount, !!total.quotes.length)}
                        recorded={t.currency === home ? undefined : money(t.amount, t.currency)}
                        label="Pay"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="sum-small">Everyone is settled up.</p>
        )}
        {transfers.length > 0 && (
          <p className="sum-small">
            {g.simplify === false ? "Simplify debts is off for this group." : "Simplified into the fewest transfers."}
            {codes.length > 1 && " Each transfer is paid in its settlement currency."}
          </p>
        )}
      </section>}

      {included("history") && mode === "summary" && !personal && payments.length > 0 && (
        <section className="sum-section">
          <h2 className="sum-h2">Payments recorded</h2>
          <table className="sum-table">
            <colgroup>
              <col className="c-date" />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((e) => {
                const m = entryMoney(e, projected.get(e.id) ?? null, home, format);
                return (
                  <tr key={e.id} className={e.handled ? "handled" : undefined}>
                    <td className="sum-date">{recordedDay(e.createdAt)}</td>
                    <td>{peopleList(entryPayers(e), person)}</td>
                    <td>{peopleList(e.splits, person)}</td>
                    <td className="r">
                      <Amount converted={m.converted(projected.get(e.id)?.amount ?? 0)} recorded={m.recorded(e.amount)} label="Recorded" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );

  return (
    <div className="sum-page">
      <div className="sum-toolbar no-print">
        <Link className="btn btn-sm btn-ghost" to={`/g/${g.id}`}>
          ← Back to {g.name}
        </Link>
        <div className="sum-modes" role="group" aria-label="History detail">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="sum-mode"
              aria-pressed={mode === m.id}
              title={m.title}
              onClick={() => setReportOption("view", m.id === "summary" ? undefined : m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="sum-actions">
          {me && (
            <div className="sum-modes" role="group" aria-label="Report audience">
              <button type="button" className="sum-mode" aria-pressed={!personal} onClick={() => setReportOption("audience")}>Group</button>
              <button type="button" className="sum-mode" aria-pressed={!!personal} onClick={() => setReportOption("audience", "personal")}>Personal</button>
            </div>
          )}
          <button type="button" className="btn btn-primary btn-icon" onClick={download}
            aria-label="Download PDF" title="Download PDF" disabled={downloading || !hasSections} aria-busy={downloading}>
            <DownloadIcon />
          </button>
          <button type="button" className="btn btn-icon" onClick={() => window.print()} aria-label="Print" title="Print" disabled={!hasSections}>
            <PrintIcon />
          </button>
        </div>
      </div>

      <details className="card sum-options no-print">
        <summary>Customize report</summary>
        <div className="sum-option-groups">
          <fieldset>
            <legend>Report sections</legend>
            {REPORT_SECTIONS.map(({ id, label }) => (
              <label key={id}>
                <input type="checkbox" checked={included(id)} onChange={(event) => setReportOption(id, event.target.checked ? "on" : "off")} />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Spending breakdowns</legend>
            {BREAKDOWNS.map(({ id, label }) => (
              <label key={id}>
                <input type="checkbox" checked={included(id)} onChange={(event) => setReportOption(id, event.target.checked ? "on" : "off")} />
                {label}
              </label>
            ))}
            <small className="muted">Spending breakdowns use the recorded currencies.</small>
          </fieldset>
        </div>
      </details>
      {!hasSections && <p className="sum-alert no-print" role="status">Choose at least one section to export the report.</p>}
      {downloadError && <p className="sum-alert no-print" role="alert">Couldn’t download the PDF. Try again.</p>}
      <article ref={report} className="sum-paper" aria-label={title}>
        <header className="sum-head">
          <div className="sum-kicker">Split · {reportTitle}</div>
          <h1 className="sum-title">{g.name}</h1>
          {personal && <p className="sum-for">Personal report for {person(personal.id)}</p>}
          {g.description && <p className="sum-desc">{g.description}</p>}
          <dl className="sum-meta">
            <Meta label="Kind">{kindLabel(g)}</Meta>
            {range && <Meta label="Dates">{range}</Meta>}
            <Meta label="People">{people.length}</Meta>
            <Meta label="Group currency">{g.currency}</Meta>
            {(included("totals") || included("balances") || included("history") || included("consumption")) && <Meta label="Preferred currency">{home}</Meta>}
            <Meta label="Generated">{generated}</Meta>
          </dl>
        </header>

        {unrated.length > 0 && (
          <p className="sum-alert" role="note">
            <b>Rate unavailable</b> for {unratedCodes.join(", ")} → {home} on {unrated.length}{" "}
            {unrated.length === 1 ? "entry" : "entries"}; those show recorded amounts first.
          </p>
        )}

        {overview}
        {included("categories") && (
          <SpendingTotals title="Spending by category" label="Category" expenses={expenses}
            groupBy={(entry) => categoryMeta(entry.category).label} />
        )}
        {included("months") && (
          <SpendingTotals title="Spending by month" label="Month" expenses={expenses}
            groupBy={(entry) => entry.createdAt.slice(0, 7)} />
        )}
        {included("people") && <PeopleSpending expenses={expenses} person={person} />}
        {included("consumption") && (
          <ConsumptionSection g={g} expenses={expenses} projected={projected} home={home} format={format} person={person} only={personal?.id} />
        )}

        {included("history") && mode === "summary" && !personal && (
          <section className="sum-section">
            <h2 className="sum-h2">Expenses</h2>
            {expenses.length ? (
              <table className="sum-table">
                <colgroup>
                  <col className="c-date" />
                  <col className="c-wide" />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Expense</th>
                    <th>Paid by</th>
                    <th className="r">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => {
                    const m = entryMoney(e, projected.get(e.id) ?? null, home, format);
                    return (
                      <Fragment key={e.id}>
                        <tr className={e.handled ? "handled" : undefined}>
                          <td className="sum-date">{recordedDay(e.createdAt)}</td>
                          <td>
                            {e.title}
                            <span className="sum-orig">
                              {e.category ?? "Uncategorized"}
                              {e.bill && " · Itemized"}
                              {e.handled && " · Already handled"}
                              {e.kind === "refund" && (e.refundOf ? " · Refund" : " · Credit")}
                              {e.pending && ` · Pending${e.pendingNote ? ": " + e.pendingNote : ""}`}
                            </span>
                          </td>
                          <td>{e.kind === "refund" && "Received by "}{peopleList(entryPayers(e), person)}</td>
                          <td className="r">
                            {e.kind === "refund" && "−"}<Amount converted={m.converted(projected.get(e.id)?.amount ?? 0)} recorded={m.recorded(e.amount)} label="Recorded" />
                          </td>
                        </tr>
                        {e.bill && entryItems(e).map((item) => (
                          <tr key={item.id} className="sum-portion">
                            <td />
                            <td><span className="sum-indent">{item.title}</span></td>
                            <td>Item</td>
                            <td className="r">{money(item.gross, e.currency)}</td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="sum-small">No expenses yet.</p>
            )}
          </section>
        )}

        {included("history") && (mode === "detailed" || (mode === "summary" && personal)) && (
          <section className="sum-section">
            <h2 className="sum-h2">Ledger</h2>
            {entries.length === 0 && <p className="sum-small">No entries yet.</p>}
            {entries.map((e) => (
              <LedgerEntry key={e.id} person={person} e={e} home={home} projected={projected.get(e.id) ?? null} format={format} self={personal?.id} />
            ))}
          </section>
        )}

        {included("history") && mode === "receipts" && (
          <section className="sum-section">
            <h2 className="sum-h2">Itemized receipts</h2>
            {receipts.length === 0 && <p className="sum-small">No transactions yet.</p>}
            {receipts.map((e) => (
              <LedgerEntry key={e.id} person={person} e={e} home={home} projected={projected.get(e.id) ?? null} format={format} self={personal?.id} />
            ))}
          </section>
        )}

        <footer className="sum-foot">
          {(foreign || ((included("totals") || included("balances") || included("consumption")) && foreignSpend)) && (
            <p className="sum-fine">≈ marks amounts converted using available exchange rates.</p>
          )}
          <div className="sum-foot-row">
            <span>
              {g.name} · {reportTitle}
            </span>
            <span>Made with Split</span>
          </div>
        </footer>
      </article>
    </div>
  );
}

function SpendingTotals({ title, label, expenses, groupBy }: {
  title: string;
  label: string;
  expenses: Expense[];
  groupBy: (entry: Expense) => string;
}) {
  const totals = new Map<string, Record<string, number>>();
  for (const entry of expenses) {
    const key = groupBy(entry);
    const amounts = totals.get(key) ?? {};
    amounts[entry.currency] = (amounts[entry.currency] ?? 0) + entry.amount;
    totals.set(key, amounts);
  }
  return (
    <section className="sum-section">
      <h2 className="sum-h2">{title}</h2>
      {totals.size ? (
        <table className="sum-table">
          <thead><tr><th>{label}</th><th className="r">Recorded amount</th></tr></thead>
          <tbody>
            {[...totals].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, amounts]) =>
              Object.entries(amounts).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => (
                <tr key={key + ":" + currency}>
                  <td>{key}</td>
                  <td className="r">{money(amount, currency)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      ) : <p className="sum-small">No expenses yet.</p>}
    </section>
  );
}

function PeopleSpending({ expenses, person }: { expenses: Expense[]; person: PersonLabel }) {
  const amounts = new Map<string, Map<string, { paid: number; share: number }>>();
  function add(parts: Part[], currency: string, column: "paid" | "share") {
    for (const part of parts) {
      const currencies = amounts.get(part.memberID) ?? new Map<string, { paid: number; share: number }>();
      const amount = currencies.get(currency) ?? { paid: 0, share: 0 };
      amount[column] += part.amount;
      currencies.set(currency, amount);
      amounts.set(part.memberID, currencies);
    }
  }
  for (const entry of expenses) {
    const direction = entry.kind === "refund" ? -1 : 1;
    add(entryPayers(entry).map((p) => ({ ...p, amount: direction * p.amount })), entry.currency, "paid");
    add(entry.splits.map((p) => ({ ...p, amount: direction * p.amount })), entry.currency, "share");
  }
  return (
    <section className="sum-section">
      <h2 className="sum-h2">Spending by person</h2>
      {amounts.size ? (
        <table className="sum-table">
          <thead><tr><th>Person</th><th className="r">Paid</th><th className="r">Share</th></tr></thead>
          <tbody>
            {[...amounts].flatMap(([id, currencies]) =>
              [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, { paid, share }]) => (
                <tr key={id + ":" + currency}>
                  <td>{person(id)}</td>
                  <td className="r">{money(paid, currency)}</td>
                  <td className="r">{money(share, currency)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      ) : <p className="sum-small">No expenses yet.</p>}
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sum-figure">
      <div className="sum-figure-label">{label}</div>
      <span className="sum-main">{children}</span>
    </div>
  );
}

/** "1 ARS = 0.000854 USD · published rate for the expense date (…)" and any stored settlement conversion. */
function RateLines({ e, home }: { e: Expense; home: string }) {
  const foreign = e.currency !== home;
  const rate = homeRate(e, home, fx);
  const settled = e.exchange ? settlementEntry(e) : null;
  if (!foreign && !settled) return null;
  return (
    <div className="sum-entry-fx">
      {foreign && rate && (
        <span>
          1 {e.currency} = {rateText(rate.rateE8)} {home} ·{" "}
          {rate.kind === "stored"
            ? `rate saved with the expense (${rateSource(rate)})`
            : rate.kind === "dated"
              ? `published rate for the expense date (${rateSource(rate)})`
              : rate.kind === "manual"
                ? "your rate"
                : `latest available rate (${rateSource(rate)}); expense-date rate unavailable`}
        </span>
      )}
      {foreign && !rate && (
        <span>
          No {e.currency} → {home} rate; recorded amounts shown.
        </span>
      )}
      {settled && e.exchange && e.exchange.target !== home && (
        <span>
          Settles as {money(settled.amount, settled.currency)} at 1 {e.currency} = {rateText(e.exchange.rateE8)} {e.exchange.target}{" "}
          (saved with the expense, {rateSource(e.exchange)})
        </span>
      )}
    </div>
  );
}

function EntryHead({ person, e, home, projected, format }: EntryProps) {
  const m = entryMoney(e, projected, home, format);
  const payers = entryPayers(e);
  const payment = e.kind === "settlement";
  const refund = e.kind === "refund";
  return (
    <div className="sum-entry-head">
      <div className="sum-date">{recordedDay(e.createdAt)}</div>
      <div className="sum-entry-title">
        <b>{payment ? <>Payment: {peopleList(payers, person)} → {peopleList(e.splits, person)}</> : e.title}</b>
        <span className="sum-entry-sub">
          {payment ? "Settle-up payment" : e.category ?? "Uncategorized"}
          {refund ? <> · {e.refundOf ? "Refund" : "Credit"} received by {peopleList(payers, person)}</>
            : !payment && <> · Paid by {peopleList(payers, person)}</>}
          {e.handled && " · Already handled (not in balances)"}
          {e.pending && ` · Pending${e.pendingNote ? ": " + e.pendingNote : ""} (in balances)`}
          {e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length) && " · Receipt still open"}
        </span>
        {e.notes && <span className="sum-entry-notes">{e.notes}</span>}
      </div>
      <div className="sum-entry-amount">
        {refund && "−"}<Amount converted={m.converted(projected?.amount ?? 0)} recorded={m.recorded(e.amount)} label="Recorded" />
      </div>
    </div>
  );
}

type EntryProps = { self?: string; person: PersonLabel; e: Expense; home: string; projected: Expense | null; format: Format };

function LedgerEntry(props: EntryProps) {
  const { person, e, home, projected, format, self } = props;
  const m = entryMoney(e, projected, home, format);
  const payers = entryPayers(e);
  const ids = [...new Set([...payers, ...e.splits].map((p) => p.memberID))];
  const involved = self !== undefined && ids.includes(self);
  const label = e.bill ? "By item" : e.splitMode.charAt(0).toUpperCase() + e.splitMode.slice(1);
  return (
    <div className={"sum-entry" + (involved ? " sum-involved" : "") + (e.handled ? " handled" : "") + (e.bill ? " long" : "")}>
      <EntryHead {...props} />
      <RateLines e={e} home={home} />
      {involved && e.kind !== "settlement" && <p className="sum-small">Split method · {label}</p>}
      {(e.kind !== "settlement" || involved) && (
        <table className="sum-parts">
          <colgroup>
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Person</th>
              <th className="r">{e.kind === "refund" ? "Received" : "Paid"}</th>
              <th className="r">{e.kind === "refund" ? "Credit" : e.kind === "settlement" ? "Received" : "Share"}</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const paid = sumBy(payers, id);
              const share = sumBy(e.splits, id);
              return (
                <tr key={id}>
                  <td>{person(id)}{id === self && " (you)"}</td>
                  <td className="r">
                    {paid || id === self ? (
                      <Amount converted={m.converted(projected ? sumBy(entryPayers(projected), id) : 0)} recorded={m.recorded(paid)} label="Recorded" />
                    ) : (
                      <span className="sum-dim">—</span>
                    )}
                  </td>
                  <td className="r">
                    {share || id === self ? (
                      <Amount converted={m.converted(projected ? sumBy(projected.splits, id) : 0)} recorded={m.recorded(share)} label="Recorded" />
                    ) : (
                      <span className="sum-dim">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {e.bill
        ? <ReceiptItems {...props} />
        : <p className="sum-small">Whole-amount item · {e.title}</p>}
    </div>
  );
}

function ReceiptItems({ person, e, home, projected, format, self }: EntryProps) {
  if (!e.bill) return null;
  const { items, people } = billConsumption(e.bill, e.paidBy);
  const involved = self !== undefined && [...entryPayers(e), ...e.splits].some((p) => p.memberID === self);
  const paid = self ? sumBy(entryPayers(e), self) : 0;
  const myPayments = involved && e.bill
    ? paid ? allocate(paid, items.map((item) => item.gross)) : items.map(() => 0)
    : null;
  const { tax, tip } = e.bill;
  const m = entryMoney(e, projected, home, format);
  const converted = new Map<string, Breakdown | null>();
  if (projected) {
    for (const { memberID } of people) {
      const mine = items.flatMap((item) => item.portions.filter((p) => p.memberID === memberID).map((p) => ({ item: item.id, p })));
      convertParts(mine.map(({ p }) => p), sumBy(projected.splits, memberID)).forEach((c, index) =>
        converted.set(mine[index].item + ":" + memberID, c),
      );
    }
  }
  const columns = PART_COLUMNS.filter(({ key }) =>
    (key !== "items" || tax + tip > 0) && (key !== "tax" || tax > 0) && (key !== "tip" || tip > 0),
  );
  const cells = (recorded: Breakdown, value: Breakdown | null) =>
    columns.map(({ key }) => (
      <td className="r" key={key}>
        {recorded[key] === 0 ? <span className="sum-dim">—</span> : <Amount converted={projected && value ? format(value[key], m.foreign) : null} recorded={m.recorded(recorded[key])} label="Recorded" quiet={!projected} />}
      </td>
    ));
  const cols = (
    <colgroup>
      <col className="c-wide" />
      {columns.map(({ key }) => <col key={key} />)}
    </colgroup>
  );
  const head = (first: string) => (
    <thead>
      <tr>
        <th>{first}</th>
        {columns.map(({ key, label }) => <th className="r" key={key}>{label}</th>)}
      </tr>
    </thead>
  );
  const totalConverted = sumConverted([...converted.values()]);
  return (
    <div className="sum-receipt">
      <table className="sum-parts sum-items">
        {cols}
        {head("Item · who had it")}
        <tbody>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              <tr className="sum-subhead">
                <td>
                  {item.title}
                  {myPayments && <span className="sum-orig">
                    Your payment (allocated) {money(myPayments[index], e.currency)}<br />
                    Your share {money(sumBy(item.portions, self ?? ""), e.currency)}
                  </span>}
                  {item.open && <span className="sum-orig">Unclaimed · charged to the payer</span>}
                </td>
                {cells({ amount: item.gross, items: item.amount, tax: item.tax, tip: item.tip },
                  sumConverted(item.portions.map((p) => converted.get(item.id + ":" + p.memberID))))}
              </tr>
              {item.portions.map((p) => (
                <tr key={p.memberID} className="sum-portion">
                  <td><span className="sum-indent">{person(p.memberID)}</span></td>
                  {cells(p, converted.get(item.id + ":" + p.memberID) ?? null)}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      {tax + tip > 0 && (
        <p className="sum-small">
          Tax {money(tax, e.currency)} and tip {money(tip, e.currency)} are spread by item price, then by each person’s share of the item.
        </p>
      )}
      <table className="sum-parts sum-receipt-totals">
        {cols}
        {head("Person")}
        <tbody>
          {people.map((p) => (
            <tr key={p.memberID}>
              <td>{person(p.memberID)}</td>
              {cells(p, sumConverted(items.flatMap((i) => i.portions.filter((x) => x.memberID === p.memberID).map((x) => converted.get(i.id + ":" + x.memberID)))))}
            </tr>
          ))}
          <tr className="sum-subhead">
            <td>Receipt total</td>
            {cells({ amount: e.amount, items: e.amount - tax - tip, tax, tip }, totalConverted)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Who consumed what across the group's expenses: each person's receipt items (or their share of an
 * expense without items) with item price, tax and tip, exact to the cent in the recorded currency.
 */
function ConsumptionSection({ g, expenses, projected, home, format, person, only }: {
  g: Group;
  expenses: Expense[];
  projected: Map<string, Expense | null>;
  home: string;
  format: Format;
  person: PersonLabel;
  only?: string;
}) {
  const byID = new Map(expenses.map((e) => [e.id, e]));
  const codes = [...new Set(expenses.map((e) => e.currency))].sort();
  const lines = codes.flatMap((c) => consumptionReport(expenses, c).people.flatMap((p) => p.lines));
  // Converted figures per person and expense, so each person's converted lines add up to their converted share.
  const converted = new Map<(typeof lines)[number], Breakdown | null>();
  const groups = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = line.entryID + ":" + line.memberID;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const group of groups.values()) {
    const target = projected.get(group[0].entryID);
    const values = target ? convertParts(group, sumBy(target.splits, group[0].memberID)) : group.map(() => null);
    group.forEach((line, index) => converted.set(line, values[index]));
  }
  const order = g.members.map((m) => m.id);
  const ids = [...new Set(lines.map((l) => l.memberID))]
    .filter((id) => !only || id === only)
    .sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));

  const amount = (list: typeof lines, key: keyof Breakdown) => {
    const recorded: Record<string, number> = {};
    for (const l of list) {
      const c = byID.get(l.entryID)!.currency;
      recorded[c] = (recorded[c] ?? 0) + l[key];
    }
    if (Object.values(recorded).every((v) => v === 0)) return <span className="sum-dim">—</span>;
    const foreign = list.some((l) => byID.get(l.entryID)!.currency !== home);
    const total = sumConverted(list.map((l) => converted.get(l)));
    return (
      <Amount converted={total ? format(total[key], foreign) : null}
        recorded={foreign ? perCurrency(recorded) || money(0, home) : undefined} label="Recorded" quiet={!foreign} />
    );
  };

  return (
    <section className="sum-section">
      <h2 className="sum-h2">Consumption by person</h2>
      {ids.length ? (
        <table className="sum-table sum-consumption">
          <colgroup>
            <col className="c-wide" />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Person · expense › item</th>
              {PART_COLUMNS.map(({ key, label }) => <th className="r" key={key}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const mine = lines.filter((l) => l.memberID === id);
              return (
                <Fragment key={id}>
                  <tr className="sum-subhead">
                    <td>{person(id)}</td>
                    {PART_COLUMNS.map(({ key }) => <td className="r" key={key}>{amount(mine, key)}</td>)}
                  </tr>
                  {mine.map((l) => {
                    const e = byID.get(l.entryID)!;
                    return (
                      <tr key={l.entryID + ":" + (l.itemID ?? "")} className={"sum-portion" + (e.handled ? " handled" : "")}>
                        <td>
                          <span className="sum-indent">
                            {l.itemID ? <>{e.title} › {l.title}</> : e.title}
                            <span className="sum-orig">{recordedDay(e.createdAt)}{e.bill ? " · Itemized" : " · Share of expense"}{e.handled && " · Already handled"}</span>
                          </span>
                        </td>
                        {PART_COLUMNS.map(({ key }) => <td className="r" key={key}>{amount([l], key)}</td>)}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="sum-small">No expenses yet.</p>
      )}
      <p className="sum-small">
        Itemized expenses list each item a person had, with tax and tip spread by item price. Other expenses show the person’s share as one line.
      </p>
    </section>
  );
}
