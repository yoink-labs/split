import { FormPicker, Picker } from "./picker";
import { DiscoverySetting } from "./people";
import { PaymentEditor, PaymentOptions, personPaymentMethods } from "./paymentMethods";
import { PendingPayments } from "./settlements";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AVATAR_PRESETS } from "./categories";
import { DEFAULT_PALETTE, PALETTES, readAppearance, saveAppearance, type Appearance, type Mode } from "./appearance";
import { Form, useLedger, value } from "./context";
import {
  balances,
  currencies,
  entryPayers,
  memberEntries,
  memberName,
  memberPath,
  membersGroups,
  money,
  settlementEntry,
  shortDate,
  tripRangeText,
  type Expense,
  type Group,
} from "./data";
import { fx, useHomeCurrency } from "./fx";
import { memberBalances, useHomeMoney } from "./homeMoney";
import { Avatar, AvatarStack, BalanceBadge, CategoryIcon, EmptyState, TIP_URL } from "./ui";

export function HomeOverview() {
  const { data, user } = useLedger();
  const [target] = useHomeCurrency();
  const homeMoney = useHomeMoney();
  const activeGroups = data.groups.filter((group) => !group.archived);
  const owed: Record<string, number> = {};
  const owe: Record<string, number> = {};

  for (const g of activeGroups) {
    const me = g.members.find((p) => p.userID === user);
    if (!me) continue;
    const entries = data.entries.filter((e) => e.groupID === g.id);
    for (const currency of new Set(entries.map((entry) => settlementEntry(entry).currency))) {
      const amount = balances(entries, currency)[me.id] ?? 0;
      if (amount > 0) owed[currency] = (owed[currency] ?? 0) + amount;
      if (amount < 0) owe[currency] = (owe[currency] ?? 0) - amount;
    }
  }

  const incoming = fx.total(owed, target);
  const outgoing = fx.total(owe, target);
  const incomingApproximate = Object.keys(owed).some((currency) => currency !== target);
  const outgoingApproximate = Object.keys(owe).some((currency) => currency !== target);
  const approximate = incomingApproximate || outgoingApproximate;
  const missing = incoming.missing.length > 0 || outgoing.missing.length > 0;
  const net = incoming.amount - outgoing.amount;
  const formatBalance = (amount: number, estimate: boolean) =>
    (estimate ? "≈ " : "") + money(amount, target);

  const openReceipts = data.entries.filter(
    (e) => e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length),
  );
  const trips = activeGroups.filter((g) => g.kind === "trip");
  const longTerm = activeGroups.filter((g) => g.kind !== "trip");

  const renderGroupCard = (g: Group) => {
    const entries = data.entries.filter((e) => e.groupID === g.id);
    const me = g.members.find((p) => p.userID === user);
    const amounts = me ? memberBalances(entries, me.id) : {};
    const bal = homeMoney.total(amounts);
    const openCount = entries.filter((e) => e.bill && !e.bill.closed && e.bill.items.some((i) => !i.memberIDs.length)).length;
    const range = tripRangeText(g.startDate, g.endDate);
    const activeMembers = g.members.filter((m) => !m.removed);

    return (
      <Link key={g.id} to={`/g/${g.id}`} className="card card-pad" style={{ color: "var(--ink)", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15.5 }}>{g.name}</strong>
              <span className="tag mono">{g.currency}</span>
            </div>
            {range && <p className="muted" style={{ fontSize: 12, marginTop: 3 }}>{range}</p>}
            {g.description && (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {g.description}
              </p>
            )}
          </div>
          <BalanceBadge amount={bal.amount} currency={target} display={Object.values(amounts).some(Boolean) ? homeMoney.totalText(amounts, true) : undefined} positive="owed" negative="you owe" />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <AvatarStack people={activeMembers} size={24} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            {openCount > 0 && <span className="tag tag-warn">{openCount} open receipt</span>}
            <span className="muted num">Spent <b style={{ color: "var(--ink)" }}>{homeMoney.spend(entries)}</b></span>
          </div>
        </div>
      </Link>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">
            All your trips, ongoing shared spaces, and pending receipt claims in one place.
          </p>
        </div>
        <div className="head-actions">
          <Link className="btn btn-sm" to="/import/splitwise">
            Import Splitwise
          </Link>
          <Link className="btn btn-sm btn-primary" to="/new">
            + New trip or group
          </Link>
        </div>
      </div>

      {!data.groups.length ? (
        <EmptyState
          title="No trips or groups yet"
          message="Start a trip, set up an ongoing apartment ledger, join with a code, or import your existing groups from Splitwise for free."
          action={{ label: "Create your first group", to: "/new" }}
        />
      ) : (
        <div className="form-stack" style={{ gap: 22 }}>
          <PendingPayments />
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi-label">Overall net balance</div>
              <div className={"kpi-val " + (!missing && net < 0 ? "neg" : "")}>
                {missing ? "Unavailable" : formatBalance(net, approximate)}
              </div>
              {approximate && (
                <div className="kpi-sub">
                  {missing
                    ? "Some exchange rates are unavailable."
                    : (fx.offline ? "Approximate · Using saved rates" : "Approximate · Available exchange rates")}
                </div>
              )}
            </div>
            <div className="kpi">
              <div className="kpi-label">You’re owed</div>
              <div className="kpi-val pos">
                {incoming.missing.length ? "Unavailable" : formatBalance(incoming.amount, incomingApproximate)}
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">You owe</div>
              <div className="kpi-val neg">
                {outgoing.missing.length ? "Unavailable" : formatBalance(outgoing.amount, outgoingApproximate)}
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Open receipts</div>
              <div className={"kpi-val " + (openReceipts.length ? "warn" : "pos")}>
                {openReceipts.length ? `${openReceipts.length} need claims` : "None open"}
              </div>
              <div className="kpi-sub">
                {openReceipts[0] ? (
                  <Link to={`/g/${openReceipts[0].groupID}?tab=receipts`}>Review {openReceipts[0].title} ›</Link>
                ) : (
                  "All itemized bills settled"
                )}
              </div>
            </div>
          </div>

          {trips.length > 0 && (
            <section>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>Trips ({trips.length})</h2>
                <Link to="/new?kind=trip" style={{ fontSize: 12.5, fontWeight: 600 }}>+ New trip</Link>
              </div>
              <div className="grid-2">{trips.map(renderGroupCard)}</div>
            </section>
          )}

          {longTerm.length > 0 && (
            <section>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>Long-term & Home ({longTerm.length})</h2>
                <Link to="/new?kind=home" style={{ fontSize: 12.5, fontWeight: 600 }}>+ New group</Link>
              </div>
              <div className="grid-2">{longTerm.map(renderGroupCard)}</div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

export function NewGroup() {
  const { user, userName, save } = useLedger();
  const nav = useNavigate();
  const [query] = useSearchParams();
  const [id] = useState(() => crypto.randomUUID());
  const [seat] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState(query.get("kind") || "trip");
  const [placeholders, setPlaceholders] = useState("");

  return (
    <div style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Create a trip or group</h1>
          <p className="page-sub">Set up a time-bounded trip or an ongoing household/rent ledger.</p>
        </div>
      </div>
      <div className="card card-pad">
        <Form
          label="Create group"
          submit={async (f) => {
            const extraNames = placeholders
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await save("/v1/groups", {
              id,
              name: value(f, "name"),
              currency: value(f, "currency"),
              kind,
              description: value(f, "description") || undefined,
              startDate: value(f, "startDate") || undefined,
              endDate: value(f, "endDate") || undefined,
              members: [
                { id: seat, name: userName || "Split member", userID: user },
                ...extraNames.map((n) => ({ id: crypto.randomUUID(), name: n, userID: null })),
              ],
            });
            nav("/g/" + id, { replace: true });
          }}
        >
          <div className="form-row">
            <label className="field">
              Name
              <input type="text" name="name" maxLength={80} required autoFocus placeholder={kind === "trip" ? "Patagonia Trip" : "Apt 4B Rent"} />
            </label>
            <label className="field">
              Type
              <Picker label="Group type" value={kind} onChange={(selected) => setKind(selected)} options={[{ value: "trip", label: "Trip (day-by-day)" }, { value: "home", label: "Long-term / Home (monthly)" }, { value: "friend", label: "Friends tab" }]} />
            </label>
          </div>
          <label className="field">
            Description (optional)
            <textarea name="description" maxLength={400} placeholder="What is this group for?" />
          </label>
          <div className="form-row">
            <label className="field">
              Group settlement currency
              <FormPicker label="Currency" name="currency" defaultValue="USD" search options={currencies.map((code) => ({ value: code, label: code }))} />
            </label>
            <label className="field">
              Add people now (comma-separated, optional)
              <input
                type="text"
                value={placeholders}
                onChange={(e) => setPlaceholders(e.target.value)}
                placeholder="Maya, Alex, Sam"
              />
            </label>
          </div>
          {kind === "trip" && (
            <div className="form-row">
              <label className="field">
                Start date (optional)
                <input type="date" name="startDate" />
              </label>
              <label className="field">
                End date (optional)
                <input type="date" name="endDate" />
              </label>
            </div>
          )}
        </Form>
      </div>
    </div>
  );
}

export function Join() {
  const { request, refresh } = useLedger();
  const nav = useNavigate();
  const { code } = useParams();
  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Join a group</h1>
          <p className="page-sub">Paste an invite link or 12-character code shared with you.</p>
        </div>
      </div>
      <div className="card card-pad">
        <Form
          label="Join group"
          submit={async (f) => {
            const input = value(f, "code");
            const token =
              input.match(/^https:\/\/split-api\.yoinklabs\.dev\/join\/([\w-]+)$/)?.[1] ??
              input.match(/\/invite\/([\w-]+)$/)?.[1] ??
              input;
            const r = await request<{ groupID: string }>("/v1/join", { token });
            await refresh();
            nav("/g/" + r.groupID, { replace: true });
          }}
        >
          <label className="field">
            Invitation code or link
            <input type="text" name="code" defaultValue={code} required autoCapitalize="characters" placeholder="ABCD1234EFGH" />
          </label>
        </Form>
      </div>
    </div>
  );
}

export function MemberScreen() {
  const { data, user } = useLedger();
  const { gid, mid } = useParams();
  const [query, setQuery] = useSearchParams();
  const homeMoney = useHomeMoney();

  const g = data.groups.find((x) => x.id === gid);
  const p = g?.members.find((x) => x.id === mid);
  if (!g || !p) return <p>Member unavailable in this group.</p>;

  const shared = membersGroups(data.groups, g, p);
  const scope = query.get("scope") === "all" ? "all" : g.id;
  const kind = query.get("show") === "payments" ? "settlement" : "expense";
  const me = !!p.userID && p.userID === user;

  const statements = shared
    .filter((s) => scope === "all" || s.group.id === scope)
    .map((s) => ({
      ...s,
      all: memberEntries(data.entries, s.group.id, s.person.id),
    }));

  const net: Record<string, number> = {};
  const paid: Record<string, number> = {};
  const share: Record<string, number> = {};
  let missingSpend = false, foreignSpend = false;

  for (const s of statements) {
    const entries = data.entries.filter((e) => e.groupID === s.group.id);
    for (const c of new Set(entries.map((e) => settlementEntry(e).currency)))
      net[c] = (net[c] ?? 0) + (balances(entries, c)[s.person.id] ?? 0);
    for (const original of s.all.filter((e) => e.kind !== "settlement")) {
      foreignSpend ||= original.currency !== homeMoney.home;
      const e = homeMoney.project(original);
      if (!e) { missingSpend = true; continue; }
      const direction = e.kind === "refund" ? -1 : 1;
      paid[e.currency] =
        (paid[e.currency] ?? 0) + direction *
        entryPayers(e)
          .filter((x) => x.memberID === s.person.id)
          .reduce((n, x) => n + x.amount, 0);
      share[e.currency] =
        (share[e.currency] ?? 0) + direction *
        (e.splits.find((x) => x.memberID === s.person.id)?.amount ?? 0);
    }
  }

  const fmtMap = (amounts: Record<string, number>) => missingSpend
    ? "Rate unavailable"
    : homeMoney.format(amounts[homeMoney.home] ?? 0, foreignSpend);
  const combined = homeMoney.total(net);
  const hasOpen = Object.values(net).some(Boolean);
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(query);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setQuery(next, { replace: true });
  };

  return (
    <div className="form-stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar name={p.name} avatarURL={p.avatarURL} size={48} />
          <div>
            <h1 className="page-title">{me ? "Your Statement" : p.name}</h1>
            <p className="page-sub">
              {!p.userID && <span className="tag">Placeholder</span>}
              {p.removed && <span className="tag tag-warn">Archived entity</span>}
              <span>{statements.length === 1 ? statements[0].group.name : `${statements.length} shared groups`}</span>
            </p>
          </div>
        </div>
        <div className="head-actions">
          <Link className="btn btn-sm" to={`/g/${g.id}`}>
            Back to {g.name}
          </Link>
        </div>
      </div>

      {statements.some(({ person }) => personPaymentMethods(person).length > 0) && (
        <div className="card card-pad form-stack">
          <h3>Payment methods</h3>
          {statements.filter(({ person }) => personPaymentMethods(person).length > 0).map(({ group, person }) => (
            <div key={group.id}>
              {statements.length > 1 && <strong>{group.name}</strong>}
              <PaymentOptions person={person} />
            </div>
          ))}
        </div>
      )}

      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="kpi">
          <div className="kpi-label">Total paid</div>
          <div className="kpi-val">{fmtMap(paid)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Total share</div>
          <div className="kpi-val">{fmtMap(share)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Net balance</div>
          <div className="kpi-val">
            {hasOpen ? (
              <span className={combined.missing.length ? "muted" : combined.amount > 0 ? "pos" : "neg"}>
                {homeMoney.totalText(net, true)}
              </span>
            ) : <span className="pos">Settled up</span>}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {shared.length > 1 && (
          <div className="seg">
            <button aria-pressed={scope === "all"} onClick={() => setParam("scope", "all")}>
              All groups
            </button>
            {shared.map((s) => (
              <button
                key={s.group.id}
                aria-pressed={scope === s.group.id}
                onClick={() => setParam("scope", null)}
              >
                <Link to={memberPath(s.group, s.person.id)} replace style={{ color: "inherit" }}>
                  {s.group.name}
                </Link>
              </button>
            ))}
          </div>
        )}
        <div className="seg">
          <button aria-pressed={kind === "expense"} onClick={() => setParam("show", null)}>
            Charges
          </button>
          <button aria-pressed={kind === "settlement"} onClick={() => setParam("show", "payments")}>
            Payments
          </button>
        </div>
      </div>

      {statements.map((s) => {
        const rows = s.all.filter((e) => kind === "settlement" ? e.kind === "settlement" : e.kind !== "settlement");
        if (!rows.length) return null;
        return (
          <section key={s.group.id}>
            <h3 style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>
              {s.group.name} <span className="muted">({rows.length})</span>
            </h3>
            <div className="ledger-list">
              {rows.map((e: Expense) => {
                const myPaid = entryPayers(e)
                  .filter((x) => x.memberID === s.person.id)
                  .reduce((n, x) => n + x.amount, 0);
                return (
                  <Link
                    key={e.id}
                    to={`/g/${s.group.id}?tab=ledger`}
                    className="ledger-item"
                    style={{ gridTemplateColumns: "34px minmax(0,1fr) 130px 120px" }}
                  >
                    <CategoryIcon category={e.category} settlement={e.kind === "settlement"} />
                    <div>
                      <div className="ledger-title">{e.title}</div>
                      <div className="ledger-meta">
                        {shortDate(e.createdAt)} · {e.kind === "refund" ? (e.refundOf ? "Refund received by " : "Credit from ") : "Paid by "}{memberName(s.group, e.paidBy)}{e.handled && " · Handled"}
                        {e.pending && " · Pending"}
                        {e.kind === "settlement" && e.currency !== homeMoney.home && ` · Sent ${money(e.amount, e.currency)}`}
                      </div>
                    </div>
                    <div className="ledger-amount">
                      <strong className={myPaid > 0 ? "pos" : "muted"}>
                        {myPaid > 0 ? `${e.kind === "refund" ? "Received" : "Paid"} ${homeMoney.portion(e, s.person.id, true)}` : "—"}
                      </strong>
                    </div>
                    <div className="ledger-amount">
                      <strong className={e.kind === "refund" ? "pos" : undefined}>{e.kind === "refund" && "Credit "}{homeMoney.portion(e, s.person.id)}</strong>
                      <small>of {homeMoney.entry(e, e.amount)}</small>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PaletteGrid({ mode, value, onPick }: { mode: "light" | "dark"; value: string; onPick: (id: string) => void }) {
  return (
    <div className="palette-grid" role="radiogroup" aria-label={mode === "light" ? "Light mode palette" : "Dark mode palette"}>
      {PALETTES.map((p) => {
        const c = p[mode];
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={value === p.id}
            className={"palette-option" + (value === p.id ? " selected" : "")}
            onClick={() => onPick(p.id)}
          >
            <span className="palette-preview" style={{ background: c.bg }}>
              <span className="palette-preview-side" style={{ background: c.surface }}>
                <span style={{ background: c.primary }} />
              </span>
              <span className="palette-preview-main">
                <span className="palette-preview-card" style={{ background: c.surface }}>
                  <span style={{ background: c.ink, width: "60%", opacity: 0.85 }} />
                  <span style={{ background: c.primary, width: "85%" }} />
                  <span style={{ background: mode === "light" ? "#94a3b8" : "#475569", width: "55%" }} />
                </span>
                <span className="palette-preview-button" style={{ background: c.primary }} />
              </span>
            </span>
            <span className="palette-label">
              {p.label}
              {p.id === DEFAULT_PALETTE && <span className="muted"> · default</span>}
            </span>
            <span className="palette-note">{p.note}</span>
          </button>
        );
      })}
    </div>
  );
}

function AppearanceSettings() {
  const [a, setA] = useState<Appearance>(readAppearance);
  const update = (next: Partial<Appearance>) => {
    const merged = { ...a, ...next };
    setA(merged);
    saveAppearance(merged);
  };
  return (
    <div className="card card-pad form-stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>Appearance</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>Pick a palette for light mode and one for dark mode. System follows your device.</p>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Mode">
          {(["system", "light", "dark"] as Mode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={a.mode === m} className={a.mode === m ? "active" : ""} onClick={() => update({ mode: m })}>
              {m === "system" ? "System" : m === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      <div className={"palette-section" + (a.mode === "dark" ? " inactive" : "")}>
        <div className="palette-section-title">Light mode</div>
        <PaletteGrid mode="light" value={a.light} onPick={(light) => update({ light })} />
      </div>
      <div className={"palette-section" + (a.mode === "light" ? " inactive" : "")}>
        <div className="palette-section-title">Dark mode</div>
        <PaletteGrid mode="dark" value={a.dark} onPick={(dark) => update({ dark })} />
      </div>
    </div>
  );
}

export function Account() {
  const { data, user, userName, userAvatar, demo, save } = useLedger();
  const [home, setHome] = useHomeCurrency();
  const [savedMsg, setSavedMsg] = useState("");

  const first = data.groups.find((g) => g.members.some((p) => p.userID === user));

  async function pickPreset(presetID: string) {
    await save("/v1/profile/avatar", { avatarURL: presetID });
    setSavedMsg("Avatar updated");
    setTimeout(() => setSavedMsg(""), 2000);
  }

  async function uploadAvatar(file: File) {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d")!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      const dataURL = canvas.toDataURL("image/jpeg", 0.85);
      await save("/v1/profile/avatar", { avatarURL: dataURL });
      setSavedMsg("Photo avatar saved");
      setTimeout(() => setSavedMsg(""), 2000);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }} className="form-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Account & Preferences</h1>
          <p className="page-sub">Customize your avatar, home currency, and appearance.</p>
        </div>
      </div>

      {/* Profile & Avatar */}
      <div className="card card-pad">
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <Avatar name={userName} avatarURL={userAvatar} size={56} />
          <div>
            <strong style={{ fontSize: 16 }}>{userName}</strong>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {demo ? "Interactive sample account" : "Signed in with Yoink Labs"}
            </div>
          </div>
          {first && (
            <Link
              className="btn btn-sm"
              style={{ marginLeft: "auto" }}
              to={memberPath(first, first.members.find((p) => p.userID === user)!.id)}
            >
              View my statement ›
            </Link>
          )}
        </div>

        <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginBottom: 8 }}>
          Choose avatar color or upload a photo
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {AVATAR_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void pickPreset(p.id)}
              title={p.label}
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: p.bg,
                border: userAvatar === p.id ? "3px solid var(--ink)" : "2px solid var(--surface)",
                cursor: "pointer",
              }}
            />
          ))}
          <label className="btn btn-sm" style={{ cursor: "pointer" }}>
            Upload photo
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAvatar(f);
              }}
            />
          </label>
        </div>
        {savedMsg && <p className="ok-banner" style={{ marginTop: 12 }}>{savedMsg}</p>}
      </div>

      <div className="card card-pad form-stack">
        <h3>Payment methods</h3>
        <PaymentEditor initial={data.paymentMethods ?? []} shareWithFriends={data.sharePaymentWithFriends}
          save={(methods, shareWithFriends) => save("/v1/profile/payment-methods", { methods, shareWithFriends })} />
      </div>

      <DiscoverySetting />

      <AppearanceSettings />

      {/* Currency */}
      <div className="card card-pad form-stack">
        <div className="form-row">
          <label className="field">
            Home currency
            <Picker label="Home currency" value={home} onChange={setHome} search options={currencies.map((code) => ({ value: code, label: code }))} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>
          Free currency conversion uses ECB (Frankfurter) and BCRA official rates for ARS, plus custom manual rates on any expense.
        </p>
      </div>

      <div className="card">
        <a className="row" href={TIP_URL} target="_blank" rel="noreferrer" style={{ color: "var(--ink)" }}>
          <strong>♥ Tip the devs</strong>
          <span className="muted" style={{ fontSize: 12.5 }}>Optional, unlocks nothing ›</span>
        </a>
        {!demo && (
          <div className="row">
            <button className="btn btn-danger btn-sm" onClick={() => void window.Clerk.signOut()}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
