import { useHomeMoney } from "./homeMoney";
import { useState } from "react";
import {
  entryPayers,
  moneyCompact,
  settlementEntry,
  type Expense,
  type Group,
} from "./data";

/** Grouped horizontal bar chart comparing Paid vs. Fair Share per member. */
export function PaidVsShareChart({
  g,
  entries,
  currency,
  convertedIDs,
  onSelectMember,
}: {
  g: Group;
  entries: Expense[];
  currency: string;
  convertedIDs: ReadonlySet<string>;
  onSelectMember?: (memberID: string) => void;
}) {
  const expenses = entries
    .map(settlementEntry)
    .filter((e) => e.kind === "expense" && e.currency === currency);
  const rows = g.members
    .map((m) => {
      let paid = 0, share = 0;
      let estimatedPaid = false, estimatedShare = false;
      for (const entry of expenses) {
        const paidAmount = entryPayers(entry).find((payer) => payer.memberID === m.id)?.amount ?? 0;
        const shareAmount = entry.splits.find((split) => split.memberID === m.id)?.amount ?? 0;
        paid += paidAmount;
        share += shareAmount;
        if (convertedIDs.has(entry.id)) {
          estimatedPaid ||= paidAmount > 0;
          estimatedShare ||= shareAmount > 0;
        }
      }
      return { member: m, paid, share, estimatedPaid, estimatedShare };
    })
    .filter((r) => !r.member.removed || r.paid > 0 || r.share > 0);

  const maxVal = Math.max(1, ...rows.flatMap((r) => [r.paid, r.share]));

  return (
    <div className="card card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700 }}>Paid vs. Fair Share</h3>
        <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: "var(--muted)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--primary)" }} /> Paid
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: "#94A3B8" }} /> Share
          </span>
        </div>
      </div>
      {!rows.length ? (
        <p className="muted">No expenses in {currency} yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div
              key={r.member.id}
              onClick={() => onSelectMember?.(r.member.id)}
              style={{ cursor: onSelectMember ? "pointer" : "default" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                <strong>
                  {r.member.name}
                  {r.member.removed && <span className="muted"> (archived)</span>}
                </strong>
                <span className="num" style={{ fontSize: 12, color: "var(--muted)" }}>
                  Paid <b style={{ color: "var(--ink)" }}>{r.estimatedPaid && "≈ "}{moneyCompact(r.paid, currency)}</b> · Share{" "}
                  <b style={{ color: "var(--ink)" }}>{r.estimatedShare && "≈ "}{moneyCompact(r.share, currency)}</b>
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div className="bar-track" style={{ height: 7 }}>
                  <div
                    className="bar-fill"
                    style={{ width: `${(r.paid / maxVal) * 100}%`, background: "var(--primary)" }}
                  />
                </div>
                <div className="bar-track" style={{ height: 7 }}>
                  <div
                    className="bar-fill"
                    style={{ width: `${(r.share / maxVal) * 100}%`, background: "#94A3B8" }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
