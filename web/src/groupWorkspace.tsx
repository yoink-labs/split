import { memberBalances, useHomeMoney } from "./homeMoney";
import { PendingPayments } from "./settlements";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CATEGORIES, categoryMeta } from "./categories";
import { CategoryChart, MoneyFlowGraph, PaidVsShareChart, TimelineChart } from "./charts";
import { Form, useLedger, value } from "./context";
import {
  balances,
  breakdown,
  buildGroupCSV,
  dateText,
  dayHeading,
  entryPayers,
  memberName,
  memberPath,
  minor,
  money,
  monthHeading,
  settlementEntry,
  shortDate,
  stamp,
  tripRangeText,
  type ActiveInvite,
  type Expense,
  type ExpenseComment,
  type Group,
  type Person,
} from "./data";
import { convert, fx, rateE8, rateInput, rateText, sourceLabel, useRates, type Exchange } from "./fx";
import { CurrencySelect, RateField } from "./fxui";
import { ReceiptsHub } from "./receiptsHub";
import { Avatar, AvatarStack, BalanceBadge, CategoryIcon } from "./ui";

type Tab = "overview" | "ledger" | "receipts" | "settle" | "people" | "rates";
const tabs = new Set<string>(["overview", "ledger", "receipts", "settle", "people", "rates"]);

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
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Expense details">
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

