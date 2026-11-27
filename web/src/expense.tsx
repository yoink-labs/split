import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { CATEGORIES } from "./categories";
import {
  allocate,
  currencies,
  entryPayers,
  itemSplit,
  minor,
  moneyCompact,
  receiptPhoto,
  stamp,
  type Expense,
  type Group,
} from "./data";
import type { Bill } from "../../worker/src/items";
import { ConverterDialog, RateField } from "./fxui";
import type { Exchange } from "./fx";

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
  const { save, user } = useLedger(),
    nav = useNavigate(),
    [id] = useState(() => existing?.id ?? crypto.randomUUID()),
    [date, setDate] = useState(() => (existing?.createdAt ?? stamp()).slice(0, 10));

  const existingPayers = existing ? entryPayers(existing) : [];
  const activeMembers = g.members.filter((m) =>
    !m.removed || existing?.splits.some((s) => s.memberID === m.id) || existingPayers.some((p) => p.memberID === m.id),
  );
  const weights = g.defaultWeights ?? {},
    hasDefaults = !existing && Object.values(weights).some((w) => w > 0);

  const [mode, setMode] = useState<string>(() =>
    existing?.bill ? "items" : existing?.splitMode ?? (hasDefaults ? "shares" : "equal"),
  );
  const [selected, setSelected] = useState<string[]>(() =>
    existing
      ? existing.splits.map((s) => s.memberID)
      : activeMembers.filter((p) => !hasDefaults || (weights[p.id] ?? 0) > 0).map((p) => p.id),
  );

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

  const [currency, setCurrency] = useState(existing?.currency ?? g.currency);
  const [amountText, setAmountText] = useState(existing ? (existing.amount / 100).toFixed(2) : "");
  const [category, setCategory] = useState(existing?.category ?? "Dining");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [exchange, setExchange] = useState<Exchange | null>(
    (existing?.exchange as Exchange | undefined) ?? null,
  );
  const foreign = currency !== g.currency;
  const [converter, setConverter] = useState(false);

  let typed: number | null = null;
  try {
    typed = amountText ? minor(amountText) : null;
  } catch {
    typed = null;
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
    if ((mode === "exact" || (mode === "shares" && existing?.splitMode === mode)) && prior !== undefined) return (prior / 100).toFixed(2);
    if (mode === "percent" && storedWeights && index >= 0) return (storedWeights[index] / 100).toFixed(2);
    if (mode === "adjustment") return prior !== undefined && storedWeights ? ((prior - storedWeights[index]) / 100).toFixed(2) : "0.00";
    return mode === "shares" ? String(weights[mid] ?? 1) : "";
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
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

      <div className="card card-pad">
        <Form
          label={existing ? "Save changes" : "Save expense"}
          submit={async (f) => {
            const files = (f.getAll("photos") as File[]).filter((file) => file.size);
            if (files.length > 4) throw new Error("Choose up to four photos.");
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
            if (existing?.bill?.closed) {
              bill = existing.bill;
            } else if (mode === "items") {
              bill = {
                closed: existing?.bill?.closed ?? false,
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
            let splits: { memberID: string; amount: number }[];
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
              const inputs = selected.map((mid) => minor(value(f, "weight-" + mid) || "0"));
              if (mode === "exact" && inputs.reduce((a, b) => a + b, 0) !== amount)
                throw new Error("Individual amounts must add up to the total.");
              if (mode === "percent" && inputs.reduce((a, b) => a + b, 0) !== 10000)
                throw new Error("Percentages must add up to 100%.");
              const samePercent = mode === "percent" && storedWeights && existing?.amount === amount
                && selected.length === existing.splits.length
                && selected.every((id, i) => id === existing.splits[i].memberID && inputs[i] === storedWeights[i]);
              const portions = samePercent ? existing.splits.map((s) => s.amount)
                : mode === "exact" ? inputs : allocate(amount, inputs);
              splits = selected.map((memberID, i) => ({ memberID, amount: portions[i] }));
            }

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
              splitMode: bill ? "exact" : mode,
              kind: "expense" as const,
              createdAt,
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
          <div className="form-row">
            <label className="field">
              Description
              <input
                type="text"
                required
                name="title"
                maxLength={120}
                defaultValue={existing?.title ?? ""}
                placeholder="Dinner at Don Julio, Airbnb, flights…"
                autoFocus
              />
            </label>
            <label className="field">
              Date
              <input
                type="date"
                value={date}
                disabled={Boolean(existing)}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          </div>

          <div className="form-row">
            <label className="field">
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {!CATEGORIES.some((c) => c.id === category) && <option value={category}>{category}</option>}
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <label className="field">
                Currency
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              {mode !== "items" && (
                <label className="field">
                  Amount ({currency})
                  <input
                    type="text"
                    name="amount"
                    required
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                  />
                </label>
              )}
            </div>
          </div>

          {!foreign ? (
            <div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConverter(true)}>
                Open FX converter
              </button>
            </div>
          ) : (
            <RateField
              from={currency}
              to={g.currency}
              amount={mode === "items" ? null : typed}
              date={date}
              onChange={setExchange}
            />
          )}
          <ConverterDialog open={converter} onClose={() => setConverter(false)} to={g.currency} amount={typed} />

          {/* Paid by (single or multiple payers) */}
          <div className="card" style={{ padding: 14, background: "var(--bg)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Paid by</strong>
              <label className="check" style={{ fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={multiPayer}
                  disabled={Boolean(existing?.bill?.closed)}
                  onChange={(e) => setMultiPayer(e.target.checked)}
                />
                Multiple people paid
              </label>
            </div>
            {!multiPayer ? (
              <select value={singlePayer} disabled={Boolean(existing?.bill?.closed)} onChange={(e) => setSinglePayer(e.target.value)}>
                  {activeMembers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {activeMembers.map((p) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 500 }}>{p.name}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      style={{ width: 130 }}
                      value={payerAmounts[p.id] ?? ""}
                      onChange={(e) => setPayerAmounts({ ...payerAmounts, [p.id]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Split Method */}
          <label className="field">
            Split method
            <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={Boolean(existing?.bill)}>
              <option value="equal">Equally</option>
              <option value="exact">Exact amounts</option>
              <option value="percent">Percentages (%)</option>
              <option value="shares">Shares (weights)</option>
              <option value="adjustment">Equal + adjustments (+/-)</option>
              <option value="items">Itemized receipt (claimable)</option>
            </select>
          </label>

          {existing?.bill?.closed ? (
            <p className="muted">The item allocations are locked because this receipt is closed.</p>
          ) : mode === "items" ? (
            <div className="card" style={{ padding: 14, background: "var(--bg)" }}>
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
                        <input type="text" name={"name-" + r.id} defaultValue={r.title} required maxLength={100} placeholder="Ribeye steak, Malbec…" />
                      </label>
                      <label className="field">
                        Price ({currency})
                        <input type="text" name={"price-" + r.id} defaultValue={r.price} required inputMode="decimal" placeholder="0.00" />
                      </label>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8, alignItems: "center" }}>
                      <span className="muted" style={{ fontSize: 12 }}>Claimed by:</span>
                      {activeMembers.map((p) => (
                        <label className="check" key={p.id} style={{ fontSize: 12.5 }}>
                          <input type="checkbox" name={"claims-" + r.id} value={p.id} defaultChecked={r.claims.includes(p.id)} />
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
                    <input type="text" name="tax" defaultValue={existing?.bill ? (existing.bill.tax / 100).toFixed(2) : ""} inputMode="decimal" placeholder="0.00" />
                  </label>
                  <label className="field">
                    Tip
                    <input type="text" name="tip" defaultValue={existing?.bill ? (existing.bill.tip / 100).toFixed(2) : ""} inputMode="decimal" placeholder="0.00" />
                  </label>
                </div>
                <p className="muted" style={{ fontSize: 12 }}>
                  Tax and tip scale proportionally to each item. Unclaimed items stay on the payer until claimed (including fractional shares) in the Receipts Hub.
                </p>
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: 14, background: "var(--bg)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
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
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {activeMembers.map((p) => {
                  const isOn = selected.includes(p.id);
                  const idx = selected.indexOf(p.id);
                  const eqShare = perPersonEqual && idx >= 0 ? perPersonEqual[idx] : null;
                  return (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
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
                        <span>{p.name}</span>
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
                          inputMode="decimal"
                          placeholder={mode === "percent" ? "%" : mode === "shares" ? "1" : "0.00"}
                          defaultValue={defaultSplitInput(p.id)}
                          required
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <label className="field">
            Notes (optional)
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              placeholder="e.g., Paid in cash at the blue-dollar rate; Sam joined after dessert"
            />
          </label>

          <label className="field">
            Receipt photos (up to 4 images)
            <input type="file" name="photos" accept="image/*" multiple />
          </label>
        </Form>
      </div>
    </div>
  );
}
