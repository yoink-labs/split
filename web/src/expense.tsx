import { spreadLength, type Portion } from "../../worker/src/ledger";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { CATEGORIES, categoryMeta } from "./categories";
import { Picker } from "./picker";
import { Avatar, CategoryIcon } from "./ui";
import {
  allocate,
  entryPayers,
  itemSplit,
  minor,
  moneyCompact,
  receiptPhoto,
  type Expense,
  type Group,
} from "./data";
import type { Bill } from "../../worker/src/items";
import { ConverterDialog, CurrencySelect, RateField } from "./fxui";
import { today, useRates, type Exchange } from "./fx";
import { useHomeMoney } from "./homeMoney";
import { minorInput } from "./receiptText";

export function ExpenseForm() {
  const { gid, eid } = useParams(),
    { data } = useLedger(),
    g = data.groups.find((g) => g.id === gid),
    existing = eid ? data.entries.find((e) => e.id === eid && e.groupID === gid) : undefined;
  if (!g) return <p>Group unavailable.</p>;
  if (eid && !existing) return <p>Expense unavailable.</p>;
  return <Composer key={g.id + (existing?.id ?? "new")} g={g} existing={existing} />;
}

function Composer({ g, existing }: { g: Group; existing?: Expense }) {
  const [query] = useSearchParams();
  const { save, user } = useLedger(),
    nav = useNavigate(),
    [id] = useState(() => existing?.id ?? crypto.randomUUID()),
    [date, setDate] = useState(() => existing?.createdAt.slice(0, 10) ?? today());

  const [spreadEnabled, setSpreadEnabled] = useState(Boolean(existing?.spread));
  const [spreadStart, setSpreadStart] = useState(existing?.spread?.start ?? "");
  const [spreadEnd, setSpreadEnd] = useState(existing?.spread?.end ?? "");
  const existingPayers = existing ? entryPayers(existing) : [];
  const activeMembers = g.members.filter((m) =>
    !m.removed || existing?.splits.some((s) => s.memberID === m.id) || existingPayers.some((p) => p.memberID === m.id),
  );
  const pickerMembers = [...activeMembers].sort((a, b) =>
    Number(b.userID === user) - Number(a.userID === user) || a.name.localeCompare(b.name),
  );
  const canSetHandled = !existing || existingPayers.some((payer) =>
    g.members.some((member) => member.id === payer.memberID && member.userID === user && !member.removed),
  );
  const [handled, setHandled] = useState(existing?.handled ?? false);
  const [pending, setPending] = useState(existing?.pending ?? false);
  const [pendingNote, setPendingNote] = useState(existing?.pendingNote ?? "");
  const weights = g.defaultWeights ?? {},
    hasDefaults = !existing && Object.values(weights).some((w) => w > 0);

  const [mode, setMode] = useState<string>(() =>
    existing?.bill || (!existing && query.has("receipt")) ? "items" : (existing?.splits.some(s => s.nights !== undefined) ? "nights" : existing?.splitMode) ?? (hasDefaults ? "shares" : "equal"),
  );
  const [selected, setSelected] = useState<string[]>(() =>
    existing
      ? existing.splits.map((s) => s.memberID)
      : activeMembers.filter((p) => !hasDefaults || (weights[p.id] ?? 0) > 0).map((p) => p.id),
  );

  const [splitInputs, setSplitInputs] = useState<Record<string, Record<string, string>>>({});

  // Multi-payer support
  const [multiPayer, setMultiPayer] = useState(() => existingPayers.length > 1);
  const defaultPayer = existing?.paidBy ?? activeMembers.find((p) => p.userID === user)?.id ?? activeMembers[0]?.id ?? "";
  const [singlePayer, setSinglePayer] = useState(defaultPayer);
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(existingPayers.map((p) => [p.memberID, (p.amount / 100).toFixed(2)])),
  );

  const photosByFile = useRef(new WeakMap<File, Promise<{ id: string; data: string }>>());
  const [rows, setRows] = useState<{ id: string; title: string; price: string; claims: string[] }[]>(() =>
    existing?.bill
      ? existing.bill.items.map((i) => ({
          id: i.id,
          title: i.title,
          price: (i.amount / 100).toFixed(2),
          claims: i.memberIDs,
        }))
      : [{ id: crypto.randomUUID(), title: "", price: "", claims: [] }],
  );

  const [tax, setTax] = useState(minorInput(existing?.bill?.tax ?? 0));
  const [tip, setTip] = useState(minorInput(existing?.bill?.tip ?? 0));
  const scan = useRef<AbortController | undefined>(undefined);
  const [scanMessage, setScanMessage] = useState("");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const photoInput = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => () => scan.current?.abort(), []);

  async function suggestPhotos(files: File[]) {
    scan.current?.abort();
    setScanning(false);
    setScanMessage("");
    setFileNames(files.map((file) => file.name));
    if (!files.length) return;
    if (files.length > 4) {
      setScanMessage("Choose up to four photos.");
      return;
    }
    if (existing?.bill || rows.some((row) => row.title || row.price || row.claims.length)) {
      setScanMessage("Photos attached. Your existing line items are kept.");
      return;
    }

    const controller = new AbortController();
    scan.current = controller;
    setScanning(true);
    const timeout = window.setTimeout(() => {
      controller.abort();
      setScanning(false);
      setScanMessage("Photo reading took too long. Enter the items and choose who shared each one.");
    }, 25000);

    try {
      const { readReceiptPhotos } = await import("./receiptScan");
      const suggestion = await readReceiptPhotos(files, controller.signal);
      if (controller.signal.aborted) return;
      if (suggestion.items.length) {
        setMode("items");
        setRows((current) =>
          current.some((row) => row.title || row.price || row.claims.length)
            ? current
            : suggestion.items.map((item) => ({ id: crypto.randomUUID(), title: item.title, price: minorInput(item.amount), claims: [] })),
        );
        setTax((current) => current || minorInput(suggestion.tax));
        setTip((current) => current || minorInput(suggestion.tip));
        setScanMessage("Review the suggested items and choose who shared each one.");
      } else {
        setScanMessage("No prices were recognized. Enter the items and choose who shared each one.");
      }
    } catch {
      if (!controller.signal.aborted) setScanMessage("Could not read these photos. Enter the items and choose who shared each one.");
    } finally {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted) setScanning(false);
    }
  }

  const [currency, setCurrency] = useState(existing?.currency ?? g.currency);
  const homeMoney = useHomeMoney();
  useRates([currency], homeMoney.home);
  const [amountText, setAmountText] = useState(existing ? (existing.amount / 100).toFixed(2) : "");
  const [category, setCategory] = useState(existing?.category ?? "Dining");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [extrasOpen, setExtrasOpen] = useState(Boolean(existing?.notes || existing?.handled || existing?.pending || query.has("receipt")));
  const settlementCurrency = existing?.exchange?.target ?? (currency === existing?.currency ? existing.currency : g.currency);
  const savedExchange = currency === existing?.currency ? existing.exchange : undefined;
  const [exchange, setExchange] = useState<Exchange | null>(savedExchange ?? null);
  const foreign = currency !== settlementCurrency;
  const [converter, setConverter] = useState(false);

  let typed: number | null = null;
  try {
    typed = amountText ? minor(amountText) : null;
  } catch {
    typed = null;
  }

  let chargeAmount = typed;
  if (mode === "items") {
    try {
      chargeAmount = rows.reduce((sum, row) => sum + minor(row.price || "0"), minor(tax || "0") + minor(tip || "0"));
    } catch {
      chargeAmount = null;
    }
  }

  const perPersonEqual =
    mode === "equal" && typed && selected.length && selected.length <= 50 ? allocate(typed, selected.map(() => 1)) : null;
  const storedWeights = existing?.splitMode === mode && existing.splits.length <= 50
    ? mode === "percent"
      ? allocate(10000, existing.splits.map((s) => s.amount))
      : mode === "adjustment"
        ? allocate(existing.amount, existing.splits.map(() => 1))
        : undefined
    : undefined;
  const defaultSplitInput = (mid: string) => {
    const index = existing?.splits.findIndex((s) => s.memberID === mid) ?? -1;
    const prior = existing && index >= 0 ? existing.splits[index].amount : undefined;
    if (mode === "nights") return String(existing?.splits[index]?.nights ?? 1);
    if ((mode === "exact" || (mode === "shares" && existing?.splitMode === mode)) && prior !== undefined) return (prior / 100).toFixed(2);
    if (mode === "percent" && storedWeights && index >= 0) return (storedWeights[index] / 100).toFixed(2);
    if (mode === "adjustment") return prior !== undefined && storedWeights ? ((prior - storedWeights[index]) / 100).toFixed(2) : "0.00";
    return mode === "shares" ? String(weights[mid] ?? 1) : "";
  };

  return (
    <div className="expense-form">
      <div className="page-head">
        <div>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
            <Link to={"/g/" + g.id}>{g.name}</Link> / {existing ? "Edit expense" : "New expense"}
          </p>
          <h1 className="page-title">{existing ? "Edit expense" : "Add expense"}</h1>
        </div>
        <Link className="btn" to={"/g/" + g.id}>
          Cancel
        </Link>
      </div>

      <div className="expense-composer">
        <Form
          label={existing ? "Save changes" : "Save expense"}
          footer={<div><span>{mode === "items" ? "Receipt total" : "Expense total"}</span>
            <strong className="num">{moneyCompact(chargeAmount ?? 0, currency)}</strong></div>}
          submit={async (f) => {
            if (scanning && mode === "items") throw new Error("Wait for photo reading to finish before saving.");
            const files = (f.getAll("photos") as File[]).filter((file) => file.size);
            const attached = existing?.receiptIDs?.length ?? 0;
            if (files.length + attached > 4)
              throw new Error(attached ? `This expense has ${attached} of 4 receipt photos. Choose up to ${4 - attached} more, or move one to the receipts inbox first.` : "Choose up to four photos.");
            const photos = await Promise.all(
              files.map((file) => {
                let photo = photosByFile.current.get(file);
                if (!photo) {
                  photo = receiptPhoto(file).catch((error) => {
                    photosByFile.current.delete(file);
                    throw error;
                  });
                  photosByFile.current.set(file, photo);
                }
                return photo;
              }),
            );

            let bill: Bill | undefined;
            if (mode === "items") {
              bill = {
                closed: false,
                tax: minor(value(f, "tax") || "0"),
                tip: minor(value(f, "tip") || "0"),
                items: rows.map((r) => {
                  const chosen = f.getAll("claims-" + r.id).map(String);
                  const previous = existing?.bill?.items.find((i) => i.id === r.id);
                  // Preserve the original tie-breaking order for retained claimants.
                  const memberIDs = [
                    ...r.claims.filter((id) => chosen.includes(id)),
                    ...chosen.filter((id) => !r.claims.includes(id)),
                  ];
                  const shares = previous?.shares && Object.fromEntries(Object.entries(previous.shares).filter(([id]) => chosen.includes(id)));
                  const sameClaimants = memberIDs.length === r.claims.length && memberIDs.every((id, i) => id === r.claims[i]);
                  return {
                    id: r.id,
                    title: value(f, "name-" + r.id),
                    amount: minor(value(f, "price-" + r.id)),
                    memberIDs,
                    ...(shares && Object.keys(shares).length ? { shares } : {}),
                    ...(sameClaimants ? { roundingSeats: previous?.roundingSeats, roundingWeights: previous?.roundingWeights } : {}),
                  };
                }),
              };
            }

            const amount = bill
              ? bill.items.reduce((sum, i) => sum + i.amount, bill.tax + bill.tip)
              : minor(value(f, "amount"));
            if (amount <= 0) throw new Error("The total must be positive.");

            // Resolve payers
            let paidBy = singlePayer;
            let payers: { memberID: string; amount: number }[] | undefined;
            if (multiPayer) {
              const list = activeMembers
                .map((m) => ({
                  memberID: m.id,
                  amount: payerAmounts[m.id]?.trim() ? minor(payerAmounts[m.id]) : 0,
                }))
                .filter((p) => p.amount > 0);
              if (!list.length) throw new Error("Enter how much at least one person paid.");
              if (list.reduce((s, p) => s + p.amount, 0) !== amount)
                throw new Error("Multiple payer amounts must add up to the exact total.");
              paidBy = list.some((p) => p.memberID === singlePayer) ? singlePayer : list[0].memberID;
              if (list.length > 1) payers = list;
            }

            // Resolve splits
            if (!bill && (!selected.length || selected.length > 50)) throw new Error("Select between one and fifty people to split with.");
            let splits: Portion[];
            if (bill) {
              splits = itemSplit(bill, paidBy);
            } else if (mode === "equal") {
              const portions = allocate(amount, selected.map(() => 1));
              splits = selected.map((memberID, i) => ({ memberID, amount: portions[i] }));
            } else if (mode === "adjustment") {
              const adjs = selected.map((mid) => {
                const raw = value(f, "weight-" + mid) || "0";
                const neg = raw.startsWith("-");
                const val = minor(neg ? raw.slice(1) : raw);
                return neg ? -val : val;
              });
              const remainder = amount - adjs.reduce((a, b) => a + b, 0);
              if (remainder < 0) throw new Error("Adjustments exceed the total amount.");
              const base = remainder ? allocate(remainder, selected.map(() => 1)) : selected.map(() => 0);
              splits = selected.map((memberID, i) => ({ memberID, amount: base[i] + adjs[i] }));
              if (splits.some((s) => s.amount < 0))
                throw new Error("Each person’s final share must be at least 0.");
            } else {
              const raw = selected.map((mid) => value(f, "weight-" + mid));
              if (mode === "nights" && raw.some((night) => !/^\d+$/.test(night) || Number(night) < 1 || Number(night) > 366))
                throw new Error("Enter a whole number from 1 to 366 for each person’s nights.");
              const inputs = raw.map((input) => mode === "nights" ? Number(input) : minor(input || "0"));
              if (mode === "exact" && inputs.reduce((a, b) => a + b, 0) !== amount)
                throw new Error("Individual amounts must add up to the total.");
              if (mode === "percent" && inputs.reduce((a, b) => a + b, 0) !== 10000)
                throw new Error("Percentages must add up to 100%.");
              const samePercent = mode === "percent" && storedWeights && existing?.amount === amount
                && selected.length === existing.splits.length
                && selected.every((id, i) => id === existing.splits[i].memberID && inputs[i] === storedWeights[i]);
              const portions = samePercent ? existing.splits.map((s) => s.amount)
                : mode === "exact" ? inputs : allocate(amount, inputs);
              splits = selected.map((memberID, i): Portion => ({ memberID, amount: portions[i], ...(mode === "nights" ? { nights: inputs[i] } : {}) }));
            }

            const spread = spreadEnabled ? { start: spreadStart, end: spreadEnd } : undefined;
            const days = spread ? spreadLength(spread) : 0;
            if (spread && (days < 1 || days > 366 || splits.some((s: Portion) => (s.nights ?? 0) > days)))
              throw new Error("Choose a date range up to 366 days that covers everyone’s nights.");
            if (!/^\d{4}-\d\d-\d\d$/.test(date) || (!existing && date > today()))
              throw new Error("Choose today or an earlier charge date.");
            if (foreign && !exchange)
              throw new Error("Wait for the rate, or enter your own rate.");

            const createdAt = existing ? existing.createdAt : date + "T12:00:00Z";
            const entry = {
              id,
              groupID: g.id,
              title: value(f, "title"),
              amount,
              currency,
              paidBy,
              ...(payers ? { payers } : {}),
              splits,
              splitMode: bill ? "exact" : mode === "nights" ? "shares" : mode,
              kind: "expense" as const,
              ...(handled ? { handled: true } : {}),
              ...(pending && !handled ? { pending: true, ...(pendingNote.trim() ? { pendingNote: pendingNote.trim() } : {}) } : {}),
              createdAt,
              ...(spread ? { spread } : {}),
              ...(category ? { category } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(foreign && exchange ? { exchange } : {}),
              ...(bill ? { bill } : {}),
            };

            if (existing) {
              const { editable: _ed, recurrence: _rec, commentCount: _cc, likeCount: _lc, likedByMe: _lm, receiptIDs: _ri, ...orig } = existing;
              await save(`/v1/entries/${existing.id}/edit`, {
                original: orig,
                entry,
                ...(photos.length ? { photos } : {}),
              });
            } else {
              await save("/v1/entries", {
                ...entry,
                ...(photos.length ? { photos } : {}),
              });
            }
            nav(`/g/${g.id}?tab=${bill ? "receipts" : "ledger"}`, { replace: true });
          }}
        >
          <div className="expense-layout">
            <section className="card expense-panel">
              <h2>Expense details</h2>
              <label className="field">
                Description
                <input type="text" required name="title" maxLength={120}
                  defaultValue={existing?.title ?? ""} placeholder="Dinner, Airbnb, flights…" />
              </label>
              <div className="expense-money-fields">
                {mode !== "items" && <label className="field expense-amount">
                  Amount
                  <input type="text" name="amount" required inputMode="decimal" placeholder="0.00"
                    value={amountText} onChange={(e) => setAmountText(e.target.value)} />
                  {typed !== null && typed > 0 && currency !== homeMoney.home && (
                    <small className="muted">{homeMoney.totalText({ [currency]: typed })}</small>
                  )}
                </label>}
                <CurrencySelect label="Currency" value={currency} onChange={(next) => {
                  setExchange(null);
                  setCurrency(next);
                }} />
              </div>
              <div className="field">
                <span>Category</span>
                <Picker label="Category" value={category} onChange={setCategory} search
                  options={[...new Set([...CATEGORIES.map((c) => c.id), category])].map((id) => ({
                    value: id, label: categoryMeta(id).label, icon: <CategoryIcon category={id} />,
                  }))} />
              </div>
              <label className="field">
                Date
                <input type="date" value={date} disabled={Boolean(existing)} max={today()} required
                  onChange={(e) => {
                    setExchange(null);
                    setDate(e.target.value);
                  }} />
              </label>
              {!foreign ? (
                <div>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConverter(true)}>
                    Open FX converter
                  </button>
                </div>
              ) : (
                <RateField
                  key={currency}
                  from={currency}
                  to={settlementCurrency}
                  amount={chargeAmount}
                  date={date}
                  saved={savedExchange}
                  tripRate={settlementCurrency === g.currency ? g.tripRates?.[currency] : undefined}
                  onChange={setExchange}
                />
              )}
              <ConverterDialog open={converter} onClose={() => setConverter(false)} from={currency} to={settlementCurrency} amount={chargeAmount} date={date} />

            </section>

            <section className="card expense-panel">
              <h2>Payment & split</h2>
              <div className="field">
                <span>Paid by</span>
                <Picker label="Paid by" value={multiPayer ? ":multiple" : singlePayer} search={pickerMembers.length > 8}
                  onChange={(next) => {
                    setMultiPayer(next === ":multiple");
                    if (next !== ":multiple") setSinglePayer(next);
                  }}
                  options={[
                    ...pickerMembers.map((person) => ({
                      value: person.id, label: person.userID === user ? "You" : person.name,
                      icon: <Avatar name={person.name} avatarURL={person.avatarURL} size={23} />,
                    })),
                    ...(activeMembers.length > 1 || multiPayer ? [{ value: ":multiple", label: "Multiple people" }] : []),
                  ]} />
              </div>
              {multiPayer && (
                <div className="expense-payer-amounts">
                  {pickerMembers.map((p) => (
                    <div className="expense-payer-row" key={p.id}>
                      <span>{p.userID === user ? "You" : p.name}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`Amount paid by ${p.name}`}
                        value={payerAmounts[p.id] ?? ""}
                        onChange={(e) => setPayerAmounts({ ...payerAmounts, [p.id]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="field">
                <span>Split method</span>
                <Picker label="Split method" value={mode} disabled={Boolean(existing?.bill)} onChange={setMode}
                  options={[
                    { value: "equal", label: "Equally" }, { value: "exact", label: "Exact amounts" },
                    { value: "percent", label: "Percentages" }, { value: "shares", label: "Shares (weights)" },
                    { value: "nights", label: "Nights" }, { value: "adjustment", label: "Equal + adjustments" }, { value: "items", label: "Itemized (items, tax & tip)" },
                  ]} />
              </div>

              <div className="field">
                <label className="check">
                  <input type="checkbox" disabled={Boolean(existing?.recurrence && existing.recurrence !== "off")} checked={spreadEnabled} onChange={(event) => setSpreadEnabled(event.target.checked)} />
                  Spread over days
                </label>
                {spreadEnabled && <>
                  <label className="field">First day<input type="date" value={spreadStart} required onChange={(event) => setSpreadStart(event.target.value)} /></label>
                  <label className="field">End date (excluded)<input type="date" value={spreadEnd} required onChange={(event) => setSpreadEnd(event.target.value)} /></label>
                  {mode === "nights" && <small className="muted">Each person’s nights start on the first day.</small>}
                </>}
              </div>

              {mode === "items" ? (
                <fieldset className="card" disabled={scanning} style={{ padding: 14, background: "var(--bg)", minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <strong style={{ fontSize: 13 }}>Receipt line items</strong>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={rows.length >= 50}
                      onClick={() => setRows([...rows, { id: crypto.randomUUID(), title: "", price: "", claims: [] }])}
                    >
                      + Add line item
                    </button>
                  </div>
                  <div className="form-stack">
                    {rows.map((r, i) => (
                      <div key={r.id} className="card" style={{ padding: 12 }}>
                        <div className="form-row">
                          <label className="field">
                            Item {i + 1}
                            <input type="text" name={"name-" + r.id} value={r.title} onChange={(e) => setRows(rows.map((row) => row.id === r.id ? { ...row, title: e.target.value } : row))} required maxLength={100} placeholder="Ribeye steak, Malbec…" />
                          </label>
                          <label className="field">
                            Price ({currency})
                            <input type="text" name={"price-" + r.id} value={r.price} onChange={(e) => setRows(rows.map((row) => row.id === r.id ? { ...row, price: e.target.value } : row))} required inputMode="decimal" placeholder="0.00" />
                          </label>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8, alignItems: "center" }}>
                          <span className="muted" style={{ fontSize: 12 }}>Claimed by:</span>
                          {activeMembers.map((p) => (
                            <label className="check" key={p.id} style={{ fontSize: 12.5 }}>
                              <input type="checkbox" name={"claims-" + r.id} value={p.id} checked={r.claims.includes(p.id)}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setRows((current) => current.map((row) => row.id === r.id
                                    ? { ...row, claims: checked ? [...row.claims, p.id] : row.claims.filter((id) => id !== p.id) }
                                    : row));
                                }} />
                              {p.name}
                            </label>
                          ))}
                          {rows.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              style={{ marginLeft: "auto" }}
                              onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className="form-row">
                      <label className="field">
                        Tax
                        <input type="text" name="tax" value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" placeholder="0.00" />
                      </label>
                      <label className="field">
                        Tip
                        <input type="text" name="tip" value={tip} onChange={(e) => setTip(e.target.value)} inputMode="decimal" placeholder="0.00" />
                      </label>
                    </div>
                    <p className="muted" style={{ fontSize: 12 }}>
                      Tax and tip scale proportionally to each item. Unclaimed items stay on the payer until claimed (including fractional shares) in the Receipts Hub.
                    </p>
                  </div>
                </fieldset>
              ) : (
                <div className="expense-split-list">
                  <div className="expense-section-head">
                    <strong style={{ fontSize: 13 }}>Split with ({selected.length})</strong>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() =>
                        setSelected(selected.length === activeMembers.length ? [] : activeMembers.map((m) => m.id))
                      }
                    >
                      {selected.length === activeMembers.length ? "Clear all" : "Select all"}
                    </button>
                  </div>
                  <div>
                    {pickerMembers.map((p) => {
                      const isOn = selected.includes(p.id);
                      const idx = selected.indexOf(p.id);
                      const eqShare = perPersonEqual && idx >= 0 ? perPersonEqual[idx] : null;
                      return (
                        <div key={p.id} className="expense-split-person">
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={isOn}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id),
                                )
                              }
                            />
                            <Avatar name={p.name} avatarURL={p.avatarURL} size={24} />
                            <span>{p.userID === user ? "You" : p.name}</span>
                          </label>
                          {mode === "equal" && eqShare !== null && (
                            <span className="num muted" style={{ fontSize: 12.5 }}>
                              {moneyCompact(eqShare, currency)}
                            </span>
                          )}
                          {mode !== "equal" && isOn && (
                            <input
                              key={mode}
                              type="text"
                              style={{ width: 130 }}
                              aria-label={p.name + " " + mode}
                              name={"weight-" + p.id}
                              inputMode={mode === "nights" ? "numeric" : "decimal"}
                              placeholder={mode === "percent" ? "%" : (mode === "shares" || mode === "nights") ? "1" : "0.00"}
                              value={splitInputs[mode]?.[p.id] ?? defaultSplitInput(p.id)}
                              onChange={(event) => {
                                const text = event.target.value;
                                setSplitInputs((current) => ({ ...current, [mode]: { ...current[mode], [p.id]: text } }));
                              }}
                              required
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </section>
          </div>
          <details className="card expense-extras" open={extrasOpen} onToggle={(e) => setExtrasOpen(e.currentTarget.open)}>
            <summary>Receipt photos, notes, pending & more{pending && <span className="tag tag-pending" style={{ marginLeft: 8 }}>Pending</span>}</summary>
            <div className="expense-extras-body">
              <label className="expense-handled">
                <input type="checkbox" checked={handled} disabled={!canSetHandled || pending} onChange={(e) => setHandled(e.target.checked)} />
                <span>
                  <strong>Already handled</strong>
                  <small>{canSetHandled ? "Keep this expense in spending history without adding it to balances." : "A payer can change this status from the expense details."}</small>
                </span>
              </label>

              <label className="expense-handled">
                <input type="checkbox" checked={pending} disabled={handled} onChange={(e) => setPending(e.target.checked)} />
                <span>
                  <strong>Pending</strong>
                  <small>The cost may still change, for example while a refund is requested. It counts toward balances, and Settle up warns before anyone pays.</small>
                </span>
              </label>
              {pending && (
                <label className="field">
                  Why is it pending? (optional)
                  <input type="text" maxLength={500} value={pendingNote} onChange={(e) => setPendingNote(e.target.value)}
                    placeholder="e.g., Sam couldn’t go; asking the operator to refund the ticket" />
                </label>
              )}

              <section className="receipt-upload">
                <div className="expense-section-head">
                  <strong>Receipt photos</strong>
                  {fileNames.length > 0 && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                      if (photoInput.current) photoInput.current.value = "";
                      void suggestPhotos([]);
                    }}>Remove photos</button>
                  )}
                </div>
                <label className="receipt-upload-control">
                  <input
                    ref={photoInput}
                    type="file"
                    name="photos"
                    accept="image/*"
                    multiple
                    onChange={(event) => void suggestPhotos(Array.from(event.currentTarget.files ?? []))}
                  />
                  <span className="receipt-upload-label">Choose receipt photos</span>
                  <span className="muted">{existing?.receiptIDs?.length ? `${existing.receiptIDs.length} of 4 attached · up to ${Math.max(0, 4 - existing.receiptIDs.length)} more` : "Up to 4 images"}</span>
                </label>
                {fileNames.length > 0 && <p className="receipt-file-list">{fileNames.join(", ")}</p>}
                {fileNames.length > 0 && (
                  <p className="muted" role="status">
                    {scanning ? "Reading photos on this device…" : scanMessage || "Review the line items and choose who shared each one."}
                  </p>
                )}
                {scanning && (
                  <button type="button" className="btn btn-sm" onClick={() => {
                    scan.current?.abort();
                    setMode("items");
                    setScanning(false);
                    setScanMessage("Enter the items and choose who shared each one.");
                  }}>Enter items manually</button>
                )}
              </section>

              <label className="field">
                Notes (optional)
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={2000}
                  placeholder="e.g., Paid in cash at the blue-dollar rate; Sam joined after dessert"
                />
              </label>
            </div>
          </details>
        </Form>
      </div>
    </div>
  );
}
