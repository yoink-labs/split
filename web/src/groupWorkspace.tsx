import { expenseTripPhase, tripPhaseLabels } from "../../worker/src/tripPhases";
import { nightRate } from "../../worker/src/ledger";
import { PaymentOptions } from "./paymentMethods";
import { memberBalances, useHomeMoney } from "./homeMoney";
import { PendingPayments } from "./settlements";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { analyze } from "./analytics";
import { DailyCostView, GroupAnalytics } from "./analyticsView";
import { CategoryDonut } from "./categoryDonut";
import { TransactionTable } from "./transactionTable";
import { categoryMeta } from "./categories";
import { Form, useLedger, value } from "./context";
import {
  balances,
  breakdown,
  buildGroupCSV,
  dateText,
  entryItems,
  entryPayers,
  memberName,
  memberPath,
  minor,
  money,
  moneyCompact,
  settlementEntry,
  shortDate,
  stamp,
  tripRangeText,
  type Expense,
  type ExpenseComment,
  type Group,
  type Person,
} from "./data";
import { convert, fx, rateText, sourceLabel, useRates, type Exchange } from "./fx";
import { CurrencySelect, RateField } from "./fxui";
import { MoneyFlowGraph } from "./moneyFlowGraph";
import { transferID } from "./moneyFlowLayout";
import { ReceiptsHub } from "./receiptsHub";
import { Avatar, AvatarStack, CategoryIcon } from "./ui";

import { GroupLedger } from "./groupLedger";
import { PendingPanel, PendingSummary } from "./pending";
import { RefundForm } from "./refundForm";
import { pendingView, refundRoom, refundsOf } from "../../worker/src/refundMath";
import { GroupMembers } from "./groupMembers";
import { GroupSettings } from "./groupSettings";
import "./groupWorkspace.css";

const tabs = ["overview", "analytics", "ledger", "transactions", "receipts", "settle", "members", "settings"] as const;
type Tab = typeof tabs[number];

