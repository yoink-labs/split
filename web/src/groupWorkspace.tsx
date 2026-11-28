import { PaymentOptions } from "./paymentMethods";
import { memberBalances, useHomeMoney } from "./homeMoney";
import { PendingPayments } from "./settlements";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PaidVsShareChart } from "./charts";
import { SpendingDashboard } from "./spending";
import { Form, useLedger, value } from "./context";
import {
  balances,
  breakdown,
  buildGroupCSV,
  dateText,
  entryPayers,
  memberName,
  memberPath,
  minor,
  money,
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

import { GroupLedger, type LedgerView } from "./groupLedger";
import { GroupMembers } from "./groupMembers";
import { GroupSettings } from "./groupSettings";
import "./groupWorkspace.css";

const tabs = ["overview", "ledger", "receipts", "settle", "members", "settings"] as const;
type Tab = typeof tabs[number];

function ExpenseDrawer({
  g,
  entry,
  onClose,
  onOpenReceipt,
}: {
  g: Group;
  entry: Expense;
  onClose: () => void;
  onOpenReceipt: (id: string) => void;
}) {
  const { request, save, user } = useLedger();
  const homeMoney = useHomeMoney();
  const nav = useNavigate();
  const [comments, setComments] = useState<ExpenseComment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [handledBusy, setHandledBusy] = useState(false);
  const [handledError, setHandledError] = useState("");
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

  const payers = entryPayers(entry);
  const canSetHandled = entry.kind === "expense" && payers.some((payer) =>
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
    if (!confirm(`Delete "${entry.title}"? This updates everyone’s balances.`)) return;
    const { editable: _ed, recurrence: _rec, commentCount: _cc, likeCount: _lc, likedByMe: _lm, receiptIDs: _ri, ...orig } = entry;
    await save(`/v1/entries/${entry.id}/delete`, { original: orig });
    onClose();
  }

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
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {/* Amount & FX summary */}
          <div className="card card-pad" style={{ background: "var(--bg)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" }} className="num">
                {homeMoney.entry(entry)}
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
            {entry.exchange && (
              <p style={{ marginTop: 8, fontSize: 12.5, color: "var(--ink-2)" }}>
                {entry.exchange.source === "Statement" ? "Statement charge" : "Settles as"} <b className="num">{money(settlementEntry(entry).amount, entry.exchange.target)}</b>{" "}
                <span className="muted">
                  at 1 {entry.currency} ≈ {rateText(entry.exchange.rateE8)} {entry.exchange.target} (
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

          {/* Receipt callout */}
          {(entry.bill || (entry.receiptIDs && entry.receiptIDs.length > 0)) && (
            <div className="card card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <strong style={{ fontSize: 13.5 }}>
                  {entry.bill ? "Itemized receipt" : "Receipt photo attached"}
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
              {entry.kind === "settlement" ? "Paid by" : payers.length > 1 ? "Paid by (Multiple payers)" : "Paid by"}
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
              {entry.kind === "settlement" ? "Paid to" : `Split with (${entry.splitMode})`}
            </h4>
            <div className="panel">
              {entry.splits.map((s) => {
                const m = g.members.find((x) => x.id === s.memberID);
                return (
                  <Link className="row" key={s.memberID} to={memberPath(g, s.memberID)} onClick={onClose}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <Avatar name={m?.name ?? "?"} avatarURL={m?.avatarURL} size={26} />
                      <strong style={{ fontSize: 13.5, color: "var(--ink)" }}>{m?.name ?? "Member"}</strong>
                    </span>
                    <b className="num" style={{ color: "var(--ink)" }}>{homeMoney.portion(entry, s.memberID)}</b>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Recurring schedule for ordinary fixed-currency expenses */}
          {entry.editable && entry.kind === "expense" && !entry.bill && !entry.exchange && (
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

function SettlePaymentForm({
  g,
  from,
  to,
  amount: owed,
  currency: owedIn,
  open,
  onDone,
}: {
  g: Group;
  from: string;
  to: string;
  amount: number;
  currency: string;
  open: string[];
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
  const tab = expenseID ? "ledger" : selectedTab === "people" || selectedTab === "rates"
    ? "settings" : tabs.find((item) => item === selectedTab) ?? "overview";
  const ledgerView: LedgerView = expenseID || query.get("view") === "transactions" || (!query.has("view") && query.has("cat"))
    ? "transactions" : "summary";
  const homeMoney = useHomeMoney();

  const [inspectID, setInspectID] = useState<string | null>(null);
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
  const spendText = (amount: number) => missingSpend ? "Rate unavailable" : homeMoney.format(amount, foreignSpend);
  const myStats = me ? spending.members.find((member) => member.id === me.id) : undefined;
  const myBalances = me ? memberBalances(entries, me.id) : {};
  const myNet = homeMoney.total(myBalances);
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

  if (expenseID && !inspected) return <p>Expense unavailable. <Link to={`/g/${g.id}?tab=ledger`}>Return to the ledger</Link></p>;

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

  const range = tripRangeText(g.startDate, g.endDate);
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
          <Link className="btn btn-sm" to={`/g/${g.id}/summary`} title="Printable summary you can save as PDF">
            Summary PDF
          </Link>
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
          <button className="ws-tab" role="tab" aria-selected={tab === "ledger"} onClick={() => setTab("ledger")}>
            Ledger <span className="ws-tab-badge">{entries.length}</span>
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
        <div className="form-stack" style={{ gap: 18 }}>
          <div className="kpi-grid group-kpis">
            <div className="kpi">
              <div className="kpi-label">Total group spend</div>
              <div className="kpi-val">{spendText(spending.total)}</div>
              <div className="kpi-sub">
                {entries.filter((e) => e.kind === "expense").length} expenses

              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Your total share</div>
              <div className="kpi-val">{spendText(myStats?.share ?? 0)}</div>
              <div className="kpi-sub">You paid {spendText(myStats?.paid ?? 0)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Your net balance</div>
              <div className={"kpi-val " + (!myNet.missing.length && myNet.amount > 0 ? "pos" : !myNet.missing.length && myNet.amount < 0 ? "neg" : "")}>
                {homeMoney.totalText(myBalances)}
              </div>
              <div className="kpi-sub">
                {!myNet.missing.length && (myNet.amount > 0 ? "You are owed" : myNet.amount < 0 ? "You owe" : "")}
              </div>
            </div>
            <button type="button" className="kpi kpi-action" onClick={() => setTab("receipts")}>
              <div className="kpi-label">Unclaimed receipt items</div>
              <div className={"kpi-val " + (openReceiptsCount > 0 ? "warn" : "pos")}>
                {openItemsCount || "All claimed"}
              </div>
              <div className="kpi-sub">
                {openReceiptsCount > 0
                  ? `${openReceiptsCount} open receipt${openReceiptsCount === 1 ? "" : "s"} → Review`
                  : "Every receipt item is assigned"}
              </div>
            </button>
          </div>

          {foreignSpend && <p className="muted">Spending in {homeMoney.home} uses estimated exchange rates.</p>}
          {missingSpend ? <p className="muted">Spending charts are unavailable until all exchange rates are available.</p> : (
            <SpendingDashboard group={g} entries={homeEntries} currency={homeMoney.home}
              convertedIDs={convertedSpendIDs} format={homeMoney.format} onOpenEntry={(entry) => setInspectID(entry.id)} />
          )}

          <div className="grid-2">
            {!missingSpend && <PaidVsShareChart g={g} entries={homeEntries} currency={homeMoney.home} convertedIDs={convertedSpendIDs}
              onSelectMember={(mid) => nav(memberPath(g, mid))} />}
            <div className="card">
              <div className="card-head">
                <h3>Who owes whom</h3>
                <button className="btn btn-xs btn-ghost" onClick={() => setTab("settle")}>
                  Full graph ›
                </button>
              </div>
              {suggestions.length ? (
                <div>
                  {suggestions.map((t) => (
                    <div className="row" key={t.currency + "-" + t.from + "-" + t.to}>
                      <span style={{ fontSize: 13 }}>
                        <strong>{memberName(g, t.from)}</strong> → <strong>{memberName(g, t.to)}</strong>
                      </span>
                      <div style={{ textAlign: "right" }}>
                        <b className="num">{homeMoney.totalText({ [t.currency]: t.amount })}</b>
                        {t.currency !== homeMoney.home && <div className="muted">Pay {money(t.amount, t.currency)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card-pad">
                  <p className="muted" style={{ fontSize: 13 }}>Everyone is settled up.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "ledger" && (
        <GroupLedger
          g={g} entries={entries} memberID={me?.id}
          view={ledgerView}
          category={query.get("cat") ?? ""}
          onView={(view, cat) => setTab("ledger", { view, ...(cat ? { cat } : {}) })}
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
            return (
              <div key={g.id + ":" + currency} className="grid-sidebar-r">
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
            );
          })}


          {/* Recorded Settlement History */}
          {entries.some((e) => e.kind === "settlement") && (
            <div className="card">
              <div className="card-head">
                <h3>Recorded Payments</h3>
              </div>
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
          )}
        </div>
      )}

      {tab === "members" && <GroupMembers key={g.id} group={g} entries={entries} />}
      {tab === "settings" && <GroupSettings g={g} showRates={selectedTab === "rates"} />}

      {/* Slide-over Expense Inspector */}
      {inspected && (
        <ExpenseDrawer
          g={g}
          entry={inspected}
          onClose={() => {
            setInspectID(null);
            if (expenseID) setTab("ledger", { view: "transactions" });
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
