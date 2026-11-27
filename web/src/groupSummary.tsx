// Printable group report with a direct PDF download in three modes. Amounts lead with the
// preferred (home) currency using the same projection as the rest of the app, with the recorded or
// settlement amounts underneath and labelled. When a rate is missing, the recorded amount leads
// instead, so the document never depends on an estimate.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useLedger } from "./context";
import {
  allocate,
  balances,
  breakdown,
  entryPayers,
  grossItems,
  groupTransfers,
  itemPortions,
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
  { id: "summary", label: "Summary", title: "Totals, balances, settle-up and a table of expenses" },
  { id: "detailed", label: "Detailed ledger", title: "Every entry with who paid and each person’s share" },
  { id: "receipts", label: "Itemized receipts", title: "Each receipt item, who had it and each person’s share" },
];
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

/**
 * Receipt items with each person's portion, recorded (the same `grossItems`/`itemPortions` math the
 * ledger uses) and converted. Each person's converted share is allocated across their own item
 * portions by largest remainder, so converted items add up exactly to the converted shares.
 */
function receiptRows(e: Expense, projected: Expense | null) {
  if (!e.bill) return null;
  const rows = grossItems(e.bill).map((item) => ({
    item,
    portions: itemPortions(item, e.paidBy).map((p) => ({ ...p, converted: null as number | null })),
  }));
  if (projected) {
    const ids = new Set(rows.flatMap((r) => r.portions.map((p) => p.memberID)));
    for (const id of ids) {
      const mine = rows.flatMap((r) => r.portions.filter((p) => p.memberID === id));
      const target = sumBy(projected.splits, id);
      try {
        const amounts =
          target === 0 || mine.every((p) => p.amount === 0)
            ? mine.map(() => 0)
            : allocate(target, mine.map((p) => p.amount), Number.MAX_SAFE_INTEGER);
        mine.forEach((p, index) => (p.converted = amounts[index]));
      } catch {
        mine.forEach((p) => (p.converted = null));
      }
    }
  }
  return rows;
}

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
  const me = g?.members.find((member) => member.userID === user && !member.removed);
  const personal = query.get("audience") === "personal" ? me : undefined;
  const audienceTitle = personal ? "Personal" : "Group";
  const title = g ? `${g.name} – ${REPORT_TITLE[mode]} – ${audienceTitle}` : undefined;
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
    if (!report.current || !title || downloading) return;
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

  function setReportOption(key: "view" | "audience", value?: string) {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    setQuery(next, { replace: true });
  }

  const format = homeMoney.format;
  const expenses = entries.filter((e) => e.kind === "expense");
  const payments = entries.filter((e) => e.kind !== "expense");
  const receipts = expenses.filter((e) => e.bill);
  const projected = new Map(entries.map((e) => [e.id, homeMoney.project(e)] as const));
  const visibleEntries = mode === "receipts" ? receipts : entries;
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
  for (const e of expenses) recordedSpend[e.currency] = (recordedSpend[e.currency] ?? 0) + e.amount;

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
      <section className="sum-section">
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
      </section>

      <section className="sum-section">
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
        <p className="sum-small">Paid and share count expenses only. Balance includes payments and leaves out entries marked as already handled.</p>
      </section>

      <section className="sum-section">
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
      </section>

      {payments.length > 0 && (
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
        <div className="sum-modes" role="group" aria-label="Report type">
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
            aria-label="Download PDF" title="Download PDF" disabled={downloading} aria-busy={downloading}>
            <DownloadIcon />
          </button>
          <button type="button" className="btn btn-icon" onClick={() => window.print()} aria-label="Print" title="Print">
            <PrintIcon />
          </button>
        </div>
      </div>

      {downloadError && <p className="sum-alert no-print" role="alert">Couldn’t download the PDF. Try again.</p>}
      <article ref={report} className="sum-paper" aria-label={title}>
        <header className="sum-head">
          <div className="sum-kicker">Split · {REPORT_TITLE[mode]}</div>
          <h1 className="sum-title">{g.name}</h1>
          {personal && <p className="sum-for">Personal report for {person(personal.id)}</p>}
          {g.description && <p className="sum-desc">{g.description}</p>}
          <dl className="sum-meta">
            <Meta label="Kind">{kindLabel(g)}</Meta>
            {range && <Meta label="Dates">{range}</Meta>}
            <Meta label="People">{people.length}</Meta>
            <Meta label="Group currency">{g.currency}</Meta>
            <Meta label="Shown in">{home}</Meta>
            <Meta label="Generated">{generated}</Meta>
          </dl>
        </header>

        {unrated.length > 0 && (
          <p className="sum-alert" role="note">
            <b>Rate unavailable</b> for {unratedCodes.join(", ")} → {home} on {unrated.length}{" "}
            {unrated.length === 1 ? "entry" : "entries"}; those show recorded amounts first.
          </p>
        )}

        {mode !== "receipts" && overview}

        {mode === "summary" && (
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
                      <tr key={e.id} className={e.handled ? "handled" : undefined}>
                        <td className="sum-date">{recordedDay(e.createdAt)}</td>
                        <td>
                          {e.title}
                          <span className="sum-orig">
                            {e.category ?? "Uncategorized"}
                            {e.bill && " · Itemized"}
                            {e.handled && " · Already handled"}
                          </span>
                        </td>
                        <td>{peopleList(entryPayers(e), person)}</td>
                        <td className="r">
                          <Amount converted={m.converted(projected.get(e.id)?.amount ?? 0)} recorded={m.recorded(e.amount)} label="Recorded" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="sum-small">No expenses yet.</p>
            )}
          </section>
        )}

        {mode === "detailed" && (
          <section className="sum-section">
            <h2 className="sum-h2">Ledger</h2>
            {entries.length === 0 && <p className="sum-small">No entries yet.</p>}
            {entries.map((e) => (
              <LedgerEntry key={e.id} person={person} e={e} home={home} projected={projected.get(e.id) ?? null} format={format} />
            ))}
          </section>
        )}

        {mode === "receipts" && (
          <section className="sum-section">
            <h2 className="sum-h2">Itemized receipts</h2>
            {receipts.length === 0 && <p className="sum-small">No expenses in this group have itemized receipts.</p>}
            {receipts.map((e) => (
              <ReceiptEntry key={e.id} person={person} e={e} home={home} projected={projected.get(e.id) ?? null} format={format} />
            ))}
          </section>
        )}

        <footer className="sum-foot">
          {foreign && (
            <p className="sum-fine">≈ marks amounts converted using available exchange rates.</p>
          )}
          <div className="sum-foot-row">
            <span>
              {g.name} · {REPORT_TITLE[mode]}
            </span>
            <span>Made with Split</span>
          </div>
        </footer>
      </article>
    </div>
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
  const payment = e.kind !== "expense";
  return (
    <div className="sum-entry-head">
      <div className="sum-date">{recordedDay(e.createdAt)}</div>
      <div className="sum-entry-title">
        <b>{payment ? <>Payment: {peopleList(payers, person)} → {peopleList(e.splits, person)}</> : e.title}</b>
        <span className="sum-entry-sub">
          {payment ? "Settle-up payment" : e.category ?? "Uncategorized"}
          {!payment && <> · Paid by {peopleList(payers, person)}</>}
          {e.handled && " · Already handled (not in balances)"}
          {e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length) && " · Receipt still open"}
        </span>
        {e.notes && <span className="sum-entry-notes">{e.notes}</span>}
      </div>
      <div className="sum-entry-amount">
        <Amount converted={m.converted(projected?.amount ?? 0)} recorded={m.recorded(e.amount)} label="Recorded" />
      </div>
    </div>
  );
}

