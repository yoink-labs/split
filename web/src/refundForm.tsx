import { useState } from "react";
import { Form, useLedger } from "./context";
import { allocate, grossItems, memberName, minor, money, stamp, type Expense, type Group } from "./data";
import { itemRefund } from "../../worker/src/items";
import { Picker } from "./picker";
import { proportionalCredits, refundProblem, refundRoom, refundsOf } from "../../worker/src/refundMath";

type CreditMode = "proportional" | "equal" | "exact" | "items";
const cents = (amount: number) => (amount / 100).toFixed(2);

/**
 * Records a refund of `original`, or a standalone credit when there is no original. With
 * `resolve`, the pending original is confirmed and the refund recorded in one request.
 */
export function RefundForm({ g, original, entries, resolve = false, onDone, onCancel }: {
  g: Group;
  original?: Expense;
  entries: Expense[];
  resolve?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { save, user } = useLedger();
  const [id] = useState(() => crypto.randomUUID());
  const others = original ? refundsOf(entries, original.id) : [];
  const room = original ? refundRoom(original, others) : undefined;
  const me = g.members.find((m) => m.userID === user);
  const eligible = original
    ? g.members.filter((m) => (room!.members[m.id] ?? 0) > 0)
    : g.members.filter((m) => !m.removed);
  const [title, setTitle] = useState(original ? `Refund: ${original.title}`.slice(0, 120) : "Credit");
  const [amountText, setAmountText] = useState(room ? cents(Math.max(0, room.total)) : "");
  const [receiver, setReceiver] = useState(original?.paidBy ?? me?.id ?? g.members[0]?.id ?? "");
  const [mode, setMode] = useState<CreditMode>(original ? "proportional" : "equal");
  const [selected, setSelected] = useState<string[]>(() =>
    original ? eligible.map((m) => m.id) : eligible.filter((m) => m.id !== receiver).map((m) => m.id));
  const [exact, setExact] = useState<Record<string, string>>({});
  // Refunding specific receipt items credits each person exactly what those items cost them.
  const refundedItems = new Set(others.flatMap((r) => r.refundItems ?? []));
  const refundable = original?.bill ? grossItems(original.bill).filter((i) => !refundedItems.has(i.id)) : [];
  const [itemIDs, setItemIDs] = useState<string[]>([]);
  let itemCredit: ReturnType<typeof itemRefund> | null = null;
  try { itemCredit = mode === "items" && original && itemIDs.length ? itemRefund(original, itemIDs) : null; } catch { itemCredit = null; }

  let amount: number | null = null;
  try { amount = mode === "items" ? itemCredit?.amount ?? null : amountText ? minor(amountText) : null; } catch { amount = null; }

  function credits(total: number) {
    if (mode === "items") {
      if (!itemCredit) throw new Error("Choose the items that were refunded.");
      return itemCredit.splits;
    }
    if (mode === "exact") return selected.map((memberID) => ({ memberID, amount: minor(exact[memberID] || "0") }));
    if (!selected.length) throw new Error("Choose who gets the credit.");
    if (mode === "proportional" && room) return proportionalCredits(total, room.members, selected);
    const amounts = allocate(total, selected.map(() => 1));
    return selected.map((memberID, i) => ({ memberID, amount: amounts[i] }));
  }
  let preview: { memberID: string; amount: number }[] = [];
  try { preview = amount ? credits(amount) : []; } catch { preview = []; }

  const currency = original?.currency ?? g.currency;
  const exchange = original?.exchange && {
    target: original.exchange.target, rateE8: original.exchange.rateE8, date: original.exchange.date,
    source: original.exchange.source === "Statement" ? "Manual" as const : original.exchange.source,
  };

  return (
    <div className="refund-form">
      <Form
        label={resolve ? "Confirm and record refund" : original ? "Record refund" : "Record credit"}
        cancel={onCancel}
        submit={async () => {
          const total = mode === "items" ? itemCredit?.amount ?? 0 : minor(amountText);
          if (!total) throw new Error(mode === "items" ? "Choose the items that were refunded." : "Enter a refund greater than zero.");
          const splits = credits(total).filter((s) => s.amount > 0);
          const refund = {
            id, groupID: g.id, title: title.trim() || (original ? "Refund" : "Credit"), amount: total, currency,
            paidBy: receiver, splits, kind: "refund" as const,
            splitMode: mode === "proportional" ? "shares" as const : mode === "items" ? "exact" as const : mode, createdAt: stamp(),
            ...(original ? { refundOf: original.id } : {}),
            ...(mode === "items" ? { refundItems: itemIDs } : {}),
            ...(original?.category ? { category: original.category } : {}),
            ...(exchange ? { exchange } : {}),
          };
          const problem = refundProblem(refund, original, others, g.members);
          if (problem) throw new Error(problem);
          if (resolve && original) await save(`/v1/entries/${original.id}/resolve`, { action: "refund", refund });
          else await save("/v1/entries", refund);
          onDone();
        }}
      >
        {original && room && (
          <p className="muted refund-room">
            {room.total > 0 ? <>Up to <b className="num">{money(room.total, currency)}</b> of {money(original.amount, currency)} is left to refund.</>
              : "This expense has already been fully refunded."}
          </p>
        )}
        {!original && <p className="muted">A credit gives money back to people without tying it to one expense, for example an overcharge.</p>}
        <div className="form-row">
          <label className="field">
            Description
            <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field">
            Amount ({currency})
            {mode === "items"
              ? <input type="text" value={amount ? cents(amount) : ""} readOnly placeholder="Choose items" aria-describedby="refund-items-note" />
              : <input type="text" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} required placeholder="0.00" />}
          </label>
        </div>
        <Picker label={original ? "Refund received by" : "Credit given by"} value={receiver} onChange={setReceiver}
          options={g.members.filter((m) => !m.removed || m.id === receiver).map((m) => ({ value: m.id, label: m.name }))} />
        <small className="muted">
          {original ? "Received by: who got the money back, for example the card the vendor refunded." : "Given by: who holds the money owed to the people credited."}
        </small>
        <div className="seg" role="group" aria-label="Divide the credit">
          {refundable.length > 0 && <button type="button" aria-pressed={mode === "items"} onClick={() => setMode("items")}>Items</button>}
          {original && <button type="button" aria-pressed={mode === "proportional"} onClick={() => setMode("proportional")}>By share</button>}
          <button type="button" aria-pressed={mode === "equal"} onClick={() => setMode("equal")}>Equally</button>
          <button type="button" aria-pressed={mode === "exact"} onClick={() => setMode("exact")}>Amounts</button>
        </div>
        {mode === "items" && (
          <fieldset className="refund-people refund-items">
            <legend id="refund-items-note">Items refunded · each person gets back what the item cost them, tax and tip included</legend>
            {refundable.map((i) => (
              <div key={i.id} className="refund-person">
                <label>
                  <input type="checkbox" checked={itemIDs.includes(i.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...itemIDs, i.id] : itemIDs.filter((x) => x !== i.id);
                      setItemIDs(next);
                      if (title.startsWith("Refund")) {
                        const names = original!.bill!.items.filter((x) => next.includes(x.id)).map((x) => x.title).join(", ");
                        setTitle(`Refund: ${names || original!.title}`.slice(0, 120));
                      }
                    }} />
                  {i.title}
                  <small className="muted"> · {i.memberIDs.length ? i.memberIDs.map((id) => memberName(g, id)).join(", ") : "unclaimed"}</small>
                </label>
                <b className="num">{money(i.gross, currency)}</b>
              </div>
            ))}
          </fieldset>
        )}
        <fieldset className="refund-people">
          <legend>{original ? "Credit the people who shared it" : "Credit to"}</legend>
          {eligible.map((m) => {
            const checked = selected.includes(m.id);
            const credit = preview.find((p) => p.memberID === m.id)?.amount ?? 0;
            return (
              <div key={m.id} className="refund-person">
                <label>
                  <input type="checkbox" checked={mode === "items" ? credit > 0 : checked} disabled={mode === "items"}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, m.id] : selected.filter((x) => x !== m.id))} />
                  {m.name}
                  {room && <small className="muted"> · up to {money(room.members[m.id] ?? 0, currency)}</small>}
                </label>
                {mode === "items"
                  ? <b className="num">{credit ? money(credit, currency) : "—"}</b>
                  : mode === "exact" && checked
                  ? <input type="text" inputMode="decimal" aria-label={`Credit for ${m.name}`} value={exact[m.id] ?? ""} placeholder="0.00"
                    onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} />
                  : <b className="num">{checked ? money(credit, currency) : "—"}</b>}
              </div>
            );
          })}
        </fieldset>
        {amount !== null && preview.length > 0 && (
          <p className="muted">
            {memberName(g, receiver)}’s balance goes down by {money(amount, currency)}; {preview.filter((p) => p.amount > 0).map((p) => memberName(g, p.memberID)).join(", ")} {preview.length === 1 ? "is" : "are"} credited.
          </p>
        )}
      </Form>
    </div>
  );
}