function ExpenseDrawer({
  g,
  entry,
  entries,
  onClose,
  onOpenReceipt,
  onInspect,
}: {
  g: Group;
  entry: Expense;
  entries: Expense[];
  onClose: () => void;
  onOpenReceipt: (id: string) => void;
  onInspect: (id: string) => void;
}) {
  const { request, save, user } = useLedger();
  const homeMoney = useHomeMoney();
  const nav = useNavigate();
  const [chargeHistory, setChargeHistory] = useState<{
    id: number; previousAmount: number | null; previousCurrency: string | null;
    chargedAmount: number | null; chargedCurrency: string | null; changedAt: string;
  }[]>([]);
  const [comments, setComments] = useState<ExpenseComment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [handledBusy, setHandledBusy] = useState(false);
  const [handledError, setHandledError] = useState("");
  const [refunding, setRefunding] = useState(false);
  const refund = entry.kind === "refund";
  const original = refund && entry.refundOf ? entries.find((e) => e.id === entry.refundOf) : undefined;
  const linked = entry.kind === "expense" ? refundsOf(entries, entry.id) : [];
  const room = entry.kind === "expense" && !entry.combinedCount ? refundRoom(entry, linked) : undefined;
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    drawer.current?.querySelector<HTMLButtonElement>("[aria-label='Close']")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let alive = true;
    request<{ comments: ExpenseComment[] }>(`/v1/entries/${entry.id}/comments`)
      .then((res) => {
        if (alive) setComments(res.comments ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [request, entry.id]);

  useEffect(() => {
    if (entry.kind !== "expense") return;
    let alive = true;
    setChargeHistory([]);
    request<{ history: typeof chargeHistory }>(`/v1/entries/${entry.id}/charged-amount-history`)
      .then(({ history }) => { if (alive) setChargeHistory(history); })
      .catch(() => {});
    return () => { alive = false; };
  }, [request, entry.id, entry.kind, entry.exchange?.statementAmount, entry.exchange?.target]);

  const payers = entryPayers(entry);
  const canSetHandled = entry.kind === "expense" && !entry.combinedCount && !entry.pending && payers.some((payer) =>
    g.members.some((person) => person.id === payer.memberID && person.userID === user && !person.removed),
  );

  async function toggleHandled() {
    if (handledBusy) return;
    setHandledBusy(true);
    setHandledError("");
    try {
      await save(`/v1/entries/${entry.id}/handled`, { handled: !entry.handled });
    } catch (error) {
      setHandledError(error instanceof Error ? error.message : "Could not update this expense.");
    } finally {
      setHandledBusy(false);
    }
  }
  const openCount = entry.bill?.items.filter((i) => !i.memberIDs.length).length ?? 0;

  async function toggleLike() {
    await save(`/v1/entries/${entry.id}/like`, {});
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentText.trim()) return;
    setBusy(true);
    try {
      const created = await request<ExpenseComment>(`/v1/entries/${entry.id}/comments`, {
        body: commentText.trim(),
      });
      setComments((c) => [...c, created]);
      setCommentText("");
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry() {
    if (linked.length) {
      alert("Delete this expense’s refunds first. Its refunds would no longer have an original.");
      return;
    }
    if (!confirm(`Delete "${entry.title}"? This updates everyone’s balances.`)) return;
    const { editable: _ed, recurrence: _rec, commentCount: _cc, likeCount: _lc, likedByMe: _lm, receiptIDs: _ri, ...orig } = entry;
    await save(`/v1/entries/${entry.id}/delete`, { original: orig });
    onClose();
  }

  const phase = expenseTripPhase(g, entry);

  async function setRecurrence(cadence: string) {
    await save(`/v1/groups/${g.id}/repeat`, { entryID: entry.id, cadence });
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside ref={drawer} className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Expense details"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="drawer-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <CategoryIcon category={entry.category} settlement={entry.kind === "settlement"} />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.title}
              </h3>
              <p className="muted" style={{ fontSize: 12 }}>
                {dateText(entry.createdAt)} {entry.category ? `· ${entry.category}` : ""}
                {entry.handled && " · Already handled"}
              </p>
              <div className="drawer-tags">
                {phase && <span className="tag">{tripPhaseLabels[phase]}</span>}
                {refund && <span className="tag tag-refund">{entry.refundOf ? "Refund" : "Credit"}</span>}
                {entry.pending && <span className="tag tag-pending">Pending</span>}
                {original && (
                  <button type="button" className="ledger-refund-of" onClick={() => onInspect(original.id)}>
                    Refund of {original.title}
                  </button>
                )}
                {refund && entry.refundOf && !original && <span className="muted" style={{ fontSize: 12 }}>Original expense deleted</span>}
              </div>
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {entry.combinedCount && g.members.some((m) => m.userID === user && !m.removed) ? (
            <div className="card card-pad">
              <p>Combined from {entry.combinedCount} expenses</p>
              <Form label="Restore original expenses" submit={async () => {
                await save(`/v1/entries/${entry.id}/uncombine`, {});
                onClose();
              }} />
            </div>
          ) : null}
          {/* Amount & FX summary */}
          <div className="card card-pad" style={{ background: "var(--bg)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" }} className={"num" + (refund ? " pos" : "")}>
                {refund ? homeMoney.entry(entry).replace(/^(≈ )?/, "$1−") : homeMoney.entry(entry)}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-xs" onClick={toggleLike}>
                  {entry.likedByMe ? "♥" : "♡"} {entry.likeCount ?? 0}
                </button>
                {entry.editable && entry.kind === "expense" && (
                  <button
                    className="btn btn-xs"
                    onClick={() => nav(`/g/${g.id}/e/${entry.id}/edit`)}
                  >
                    Edit
                  </button>
                )}
                {entry.editable && (
                  <button className="btn btn-xs btn-danger" onClick={deleteEntry}>
                    Delete
                  </button>
                )}
              </div>
            </div>

            {canSetHandled && (
              <button className="btn btn-sm" style={{ marginTop: 10 }} disabled={handledBusy} onClick={() => void toggleHandled()}>
                {entry.handled ? "Include in balances" : "Mark as handled"}
              </button>
            )}
            {handledError && <p className="error-banner" role="alert">{handledError}</p>}
            {entry.kind === "expense" && !refunding && room && room.total > 0 && (
              <button className="btn btn-sm" style={{ marginTop: 10, marginLeft: canSetHandled ? 8 : 0 }} onClick={() => setRefunding(true)}>
                Refund…
              </button>
            )}
            {entry.exchange?.statementAmount !== undefined && (
              <p className="muted">Original amount <b className="num">{money(entry.amount, entry.currency)}</b></p>
            )}
            {entry.exchange && (
              <p style={{ marginTop: 8, fontSize: 12.5, color: "var(--ink-2)" }}>
                {entry.exchange.statementAmount !== undefined ? "Actually charged (override)" : "Settles as"} <b className="num">{money(settlementEntry(entry).amount, entry.exchange.target)}</b>{" "}
                <span className="muted">
                  {entry.exchange.statementAmount === undefined ? "at" : "· Saved rate"} 1 {entry.currency} ≈ {rateText(entry.exchange.rateE8)} {entry.exchange.target} (
                  {sourceLabel(entry.exchange)}
                  {entry.exchange.date > entry.createdAt.slice(0, 10) ? " · latest available" : ""}
                  )
                </span>
              </p>
            )}

            {entry.notes && (
              <p style={{ marginTop: 10, fontSize: 13, color: "var(--ink-2)", paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                {entry.notes}
              </p>
            )}
          </div>

          {!refunding && !entry.combinedCount && <PendingPanel g={g} entry={entry} entries={entries} />}

          {refunding && (
            <div className="card card-pad">
              <h4 style={{ fontSize: 13.5, marginBottom: 8 }}>Refund part or all of {entry.title}</h4>
              <RefundForm g={g} original={entry} entries={entries} onDone={() => setRefunding(false)} onCancel={() => setRefunding(false)} />
            </div>
          )}

          {linked.length > 0 && room && (
            <div className="card refund-links">
              <div className="card-head">
                <h3>Refunds</h3>
                <span className="muted" style={{ fontSize: 12 }}>
                  {money(entry.amount - room.total, entry.currency)} of {money(entry.amount, entry.currency)} refunded
                  {room.total > 0 ? ` · ${money(room.total, entry.currency)} left` : " · fully refunded"}
                </span>
              </div>
              {linked.map((r) => (
                <button type="button" className="row" key={r.id} onClick={() => onInspect(r.id)}>
                  <span>
                    <strong>{r.title}</strong>
                    <span className="muted" style={{ fontSize: 12 }}> · {shortDate(r.createdAt)} · to {r.splits.map((s) => memberName(g, s.memberID)).join(", ")}</span>
                    {r.pending && <span className="tag tag-pending">Pending</span>}
                  </span>
                  <b className="num pos">−{money(r.amount, r.currency)}</b>
                </button>
              ))}
            </div>
          )}

          <div className="card card-pad">
            <strong>Items</strong>
            {entryItems(entry).map((item) => (
              <div key={item.id} className="expense-item-line">
                <div>
                  {item.title}
                  <div className="muted">
                    {item.portions.map((p) => `${memberName(g, p.memberID)} ${money(p.amount, entry.currency)}`).join(" · ")}
                  </div>
                </div>
                <b className="num">{money(item.gross, entry.currency)}</b>
              </div>
            ))}
          </div>

          {/* Receipt callout */}
          {(entry.bill || (entry.receiptIDs && entry.receiptIDs.length > 0)) && (
            <div className="card card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <strong style={{ fontSize: 13.5 }}>
                  {entry.bill ? "Itemized receipt" : entry.receiptIDs?.length === 1 ? "Receipt photo" : "Receipt photos"}
                </strong>
                <p className="muted" style={{ fontSize: 12 }}>
                  {entry.bill
                    ? openCount > 0
                      ? `${openCount} unclaimed item${openCount === 1 ? "" : "s"}`
                      : entry.bill.closed
                        ? "Receipt closed"
                        : "All items claimed"
                    : `${entry.receiptIDs?.length} photo${entry.receiptIDs?.length === 1 ? "" : "s"}`}
                </p>
              </div>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  onClose();
                  onOpenReceipt(entry.id);
                }}
              >
                Open in Receipts Hub
              </button>
            </div>
          )}

          {/* Paid by */}
          <div>
            <h4 style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
              {refund ? "Received by" : entry.kind === "settlement" ? "Paid by" : payers.length > 1 ? "Paid by (Multiple payers)" : "Paid by"}
            </h4>
            <div className="panel">
              {payers.map((p) => {
                const m = g.members.find((x) => x.id === p.memberID);
                return (
                  <Link className="row" key={p.memberID} to={memberPath(g, p.memberID)} onClick={onClose}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <Avatar name={m?.name ?? "?"} avatarURL={m?.avatarURL} size={26} />
                      <strong style={{ fontSize: 13.5, color: "var(--ink)" }}>{m?.name ?? "Member"}</strong>
                    </span>
                    <b className="num" style={{ color: "var(--ink)" }}>{homeMoney.portion(entry, p.memberID, true)}</b>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Split with */}
          <div>
            <h4 style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
              {refund ? "Credited to" : entry.kind === "settlement" ? "Paid to" : entry.splits.some(s => s.nights !== undefined) ? "Split by nights" : `Split with (${entry.splitMode})`}
            </h4>
            {entry.spread && <p className="muted">First day {entry.spread.start} · End date {entry.spread.end} (excluded)</p>}
            <div className="panel">
              {entry.splits.map((s) => {
                const m = g.members.find((x) => x.id === s.memberID);
                return (
                  <Link className="row" key={s.memberID} to={memberPath(g, s.memberID)} onClick={onClose}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <Avatar name={m?.name ?? "?"} avatarURL={m?.avatarURL} size={26} />
                      <strong style={{ fontSize: 13.5, color: "var(--ink)" }}>{m?.name ?? "Member"}</strong>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      {s.nights !== undefined && <small className="muted">{s.nights} × {moneyCompact(nightRate(entry), entry.currency)}/night<br /></small>}
                      <b className="num" style={{ color: "var(--ink)" }}>{homeMoney.portion(entry, s.memberID)}</b>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Recurring schedule for ordinary fixed-currency expenses */}
          {entry.editable && entry.kind === "expense" && !entry.bill && !entry.exchange && !entry.spread && (
            <div className="card card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <strong style={{ fontSize: 13 }}>Repeat schedule</strong>
                <p className="muted" style={{ fontSize: 12 }}>Great for rent, utilities & subscriptions</p>
              </div>
              <select
                value={entry.recurrence ?? "off"}
                onChange={(e) => void setRecurrence(e.target.value)}
                style={{ height: 32, padding: "0 10px" }}
              >
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
          )}

          {chargeHistory.length > 0 && (
            <div className="card card-pad">
              <h4>Charged amount history</h4>
              {chargeHistory.map((change) => (
                <p className="muted" key={change.id}>
                  {dateText(change.changedAt)} · {change.previousAmount !== null && change.previousCurrency
                    ? money(change.previousAmount, change.previousCurrency) : "Exchange rate"} →{" "}
                  {change.chargedAmount !== null && change.chargedCurrency
                    ? money(change.chargedAmount, change.chargedCurrency) : "Exchange rate"}
                </p>
              ))}
            </div>
          )}

          {/* Comments */}
          <div>
            <h4 style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
              Comments ({comments.length})
            </h4>
            <div className="comment-list" style={{ marginBottom: 10 }}>
              {comments.map((c) => (
                <div className="comment-item" key={c.id}>
                  <div className="comment-head">
                    <strong style={{ color: "var(--ink)" }}>{c.authorName}</strong>
                    <span>{shortDate(c.createdAt)}</span>
                  </div>
                  <p>{c.body}</p>
                </div>
              ))}
              {!comments.length && (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  No comments yet. Ask a question or leave a note for the group.
                </p>
              )}
            </div>
            <form onSubmit={postComment} style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="Write a comment…"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !commentText.trim()}>
                Post
              </button>
            </form>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** An upper bound on what `from` owes `to` from confirmed entries only. */
function groupConfirmed(confirmedOnly: Record<string, number>, from: string, to: string) {
  const owe = Math.max(0, -(confirmedOnly[from] ?? 0)), owed = Math.max(0, confirmedOnly[to] ?? 0);
  return Math.min(owe, owed);
}

function SettlePaymentForm({
  g,
  from,
  to,
  amount: owed,
  currency: owedIn,
  open,
  pending,
  onDone,
}: {
  g: Group;
  from: string;
  to: string;
  amount: number;
  currency: string;
  open: string[];
  pending: number;
  onDone: () => void;
}) {
  const { save } = useLedger();
  const [currency, setCurrency] = useState(owedIn);
  const homeMoney = useHomeMoney();
  useRates([currency], homeMoney.home);
  const [text, setText] = useState((owed / 100).toFixed(2));
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [day] = useState(() => stamp());
  const [paymentID] = useState(() => crypto.randomUUID());
  const converts = currency !== g.currency && !open.includes(currency);

  let typed: number | null = null;
  try {
    typed = minor(text);
  } catch {
    typed = null;
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      <Form
        label="Request approval"
        submit={async () => {
          const amount = minor(text);
          if (amount <= 0) throw new Error("Enter a payment greater than zero.");
          if (currency === owedIn && amount > owed)
            throw new Error("Enter an amount up to the outstanding balance.");
          if (converts && !exchange)
            throw new Error("Wait for the rate, or enter your own rate.");
          if (pending && !confirm(`${pending} pending ${pending === 1 ? "entry" : "entries"} in ${owedIn} may still change. This balance includes ${pending === 1 ? "it" : "them"}. Settle anyway?`)) return;
          await save("/v1/settlements", {
            id: paymentID,
            groupID: g.id,
            title: "Settle-up payment",
            amount,
            currency,
            paidBy: from,
            splits: [{ memberID: to, amount }],
            kind: "settlement",
            splitMode: "exact",
            createdAt: day,
            ...(converts && exchange ? { exchange } : {}),
          });
          onDone();
        }}
      >
        <p className="muted">Enter the payment you already made. The recipient confirms it before balances update.</p>
        {pending > 0 && (
          <p className="pending-warning" role="alert">
            <span className="tag tag-pending">Pending</span> {pending} {pending === 1 ? "entry" : "entries"} in {owedIn} may still change. Settling now uses the balance that includes {pending === 1 ? "it" : "them"}.
          </p>
        )}
        <div className="form-row">
          <label className="field">
            Amount paid
            <input
              type="text"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          </label>
          <CurrencySelect
            label="Paid in"
            value={currency}
            onChange={(c) => {
              setExchange(null);
              setCurrency(c);
              const q = c === owedIn ? null : fx.rate(owedIn, c);
              setText(c === owedIn ? (owed / 100).toFixed(2) : q ? (convert(owed, q.rateE8) / 100).toFixed(2) : "");
              if (c !== owedIn) void fx.latest(owedIn, c);
            }}
          />
        </div>
        {typed !== null && typed > 0 && currency !== homeMoney.home && (
          <small className="muted">{homeMoney.totalText({ [currency]: typed })}</small>
        )}
        {converts && (
          <RateField
            key={currency}
            from={currency}
            to={g.currency}
            amount={typed}
            date={day.slice(0, 10)}
            tripRate={g.tripRates?.[currency]}
            onChange={setExchange}
          />
        )}
      </Form>
    </div>
  );
}

export function GroupWorkspace() {
  const { data } = useLedger();
  const { gid, eid } = useParams();
  const g = data.groups.find((x) => x.id === gid);
  return g ? <Workspace key={g.id} g={g} expenseID={eid} /> : <p>Group unavailable.</p>;
}

function Workspace({ g, expenseID }: { g: Group; expenseID?: string }) {
  const { data, user } = useLedger();
  const nav = useNavigate();
  const [query, setQuery] = useSearchParams();

  const selectedTab = query.get("tab") ?? "";
  const legacyTransactions = selectedTab === "ledger"
    && (query.get("view") === "transactions" || (!query.has("view") && query.has("cat")));
  const tab = expenseID || legacyTransactions ? "transactions" : selectedTab === "people" ? "members"
    : selectedTab === "rates" ? "settings" : tabs.find((item) => item === selectedTab) ?? "overview";
  const homeMoney = useHomeMoney();

  const [inspectID, setInspectID] = useState<string | null>(null);
  const [crediting, setCrediting] = useState(false);
  const recentTransactions = useRef<HTMLElement>(null);
  const receiptFocusID = query.get("receipt");

  // Settle up open form
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  const [flowFocus, setFlowFocus] = useState<{ groupID: string; currency: string; id: string }>();

  const entries = useMemo(
    () =>
      data.entries
        .filter((e) => e.groupID === g.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    [data.entries, g.id],
  );

  const me = g.members.find((m) => m.userID === user);
  const converted = useMemo(() => entries.map(settlementEntry), [entries]);
  const codes = useMemo(
    () => [...new Set([g.currency, ...converted.map((e) => e.currency)])],
    [g.currency, converted],
  );
  const projected = entries.map(homeMoney.project);
  const missingSpend = projected.some((entry, index) => !entry && entries[index].kind === "expense");
  const homeEntries = projected.filter((entry): entry is Expense => entry !== null);
  const convertedSpendIDs = useMemo(() => new Set(entries
    .filter((entry) => entry.kind === "expense" && entry.currency !== homeMoney.home)
    .map((entry) => entry.id)), [entries, homeMoney.home]);
  const foreignSpend = convertedSpendIDs.size > 0;
  const spending = breakdown(homeEntries, g.members, homeMoney.home);
  const overviewAnalytics = useMemo(
    () => analyze(entries, homeMoney.project, homeMoney.home, {}, g.members.map((m) => m.id)),
    [entries, homeMoney.project, homeMoney.home, g.members],
  );
  const overviewCategory = overviewAnalytics.categories.find((category) => category.id === query.get("cat"))?.id ?? "";
  const overviewEntries = overviewCategory
    ? overviewAnalytics.rows.filter((row) => row.category === overviewCategory).map((row) => row.entry)
    : entries;
  const overviewFilterLabel = overviewCategory ? `Filtered by ${categoryMeta(overviewCategory).label}` : "All categories";
  const spendText = (amount: number) => missingSpend ? "Rate unavailable" : homeMoney.format(amount, foreignSpend);
  const myStats = me ? spending.members.find((member) => member.id === me.id) : undefined;
  const myBalances = me ? memberBalances(entries, me.id) : {};
  const myNet = homeMoney.total(myBalances);
  const pendingCount = entries.filter((e) => e.pending && !e.handled).length;
  const myConfirmed = me ? memberBalances(entries, me.id, false) : {};
  const suggestions = codes.flatMap((currency) =>
    breakdown(converted, g.members, currency).settlements.map((transfer) => ({ ...transfer, currency })),
  );
  const openReceiptsCount = entries.filter((e) => e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length)).length;
  const openItemsCount = entries.reduce(
    (sum, e) => sum + (e.bill && !e.bill.closed ? e.bill.items.filter((i) => !i.memberIDs.length).length : 0),
    0,
  );

  const inspected = entries.find((e) => e.id === (expenseID ?? inspectID));

  function setTab(next: Tab, extra?: Record<string, string>) {
    const params = { tab: next, ...extra };
    if (expenseID) nav(`/g/${g.id}?${new URLSearchParams(params)}`, { replace: true });
    else setQuery(params, { replace: true });
  }

  if (expenseID && !inspected) return <p>Expense unavailable. <Link to={`/g/${g.id}?tab=transactions`}>Return to transactions</Link></p>;

  function exportCSV() {
    const csv = buildGroupCSV(g, entries);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-ledger.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const range = g.kind === "trip" ? tripRangeText(g.startDate, g.endDate) : "";
  const activeMembers = g.members.filter((m) => !m.removed);

  return (
    <>
      {/* Workspace Header */}
      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="page-title">{g.name}</h1>
            <span className="tag tag-primary">{g.kind === "trip" ? "Trip" : g.kind === "home" ? "Long-term" : "Friends"}</span>
            <span className="tag mono">{g.currency}</span>
            {range && <span className="tag">{range}</span>}
            {g.archived && <span className="tag tag-warn">Archived</span>}
          </div>
          <div className="page-sub">
            {g.description && <span>{g.description}</span>}
            <AvatarStack people={activeMembers} size={24} />
            <span>{activeMembers.length} active {activeMembers.length === 1 ? "person" : "people"}</span>
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-sm" onClick={exportCSV}>
            Export CSV
          </button>
          <Link className="btn btn-sm" to={`/g/${g.id}/summary`}>
            Export PDF
          </Link>
          <button type="button" className="btn btn-sm" onClick={() => setCrediting(true)}>
            + Credit
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setTab("settle")}>
            Settle up
          </button>
          <Link className="btn btn-sm btn-primary" to={`/g/${g.id}/new`}>
            + Add expense
          </Link>
        </div>
      </div>

      {/* Workspace Tabs */}
      <div className="ws-tabs">
        <div className="ws-tab-list" role="tablist">
          <button className="ws-tab" role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "analytics"} onClick={() => setTab("analytics")}>
            Analytics
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "ledger"} onClick={() => setTab("ledger")}>
            Ledger
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "transactions"} onClick={() => setTab("transactions")}>
            Transactions <span className="ws-tab-badge">{entries.length}</span>
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "receipts"} onClick={() => setTab("receipts")}>
            Receipts
            {openReceiptsCount > 0 && (
              <span className="ws-tab-badge warn">{openReceiptsCount} open</span>
            )}
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "settle"} onClick={() => setTab("settle")}>
            Settle up
            {suggestions.length > 0 && (
              <span className="ws-tab-badge">{suggestions.length}</span>
            )}
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")}>
            Members
          </button>
          <button className="ws-tab" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
            Settings
          </button>
        </div>
      </div>

      {/* TAB 1: OVERVIEW & CHARTS */}
      {tab === "overview" && (
        <div className="overview-stack">
          <div className="metric-strip" role="region" aria-label="Group summary">
            <div className="metric-cell">
              <div className="metric-label">Total group spend</div>
              <div className="metric-val num">
                {overviewAnalytics.excluded > 0 && !overviewAnalytics.priced.length
                  ? "Rate unavailable"
                  : homeMoney.format(overviewAnalytics.total, overviewAnalytics.estimated)}
              </div>
              <div className="metric-sub">
                {overviewAnalytics.rows.length} {overviewAnalytics.rows.length === 1 ? "entry" : "entries"}
                {overviewAnalytics.estimated && ` · ≈ converted to ${homeMoney.home}`}
              </div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Your total share</div>
              <div className="metric-val num">{spendText(myStats?.share ?? 0)}</div>
              <div className="metric-sub">You paid {spendText(myStats?.paid ?? 0)}</div>
            </div>
            <div className="metric-cell">
              <div className="metric-label">Your net balance</div>
              <div className={"metric-val num " + (!myNet.missing.length && myNet.amount > 0 ? "pos" : !myNet.missing.length && myNet.amount < 0 ? "neg" : "")}>
                {homeMoney.totalText(myBalances)}
              </div>
              <div className="metric-sub">
                {!myNet.missing.length && (myNet.amount > 0 ? "You are owed" : myNet.amount < 0 ? "You owe" : "All settled")}
                {pendingCount > 0 && <> · {pendingCount} pending · confirmed {homeMoney.totalText(myConfirmed, true)}</>}
              </div>
            </div>
            <button type="button" className="metric-cell metric-cell-action" onClick={() => setTab("receipts")}>
              <div className="metric-label">Unclaimed receipt items</div>
              <div className={"metric-val num " + (openReceiptsCount > 0 ? "warn" : "pos")}>
                {openItemsCount || "All claimed"}
              </div>
              <div className="metric-sub">
                {openReceiptsCount > 0
                  ? `${openReceiptsCount} open receipt${openReceiptsCount === 1 ? "" : "s"} · Review`
                  : "Every receipt item is assigned"}
              </div>
            </button>
          </div>

          <div className="overview-pair">
            <section className="card overview-card" aria-labelledby="overview-cats-title">
              <div className="card-head">
                <div>
                  <h3 id="overview-cats-title">Spending by category</h3>
                  <p className="muted card-sub">
                    {overviewAnalytics.categories.length > 0
                      ? `Net of refunds in ${homeMoney.home} · click a category to filter`
                      : `Net of refunds in ${homeMoney.home}`}
                  </p>
                </div>
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => setTab("analytics")}>
                  Analytics ›
                </button>
              </div>
              <div className="overview-card-body">
                {overviewAnalytics.excluded > 0 && !overviewAnalytics.priced.length ? (
                  <p className="muted overview-empty">Waiting for exchange rates.</p>
                ) : !overviewAnalytics.categories.length ? (
                  <p className="muted overview-empty">No spending yet. Add an expense to see the breakdown.</p>
                ) : (
                  <CategoryDonut
                    categories={overviewAnalytics.categories}
                    total={overviewAnalytics.total}
                    format={(amount) => homeMoney.format(amount, overviewAnalytics.estimated)}
                    active={overviewCategory}
                    onSelect={(id) => setTab("overview", id === overviewCategory ? undefined : { cat: id })}
                  />
                )}
              </div>
              {overviewAnalytics.excluded > 0 && (
                <div className="overview-card-foot muted">
                  {overviewAnalytics.excluded} {overviewAnalytics.excluded === 1 ? "entry has" : "entries have"} no {homeMoney.home} rate yet.
                </div>
              )}
            </section>

            <section className="overview-ledger" aria-labelledby="overview-recent-title" ref={recentTransactions} tabIndex={-1}>
              <span className="overview-filter-status" role="status">{overviewFilterLabel}</span>
              <TransactionTable
                g={g}
                key={overviewCategory}
                entries={overviewEntries}
                all={entries}
                size="compact"
                pageSize={25}
                label="Recent transactions"
                inspectedID={inspected?.id}
                onInspect={setInspectID}
                empty="No transactions yet. Add an expense to get started."
                header={
                  <>
                    <div>
                      <h3 id="overview-recent-title">Recent transactions</h3>
                      <p className="muted card-sub">{overviewFilterLabel}</p>
                    </div>
                    {overviewCategory && (
                      <button type="button" className="btn btn-xs" onClick={() => {
                        recentTransactions.current?.focus({ preventScroll: true });
                        setTab("overview");
                      }}>
                        Clear filter
                      </button>
                    )}
                  </>
                }
                viewAll={{ to: `/g/${g.id}?tab=transactions`, label: `View all ${entries.length} in ledger` }}
              />
            </section>
          </div>

          <section className="card overview-card" aria-labelledby="overview-owes-title">
            <div className="card-head">
              <div>
                <h3 id="overview-owes-title">Who owes whom</h3>
                <p className="muted card-sub">
                  {suggestions.length
                    ? `${suggestions.length} simplified ${suggestions.length === 1 ? "transfer" : "transfers"} to settle`
                    : "All balances clear"}
                </p>
              </div>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setTab("settle")}>
                Settle up ›
              </button>
            </div>
            <div className="overview-card-body overview-owes-body">
              {suggestions.length ? (
                <div className="bounded-list overview-owes-list">
                  {suggestions.map((t) => (
                    <div className="row" key={t.currency + "-" + t.from + "-" + t.to}>
                      <span className="overview-transfer-names">
                        <strong>{memberName(g, t.from)}</strong>
                        <span className="muted" aria-hidden="true"> → </span>
                        <strong>{memberName(g, t.to)}</strong>
                      </span>
                      <div className="overview-transfer-amt">
                        <b className="num">{homeMoney.totalText({ [t.currency]: t.amount })}</b>
                        {t.currency !== homeMoney.home && <div className="muted num">Pay {money(t.amount, t.currency)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted overview-empty">Everyone is settled up.</p>
              )}
            </div>
            <div className="overview-card-foot">
              <span className="muted">
                {suggestions.length
                  ? `${activeMembers.length} active ${activeMembers.length === 1 ? "member" : "members"}`
                  : "No payments needed"}
              </span>
              <button type="button" className="btn btn-xs" onClick={() => setTab("settle")}>
                Open money flow
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === "analytics" && (
        <GroupAnalytics g={g} entries={entries} inspectedID={inspected?.id} onInspect={setInspectID} />
      )}

      {tab === "overview" && <DailyCostView g={g} entries={entries} />}
      {(tab === "ledger" || tab === "transactions") && (
        <GroupLedger
          g={g} entries={entries} memberID={me?.id}
          view={tab === "ledger" ? "summary" : "transactions"}
          category={query.get("cat") ?? ""}
          onSelectCategory={(cat) => setTab("transactions", cat ? { cat } : undefined)}
          inspectedID={inspected?.id}
          onInspect={setInspectID}
        />
      )}

      {/* TAB 3: RECEIPTS HUB */}
      {tab === "receipts" && (
        <ReceiptsHub key={receiptFocusID} g={g} entries={entries} initialEntryID={receiptFocusID} />
      )}

      {/* TAB 4: SETTLE UP & MONEY FLOW GRAPH */}
      {tab === "settle" && (
        <div className="form-stack" style={{ gap: 20 }}>
          <PendingPayments group={g} />
          {codes.map((currency) => {
            const transfers = suggestions.filter((transfer) => transfer.currency === currency);
            const pendingHere = pendingView(converted, currency);
            const pendingRaw = entries.filter((e) => pendingHere.pending.some((p) => p.id === e.id));
            return (
              <div key={g.id + ":" + currency} className="form-stack" style={{ gap: 14 }}>
              <PendingSummary g={g} pending={pendingRaw} withPending={pendingHere.withPending}
                confirmedOnly={pendingHere.confirmedOnly} currency={currency} me={me?.id} />
              <div className="grid-sidebar-r">
                <MoneyFlowGraph
                  g={g} entries={entries} currency={currency} suggested={transfers}
                  focus={flowFocus?.groupID === g.id && flowFocus.currency === currency ? flowFocus : undefined}
                />

                <div className="card">
                  <div className="card-head suggested-heading">
                    <h3>Suggested Payments · {currency}</h3>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {transfers.length} transfer{transfers.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {!transfers.length ? (
                    <div className="card-pad">
                      <p className="pos" style={{ fontWeight: 600 }}>Everyone is square in {currency}.</p>
                    </div>
                  ) : (
                    <div>
                      {transfers.map((t) => {
                        const key = currency + ":" + t.from + ":" + t.to;
                        const recipient = g.members.find((m) => m.id === t.to);
                        const isOpen = settlingKey === key;
                        return (
                          <div key={key} className="suggested-payment">
                            <div className="suggested-route">
                              <strong>{memberName(g, t.from)}</strong> → <strong>{memberName(g, t.to)}</strong>
                            </div>
                            <div className="suggested-amount num">{money(t.amount, currency)}</div>
                            {pendingHere.pending.length > 0 && (() => {
                              const firm = groupConfirmed(pendingHere.confirmedOnly, t.from, t.to);
                              return <div className="muted suggested-estimate">Includes pending · confirmed only {firm ? `up to ${money(firm, currency)}` : "nothing owed"}</div>;
                            })()}
                            {currency !== homeMoney.home && (
                              <div className="muted suggested-estimate">{homeMoney.totalText({ [currency]: t.amount })} in {homeMoney.home}</div>
                            )}
                            <div className="suggested-actions">
                              <button
                                type="button"
                                className="btn btn-sm"
                                aria-label={`Show ${memberName(g, t.from)} to ${memberName(g, t.to)} on graph`}
                                onClick={() => setFlowFocus({ groupID: g.id, currency, id: transferID(t) })}
                              >
                                Show on graph
                              </button>
                              {t.from === me?.id && (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  aria-expanded={isOpen}
                                  onClick={() => setSettlingKey(isOpen ? null : key)}
                                >
                                  {isOpen ? "Close" : "Request approval"}
                                </button>
                              )}
                            </div>

                            {recipient && <PaymentOptions person={recipient} amount={t.amount} currency={currency} />}

                            {isOpen && (
                              <SettlePaymentForm
                                g={g}
                                from={t.from}
                                to={t.to}
                                amount={t.amount}
                                currency={currency}
                                open={codes}
                                pending={pendingHere.pending.length}
                                onDone={() => setSettlingKey(null)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              </div>
            );
          })}


          {/* Recorded Settlement History */}
          {entries.some((e) => e.kind === "settlement") && (
            <div className="card">
              <div className="card-head">
                <h3>Recorded Payments</h3>
              </div>
              <div className="bounded-list">
              {entries
                .filter((e) => e.kind === "settlement")
                .map((e) => (
                  <div className="row" key={e.id}>
                    <div>
                      <strong>
                        {memberName(g, e.paidBy)} → {memberName(g, e.splits[0]?.memberID ?? "")}
                      </strong>
                      <div className="muted" style={{ fontSize: 12 }}>{dateText(e.createdAt)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <b className="num pos">{homeMoney.entry(e)}</b>
                      {e.currency !== homeMoney.home && <div className="muted">Sent {money(e.amount, e.currency)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "members" && <GroupMembers key={g.id} group={g} entries={entries} />}
      {tab === "settings" && <GroupSettings key={g.id} g={g} showRates={selectedTab === "rates"} />}

      {crediting && (
        <div className="drawer-backdrop" onClick={() => setCrediting(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Record a credit"
            onKeyDown={(event) => { if (event.key === "Escape") setCrediting(false); }}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 15, fontWeight: 700 }}>Record a credit</h3>
              <button className="btn btn-sm btn-ghost" onClick={() => setCrediting(false)} aria-label="Close">✕</button>
            </div>
            <div className="drawer-body">
              <RefundForm g={g} entries={entries} onDone={() => setCrediting(false)} onCancel={() => setCrediting(false)} />
              <p className="muted" style={{ fontSize: 12.5 }}>To refund a specific expense, open it and choose Refund….</p>
            </div>
          </aside>
        </div>
      )}

      {/* Slide-over Expense Inspector */}
      {inspected && (
        <ExpenseDrawer
          key={inspected.id}
          g={g}
          entry={inspected}
          entries={entries}
          onInspect={(id) => {
            if (expenseID) nav(`/g/${g.id}/e/${id}`, { replace: true });
            else setInspectID(id);
          }}
          onClose={() => {
            setInspectID(null);
            if (expenseID) setTab("transactions");
          }}
          onOpenReceipt={(id) => {
            setInspectID(null);
            setTab("receipts", { receipt: id });
          }}
        />
      )}

    </>
  );
}
