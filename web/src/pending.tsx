import { useState } from "react";
import { Form, useLedger } from "./context";
import { entryPayers, memberName, minor, money, type Expense, type Group } from "./data";
import { useHomeMoney } from "./homeMoney";
import { RefundForm } from "./refundForm";
import { refundRoom, refundsOf } from "../../worker/src/refundMath";

/** Author or payer (receiver, for a refund) may mark or resolve a pending entry. */
export function canResolve(g: Group, entry: Expense, user: string) {
  return entry.kind !== "settlement" && (entry.editable || entryPayers(entry).some((p) =>
    g.members.some((m) => m.id === p.memberID && m.userID === user && !m.removed)));
}

export function PendingPanel({ g, entry, entries }: { g: Group; entry: Expense; entries: Expense[] }) {
  const { save, user } = useLedger();
  const [step, setStep] = useState<"" | "mark" | "adjust" | "refund">("");
  const [note, setNote] = useState("");
  const [amountText, setAmountText] = useState((entry.amount / 100).toFixed(2));
  const allowed = canResolve(g, entry, user);
  const refunds = refundsOf(entries, entry.id);
  const refunded = entry.amount - refundRoom(entry, refunds).total;

  if (!entry.pending) {
    if (!allowed || entry.handled) return null;
    return step === "mark" ? (
      <div className="card card-pad pending-card">
        <Form label="Mark as pending" cancel={() => setStep("")} submit={async () => {
          await save(`/v1/entries/${entry.id}/pending`, { pending: true, ...(note.trim() ? { note: note.trim() } : {}) });
          setStep("");
        }}>
          <p className="muted">Pending entries still count toward balances. Everyone sees that the amount may change.</p>
          <label className="field">
            Why is it pending? (optional)
            <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., Waiting to hear if Sam’s ticket is refunded" />
          </label>
        </Form>
      </div>
    ) : (
      <div><button type="button" className="btn btn-sm" onClick={() => setStep("mark")}>Mark as pending</button></div>
    );
  }

  return (
    <div className="card card-pad pending-card" role="region" aria-label="Pending entry">
      <div className="pending-head">
        <span className="tag tag-pending">Pending</span>
        <strong>The amount may still change</strong>
      </div>
      {entry.pendingNote && <p className="pending-note">“{entry.pendingNote}”</p>}
      <p className="muted" style={{ fontSize: 12.5 }}>
        It counts toward balances. Settle up shows balances with and without it.
      </p>
      {!allowed ? (
        <p className="muted" style={{ fontSize: 12.5 }}>The person who recorded it or a payer can resolve it.</p>
      ) : step === "adjust" ? (
        <Form label="Save new amount" cancel={() => setStep("")} submit={async () => {
          const amount = minor(amountText);
          if (amount <= 0) throw new Error("Enter an amount greater than zero.");
          if (amount < refunded) throw new Error(`This expense already has ${money(refunded, entry.currency)} in refunds. Keep the amount at or above it.`);
          await save(`/v1/entries/${entry.id}/resolve`, { action: "adjust", amount });
          setStep("");
        }}>
          <label className="field">
            Final amount ({entry.currency})
            <input type="text" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} required autoFocus />
          </label>
          <small className="muted">Every share and payer is rescaled to the new total, exact to the cent.</small>
        </Form>
      ) : step === "refund" ? (
        <RefundForm g={g} original={entry} entries={entries} resolve onDone={() => setStep("")} onCancel={() => setStep("")} />
      ) : (
        <div className="pending-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void save(`/v1/entries/${entry.id}/resolve`, { action: "confirm" })}>
            Confirm
          </button>
          {!entry.bill && <button type="button" className="btn btn-sm" onClick={() => setStep("adjust")}>Adjust amount</button>}
          {entry.kind === "expense" && <button type="button" className="btn btn-sm" onClick={() => setStep("refund")}>Turn into refund</button>}
        </div>
      )}
    </div>
  );
}

/** Pending entries for settle-up, with the balance with and without them. */
export function PendingSummary({ g, pending, withPending, confirmedOnly, currency, me }: {
  g: Group; pending: Expense[]; withPending: Record<string, number>; confirmedOnly: Record<string, number>; currency: string; me?: string;
}) {
  const homeMoney = useHomeMoney();
  if (!pending.length) return null;
  const changed = g.members.filter((m) => (withPending[m.id] ?? 0) !== (confirmedOnly[m.id] ?? 0));
  const signed = (amount: number) => (amount > 0 ? "+" : amount < 0 ? "−" : "") + money(Math.abs(amount), currency);
  return (
    <div className="card pending-summary" role="note">
      <div className="card-head">
        <h3><span className="tag tag-pending">Pending</span> {pending.length} {pending.length === 1 ? "entry" : "entries"} · {currency}</h3>
      </div>
      <div className="card-pad">
        <p className="muted" style={{ fontSize: 12.5 }}>
          Balances below include pending entries. The confirmed-only column leaves them out.
        </p>
        <ul className="pending-list">
          {pending.map((e) => (
            <li key={e.id}>
              <strong>{e.title}</strong> <b className="num">{e.kind === "refund" ? homeMoney.entry(e).replace(/^(≈ )?/, "$1−") : homeMoney.entry(e)}</b>
              {e.pendingNote && <span className="muted"> · {e.pendingNote}</span>}
            </li>
          ))}
        </ul>
        <table className="ledger-table pending-balances">
          <thead><tr><th scope="col">Person</th><th scope="col" className="ledger-number">With pending</th><th scope="col" className="ledger-number">Confirmed only</th></tr></thead>
          <tbody>
            {changed.map((m) => (
              <tr key={m.id}>
                <th scope="row">{memberName(g, m.id)}{m.id === me && <span className="tag tag-primary">You</span>}</th>
                <td className="ledger-number num">{signed(withPending[m.id] ?? 0)}</td>
                <td className="ledger-number num">{signed(confirmedOnly[m.id] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