function TripRates({ group, canEdit }: { group: Group; canEdit: boolean }) {
  const { save } = useLedger();
  const [currency, setCurrency] = useState(() => Object.keys(group.tripRates ?? {})[0] ?? (group.currency === "USD" ? "EUR" : "USD"));
  const rates = Object.entries(group.tripRates ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const current = group.tripRates?.[currency];

  return (
    <section className="card card-pad trip-rates" aria-labelledby="trip-rates-title">
      <h2 id="trip-rates-title">Trip exchange rates</h2>
      <p className="muted">Set a default for each currency you spend in. Each expense can use its own rate, and saved expenses keep the rate they used.</p>
      {canEdit && (
        <Form
          key={currency + "|" + (current ?? "")}
          label="Save trip rate"
          submit={async (form) => {
            const input = value(form, "rate");
            const rate = rateE8(input);
            if (input && !rate) throw new Error("Enter a positive exchange rate.");
            await save(`/v1/groups/${group.id}/trip-rate`, { currency, target: group.currency, rateE8: rate });
          }}
        >
          <div className="form-row">
            <CurrencySelect label="Expense currency" value={currency} onChange={setCurrency} exclude={group.currency} />
            <label className="field">
              {group.currency} per 1 {currency}
              <input type="text" name="rate" inputMode="decimal"
                defaultValue={current ? rateInput(current) : ""} />
              <small>Clear the rate and save to use published rates again.</small>
            </label>
          </div>
        </Form>
      )}
      {rates.length > 0 && (
        <ul className="trip-rate-list">
          {rates.map(([code, rate]) => (
            <li key={code} className="num">
              {canEdit ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCurrency(code)} aria-label={`Edit ${code} trip rate`}>
                1 {code} = {rateText(rate)} {group.currency}
              </button> : <>1 {code} = {rateText(rate)} {group.currency}</>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function GroupWorkspace() {
  const { data } = useLedger();
  const { gid, eid } = useParams();
  const g = data.groups.find((x) => x.id === gid);
  return g ? <Workspace key={g.id} g={g} expenseID={eid} /> : <p>Group unavailable.</p>;
}

function Workspace({ g, expenseID }: { g: Group; expenseID?: string }) {
  const { data, user, request, save } = useLedger();
  const nav = useNavigate();
  const [query, setQuery] = useSearchParams();

  const selectedTab = query.get("tab") ?? "";
  const tab = expenseID ? "ledger" : tabs.has(selectedTab) && (selectedTab !== "rates" || g.kind === "trip") ? selectedTab as Tab : "overview";
  const homeMoney = useHomeMoney();

  // Ledger filters
  const [search, setSearch] = useState("");
  const filterCat = query.get("cat") ?? "";
  const [filterPayer, setFilterPayer] = useState("");
  const [filterPerson, setFilterPerson] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "receipt" | "open" | "recurring">("all");
  const [inspectID, setInspectID] = useState<string | null>(null);
  const receiptFocusID = query.get("receipt");

  // Settle up open form
  const [settlingKey, setSettlingKey] = useState<string | null>(null);

  // People & Invites state
  const [invites, setInvites] = useState<ActiveInvite[]>([]);
  const [newInviteURL, setNewInviteURL] = useState("");
  const [memberModal, setMemberModal] = useState<Person | null>(null);
  const [memberErr, setMemberErr] = useState("");
  const [matches, setMatches] = useState<{ userID: string; name: string }[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    if (tab !== "people") return;
    let alive = true;
    request<{ invites: ActiveInvite[] }>(`/v1/groups/${g.id}/invites`)
      .then((res) => {
        if (alive) setInvites(res.invites ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [g, tab, request]);

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
  const foreignSpend = entries.some((entry) => entry.kind === "expense" && entry.currency !== homeMoney.home);
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

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !e.title.toLowerCase().includes(q) && !(e.notes ?? "").toLowerCase().includes(q) && !(e.category ?? "").toLowerCase().includes(q))
        return false;
      if (filterCat && (e.category ?? "Other") !== filterCat) return false;
      if (filterPayer && !entryPayers(e).some((p) => p.memberID === filterPayer)) return false;
      if (filterPerson && !e.splits.some((s) => s.memberID === filterPerson) && !entryPayers(e).some((p) => p.memberID === filterPerson))
        return false;
      if (filterStatus === "receipt" && !e.bill && !e.receiptIDs?.length) return false;
      if (filterStatus === "open" && !(e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length)))
        return false;
      if (filterStatus === "recurring" && !e.recurrence) return false;
      return true;
    });
  }, [entries, search, filterCat, filterPayer, filterPerson, filterStatus]);

  const groupedLedger = useMemo(() => {
    const byDay = g.kind === "trip";
    const map = new Map<string, Expense[]>();
    for (const e of filteredEntries) {
      const k = byDay ? e.createdAt.slice(0, 10) : e.createdAt.slice(0, 7);
      const list = map.get(k) ?? [];
      list.push(e);
      map.set(k, list);
    }
    return [...map.entries()];
  }, [filteredEntries, g.kind]);

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
          {g.kind === "trip" && (
            <button className="ws-tab" role="tab" aria-selected={tab === "rates"} onClick={() => setTab("rates")}>
              Exchange rates
            </button>
          )}
          <button className="ws-tab" role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}>
            People & Settings
          </button>
        </div>
      </div>

      {/* TAB 1: OVERVIEW & CHARTS */}
      {tab === "overview" && (
        <div className="form-stack" style={{ gap: 18 }}>
          <div className="kpi-grid">
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
          {missingSpend ? <p className="muted">Spending charts are unavailable until all exchange rates are available.</p> : <div className="grid-2">
            <PaidVsShareChart
              g={g}
              entries={homeEntries}
              currency={homeMoney.home}
              onSelectMember={(mid) => nav(memberPath(g, mid))}
            />
            <CategoryChart
              entries={homeEntries}
              currency={homeMoney.home}
              onSelectCategory={(cat) => setTab("ledger", { cat })}
            />
          </div>}

          <div className="grid-sidebar-r">
            {!missingSpend && <TimelineChart g={g} entries={homeEntries} currency={homeMoney.home} />}
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

      {/* TAB 2: LEDGER */}
      {tab === "ledger" && (
        <>
          <div className="filter-bar">
            <input
              type="search"
              placeholder="Search title, notes, category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={filterCat} onChange={(e) => setTab("ledger", e.target.value ? { cat: e.target.value } : undefined)} aria-label="Filter by category">
              <option value="">All categories</option>
              {[...new Set([...CATEGORIES.map((c) => c.id), ...entries.map((e) => e.category ?? "Other")])].map((cat) => (
                <option key={cat} value={cat}>{categoryMeta(cat).label}</option>
              ))}
            </select>
            <select value={filterPayer} onChange={(e) => setFilterPayer(e.target.value)} aria-label="Filter by payer">
              <option value="">Any payer</option>
              {g.members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select value={filterPerson} onChange={(e) => setFilterPerson(e.target.value)} aria-label="Filter by participant">
              <option value="">Any person</option>
              {g.members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)} aria-label="Filter by status">
              <option value="all">All items</option>
              <option value="open">Needs claiming</option>
              <option value="receipt">Has receipt</option>
              <option value="recurring">Recurring</option>
            </select>
            {(search || filterCat || filterPayer || filterPerson || filterStatus !== "all") && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => {
                  setSearch("");
                  setTab("ledger");
                  setFilterPayer("");
                  setFilterPerson("");
                  setFilterStatus("all");
                }}
              >
                Clear
              </button>
            )}
          </div>

          {!groupedLedger.length ? (
            <div className="card card-pad" style={{ textAlign: "center", padding: "40px 20px" }}>
              <p className="muted">No matching expenses.</p>
            </div>
          ) : (
            groupedLedger.map(([bucket, items]) => {
              const bucketTotal = items.some((entry) => entry.kind === "expense") ? homeMoney.spend(items) : "";
              return (
                <div className="day-group" key={bucket}>
                  <div className="day-heading">
                    <span>{g.kind === "trip" ? dayHeading(bucket) : monthHeading(bucket)}</span>
                    <span className="num">{bucketTotal}</span>
                  </div>
                  <div className="ledger-list">
                    {items.map((e) => {
                      const payers = entryPayers(e);
                      const isSettle = e.kind === "settlement";
                      const open = e.bill && !e.bill.closed ? e.bill.items.filter((i) => !i.memberIDs.length).length : 0;
                      const myPaid = me ? payers.filter((p) => p.memberID === me.id).reduce((s, p) => s + p.amount, 0) : 0;
                      const myShare = me ? e.splits.find((s) => s.memberID === me.id)?.amount ?? 0 : 0;
                      const myDelta = e.handled ? 0 : myPaid - myShare;
                      const participants = e.splits
                        .map((s) => g.members.find((m) => m.id === s.memberID))
                        .filter((m): m is Person => Boolean(m));
                      return (
                        <button
                          key={e.id}
                          type="button"
                          className={"ledger-item" + (inspectID === e.id ? " selected" : "")}
                          onClick={() => setInspectID(e.id)}
                        >
                          <CategoryIcon category={e.category} settlement={isSettle} />
                          <div style={{ minWidth: 0 }}>
                            <div className="ledger-title">
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {isSettle
                                  ? `${memberName(g, e.paidBy)} → ${memberName(g, e.splits[0]?.memberID ?? "")}`
                                  : e.title}
                              </span>
                              {e.handled && <span className="tag tag-pos">Handled</span>}
                              {open > 0 && <span className="tag tag-warn">{open} open</span>}
                              {!open && (e.bill || e.receiptIDs?.length) && <span className="tag">Receipt</span>}
                              {e.recurrence && <span className="tag tag-primary">{e.recurrence}</span>}
                            </div>
                            <div className="ledger-meta">
                              <span>
                                {payers.length > 1
                                  ? `${payers.length} payers`
                                  : `${memberName(g, e.paidBy)} paid`}
                              </span>
                              {e.notes && <span>· {e.notes.slice(0, 48)}{e.notes.length > 48 ? "…" : ""}</span>}
                              {(e.commentCount ?? 0) > 0 && <span>· 💬 {e.commentCount}</span>}
                            </div>
                          </div>

                          <div className="ledger-hide-sm">
                            <AvatarStack people={participants} max={4} size={22} />
                          </div>

                          <div className="ledger-amount ledger-hide-sm">
                            <strong className={myDelta > 0 ? "pos" : myDelta < 0 ? "neg" : "muted"}>
                              {isSettle
                                ? "payment"
                                : e.handled
                                  ? "handled"
                                : myDelta === 0
                                  ? "not involved"
                                  : (myDelta > 0 ? "+" : "−") + homeMoney.entry(e, Math.abs(myDelta))}
                            </strong>
                            <small>{!isSettle && myDelta !== 0 ? (myDelta > 0 ? "you lent" : "your share") : ""}</small>
                          </div>

                          <div className="ledger-amount">
                            <strong>{homeMoney.entry(e)}</strong>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </>
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
            const stats = breakdown(converted, g.members, currency);
            return (
              <div key={currency} className="grid-sidebar-r">
                <MoneyFlowGraph g={g} entries={entries} currency={currency} />

                <div className="card">
                  <div className="card-head">
                    <h3>Suggested Payments · {currency}</h3>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {stats.settlements.length} transfer{stats.settlements.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {!stats.settlements.length ? (
                    <div className="card-pad">
                      <p className="pos" style={{ fontWeight: 600 }}>Everyone is square in {currency}.</p>
                    </div>
                  ) : (
                    <div>
                      {stats.settlements.map((t) => {
                        const key = currency + ":" + t.from + ":" + t.to;
                        const recipient = g.members.find((m) => m.id === t.to);
                        const pay = recipient?.payment;
                        const isOpen = settlingKey === key;
                        return (
                          <div key={key} style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                              <div>
                                <div style={{ fontSize: 13.5 }}>
                                  <strong>{memberName(g, t.from)}</strong> → <strong>{memberName(g, t.to)}</strong>
                                </div>
                                <div className="num" style={{ fontSize: 16, fontWeight: 750, marginTop: 2 }}>
                                  {homeMoney.totalText({ [currency]: t.amount })}
                                  {currency !== homeMoney.home && <small className="muted"> · Pay {money(t.amount, currency)}</small>}
                                </div>
                              </div>
                              {t.from === me?.id && (
                                <button
                                  className="btn btn-sm btn-primary"
                                  onClick={() => setSettlingKey(isOpen ? null : key)}
                                >
                                  {isOpen ? "Close" : "Request approval"}
                                </button>
                              )}
                            </div>

                            {pay && (pay.venmo || pay.paypal || pay.mercado || pay.alias) && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                                {pay.venmo && (
                                  <a className="btn btn-xs" href={`https://venmo.com/${pay.venmo}`} target="_blank" rel="noreferrer">
                                    Venmo @{pay.venmo}
                                  </a>
                                )}
                                {pay.paypal && (
                                  <a className="btn btn-xs" href={`https://paypal.me/${pay.paypal}/${(t.amount / 100).toFixed(2)}${currency}`} target="_blank" rel="noreferrer">
                                    PayPal.me/{pay.paypal}
                                  </a>
                                )}
                                {pay.mercado && (
                                  <a className="btn btn-xs" href={pay.mercado} target="_blank" rel="noreferrer">
                                    Mercado Pago
                                  </a>
                                )}
                                {pay.alias && (
                                  <button
                                    type="button"
                                    className="btn btn-xs mono"
                                    onClick={() => void navigator.clipboard?.writeText(pay.alias!)}
                                  >
                                    Copy alias: {pay.alias}
                                  </button>
                                )}
                              </div>
                            )}

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

      {tab === "rates" && <TripRates key={g.id} group={g} canEdit={activeMembers.some((m) => m.userID === user)} />}

      {/* People, invites and settings */}
      {tab === "people" && (
        <div className="form-stack" style={{ gap: 20 }}>
          {/* People Grid */}
          <div className="card">
            <div className="card-head">
              <h3>Members ({g.members.length})</h3>
              <span className="muted" style={{ fontSize: 12 }}>
                Click any person for their full breakdown
              </span>
            </div>
            <div>
              {g.members.map((m) => {
                const st = spending.members.find((x) => x.id === m.id);
                const amounts = memberBalances(entries, m.id);
                const net = homeMoney.total(amounts);
                const isMe = m.userID === user;
                return (
                  <div className="row" key={m.id}>
                    <Link
                      to={memberPath(g, m.id)}
                      style={{ display: "flex", alignItems: "center", gap: 11, color: "var(--ink)", minWidth: 0, flex: 1 }}
                    >
                      <Avatar name={m.name} avatarURL={m.avatarURL} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <strong>{m.name}</strong>
                          {isMe && <span className="tag tag-primary">You</span>}
                          {!m.userID && <span className="tag">Placeholder</span>}
                          {m.removed && <span className="tag tag-warn">Archived entity</span>}
                        </div>
                        <div className="muted num" style={{ fontSize: 12 }}>
                          Paid {spendText(st?.paid ?? 0)} · Share {spendText(st?.share ?? 0)}
                        </div>
                      </div>
                    </Link>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <BalanceBadge amount={net.amount} currency={homeMoney.home} display={Object.values(amounts).some(Boolean) ? homeMoney.totalText(amounts, true) : undefined} />
                      {!isMe && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() => {
                            setMemberErr("");
                            setMemberModal(m);
                          }}
                        >
                          {m.removed ? "Restore" : "Remove"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Add Person & Active Invites */}
          <div className="grid-2">
            <div className="card card-pad">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Add a person</h3>
              <Form
                label="Add placeholder"
                submit={async (f) => {
                  await save(`/v1/groups/${g.id}/members`, {
                    id: crypto.randomUUID(),
                    name: value(f, "person"),
                    email: value(f, "email"),
                  });
                }}
              >
                <label className="field">
                  Name (works even if they don’t have Split)
                  <input type="text" name="person" required maxLength={60} placeholder="Jordan" />
                </label>
                <label className="field">
                  Email (optional — auto-links if they sign up)
                  <input type="email" name="email" placeholder="jordan@example.com" />
                </label>
              </Form>
              <Form
                label="Search Split"
                submit={async (f) => {
                  setSearchError("");
                  setMatches(await request<{ userID: string; name: string }[]>("/v1/people/search", { query: value(f, "query") }));
                }}
              >
                <label className="field">
                  Exact email, username, or shared contact
                  <input name="query" required maxLength={254} />
                </label>
              </Form>
              {matches?.length === 0 && <p className="muted">No matches.</p>}
              {searchError && <p className="error-banner" role="alert">{searchError}</p>}
              {matches?.map((person) => (
                <button
                  className="btn"
                  type="button"
                  key={person.userID}
                  disabled={g.members.some((m) => m.userID === person.userID)}
                  onClick={async () => {
                    setSearchError("");
                    try {
                      await save(`/v1/groups/${g.id}/members`, { id: crypto.randomUUID(), ...person });
                      setMatches(null);
                    } catch (error) {
                      setSearchError(error instanceof Error ? error.message : "Could not add this person.");
                    }
                  }}
                >
                  Add {person.name}
                </button>
              ))}
            </div>

            <div className="card card-pad">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Invites ({invites.length} active)</h3>
              <Form
                label="Create invite link"
                submit={async (f) => {
                  const memberID = value(f, "member");
                  const res = await request<{ url: string; code: string }>(`/v1/groups/${g.id}/invites`, memberID ? { memberID } : {});
                  setNewInviteURL(res.url);
                  const refreshed = await request<{ invites: ActiveInvite[] }>(`/v1/groups/${g.id}/invites`);
                  setInvites(refreshed.invites ?? []);
                }}
              >
                <label className="field">
                  Invite target
                  <select name="member">
                    <option value="">General group link (anyone)</option>
                    {g.members.filter((m) => !m.userID && !m.removed).map((m) => (
                      <option key={m.id} value={m.id}>
                        Claim placeholder: {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </Form>

              {newInviteURL && (
                <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                  <input type="text" readOnly value={newInviteURL} style={{ flex: 1 }} className="mono" />
                  <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(newInviteURL)}>
                    Copy
                  </button>
                </div>
              )}

              {invites.length > 0 && (
                <div className="panel" style={{ marginTop: 14 }}>
                  {invites.map((inv) => (
                    <div className="row" key={inv.id} style={{ padding: "8px 12px" }}>
                      <div>
                        <strong style={{ fontSize: 12.5 }}>
                          {inv.kind === "member" ? `For ${inv.memberName}` : "General group invite"}
                        </strong>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger"
                        onClick={async () => {
                          await request(`/v1/groups/${g.id}/invites/${inv.id}/revoke`, {});
                          setInvites((list) => list.filter((x) => x.id !== inv.id));
                        }}
                      >
                        Delete invite
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Group Settings & Payment Handles */}
          <div className="grid-2">
            <div className="card card-pad">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Trip & Group Details</h3>
              <Form
                label="Save group details"
                submit={async (f) => {
                  await save(`/v1/groups/${g.id}/update`, {
                    name: value(f, "name"),
                    description: value(f, "description"),
                    startDate: value(f, "startDate") || null,
                    endDate: value(f, "endDate") || null,
                  });
                  setSettingsSaved(true);
                  setTimeout(() => setSettingsSaved(false), 2000);
                }}
              >
                <label className="field">
                  Name
                  <input type="text" name="name" defaultValue={g.name} required maxLength={80} />
                </label>
                <label className="field">
                  Description
                  <textarea name="description" defaultValue={g.description ?? ""} maxLength={400} placeholder="Notes about this trip or household…" />
                </label>
                <div className="form-row">
                  <label className="field">
                    Start date
                    <input type="date" name="startDate" defaultValue={g.startDate ?? ""} />
                  </label>
                  <label className="field">
                    End date
                    <input type="date" name="endDate" defaultValue={g.endDate ?? ""} />
                  </label>
                </div>
                {settingsSaved && <p className="ok-banner">Saved group details</p>}
              </Form>
            </div>

            <div className="card card-pad">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Your Payment Handles (for Settle Up)</h3>
              <Form
                label="Save payment handles"
                submit={async (f) => {
                  await save(`/v1/groups/${g.id}/payment-profile`, {
                    venmo: value(f, "venmo") || undefined,
                    paypal: value(f, "paypal") || undefined,
                    mercado: value(f, "mercado") || undefined,
                    alias: value(f, "alias") || undefined,
                  });
                }}
              >
                <div className="form-row">
                  <label className="field">
                    Venmo username
                    <input type="text" name="venmo" defaultValue={me?.payment?.venmo ?? ""} placeholder="harris-k" />
                  </label>
                  <label className="field">
                    PayPal.Me username
                    <input type="text" name="paypal" defaultValue={me?.payment?.paypal ?? ""} placeholder="harrisk" />
                  </label>
                </div>
                <label className="field">
                  Argentine Alias / CVU
                  <input type="text" name="alias" defaultValue={me?.payment?.alias ?? ""} placeholder="harris.split.mp" />
                </label>
                <label className="field">
                  Mercado Pago link
                  <input type="text" name="mercado" defaultValue={me?.payment?.mercado ?? ""} placeholder="https://link.mercadopago.com.ar/..." />
                </label>
              </Form>
            </div>
          </div>
        </div>
      )}

      {/* Slide-over Expense Inspector */}
      {inspected && (
        <ExpenseDrawer
          g={g}
          entry={inspected}
          onClose={() => {
            setInspectID(null);
            if (expenseID) setTab("ledger");
          }}
          onOpenReceipt={(id) => {
            setInspectID(null);
            setTab("receipts", { receipt: id });
          }}
        />
      )}

      {/* Member Remove / Retain as Entity Modal */}
      {memberModal && (
        <div className="modal-backdrop" onClick={() => setMemberModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
              {memberModal.removed ? `Restore ${memberModal.name}` : `Remove ${memberModal.name}`}
            </h3>
            {memberModal.removed ? (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
                  {memberModal.name} is currently retained as a historical entity. Restoring them adds them back to new expense defaults.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => setMemberModal(null)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "restore" });
                      setMemberModal(null);
                    }}
                  >
                    Restore member
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
                  Choose whether to <strong>retain {memberModal.name} as an archived entity</strong> (keeps past charges and balances intact, hides them from new splits) or <strong>permanently delete</strong> them (if they cancelled before any expenses).
                </p>
                {memberErr && <p className="error-banner" style={{ marginBottom: 12 }}>{memberErr}</p>}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "archive" });
                      setMemberModal(null);
                    }}
                  >
                    Retain as archived entity (keep history)
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      try {
                        setMemberErr("");
                        await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "delete" });
                        setMemberModal(null);
                      } catch (e) {
                        setMemberErr(e instanceof Error ? e.message : "Could not delete member.");
                      }
                    }}
                  >
                    Delete permanently (only if 0 expenses)
                  </button>
                  <button className="btn btn-ghost" onClick={() => setMemberModal(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