type EntryProps = { person: PersonLabel; e: Expense; home: string; projected: Expense | null; format: Format };

function LedgerEntry(props: EntryProps) {
  const { person, e, home, projected, format } = props;
  const m = entryMoney(e, projected, home, format);
  const payers = entryPayers(e);
  const ids = [...new Set([...payers, ...e.splits].map((p) => p.memberID))];
  return (
    <div className={"sum-entry" + (e.handled ? " handled" : "") + (e.bill ? " long" : "")}>
      <EntryHead {...props} />
      <RateLines e={e} home={home} />
      {e.kind === "expense" && (
        <table className="sum-parts">
          <colgroup>
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Person</th>
              <th className="r">Paid</th>
              <th className="r">Share</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const paid = sumBy(payers, id);
              const share = sumBy(e.splits, id);
              return (
                <tr key={id}>
                  <td>{person(id)}</td>
                  <td className="r">
                    {paid ? (
                      <Amount converted={m.converted(projected ? sumBy(entryPayers(projected), id) : 0)} recorded={m.recorded(paid)} label="Recorded" />
                    ) : (
                      <span className="sum-dim">—</span>
                    )}
                  </td>
                  <td className="r">
                    {share ? (
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
      {e.bill && <ReceiptItems {...props} />}
    </div>
  );
}

function ReceiptEntry(props: EntryProps) {
  return (
    <div className={"sum-entry long" + (props.e.handled ? " handled" : "")}>
      <EntryHead {...props} />
      <RateLines e={props.e} home={props.home} />
      <ReceiptItems {...props} />
    </div>
  );
}

function ReceiptItems({ person, e, home, projected, format }: EntryProps) {
  const rows = receiptRows(e, projected);
  if (!rows || !e.bill) return null;
  const m = entryMoney(e, projected, home, format);
  const extra = e.bill.tax + e.bill.tip;
  const convertedOf = (parts: { converted: number | null }[]) =>
    parts.some((p) => p.converted === null) ? null : parts.reduce((s, p) => s + (p.converted ?? 0), 0);
  const cell = (recorded: number, converted: number | null) => (
    <Amount converted={projected && converted !== null ? format(converted, m.foreign) : null} recorded={m.recorded(recorded)} label="Recorded" quiet={!projected} />
  );
  const people = [...new Set(rows.flatMap((r) => r.portions.map((p) => p.memberID)))];
  return (
    <div className="sum-receipt">
      <table className="sum-parts sum-items">
        <colgroup>
          <col className="c-wide" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Item</th>
            <th>Who had it · each share</th>
            <th className="r">Item total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, portions }) => (
            <tr key={item.id}>
              <td>
                {item.title}
                {item.gross !== item.amount && (
                  <span className="sum-orig">
                    {money(item.amount, e.currency)} + {money(item.gross - item.amount, e.currency)} tax/tip
                  </span>
                )}
                {!item.memberIDs.length && <span className="sum-orig">Unclaimed · charged to the payer</span>}
              </td>
              <td>
                <ul className="sum-claims">
                  {portions.map((p) => (
                    <li key={p.memberID}>
                      <span>{person(p.memberID)}</span>
                      {cell(p.amount, p.converted)}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="r">{cell(item.gross, convertedOf(portions))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {extra > 0 && (
        <p className="sum-small">
          Item totals include tax {money(e.bill.tax, e.currency)} and tip {money(e.bill.tip, e.currency)}, spread by item price.
        </p>
      )}
      <table className="sum-parts sum-receipt-totals">
        <colgroup>
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Person</th>
            <th className="r">Receipt share</th>
          </tr>
        </thead>
        <tbody>
          {people.map((id) => {
            const mine = rows.flatMap((r) => r.portions.filter((p) => p.memberID === id));
            return (
              <tr key={id}>
                <td>{person(id)}</td>
                <td className="r">{cell(sumBy(mine, id), convertedOf(mine))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
