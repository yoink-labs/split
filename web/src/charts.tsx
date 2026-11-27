import { useHomeMoney } from "./homeMoney";
import { useState } from "react";
import {
  entryPayers,
  memberName,
  moneyCompact,
  rawTransfers,
  settlementEntry,
  simplify,
  balances,
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

/** Interactive SVG Money Flow Graph showing simplified vs. raw pairwise debts. */
export function MoneyFlowGraph({
  g,
  entries,
  currency,
}: {
  g: Group;
  entries: Expense[];
  currency: string;
}) {
  const homeMoney = useHomeMoney();
  const [mode, setMode] = useState<"simplified" | "raw">("simplified");
  const net = balances(entries, currency);
  const simplified = simplify(net);
  const raw = rawTransfers(entries, currency);
  const edges = mode === "simplified" ? simplified : raw;

  const activeIDs = new Set<string>();
  for (const e of edges) {
    activeIDs.add(e.from);
    activeIDs.add(e.to);
  }
  const nodes = g.members.filter((m) => activeIDs.has(m.id) || (net[m.id] ?? 0) !== 0);
  const displayNodes = nodes.length ? nodes : g.members.filter((m) => !m.removed);

  const w = 540;
  const h = 300;
  const cx = w / 2;
  const cy = h / 2;
  const rx = 185;
  const ry = 104;

  const pos = new Map<string, { x: number; y: number }>();
  displayNodes.forEach((m, i) => {
    const angle = (i / Math.max(1, displayNodes.length)) * Math.PI * 2 - Math.PI / 2;
    pos.set(m.id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  });

  return (
    <div className="card card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>Money Flow Graph</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            {mode === "simplified"
              ? `${simplified.length} minimum transfer${simplified.length === 1 ? "" : "s"} to clear every balance (reduced from ${raw.length} raw debts)`
              : `${raw.length} direct pairwise debt${raw.length === 1 ? "" : "s"} before simplification`}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Flow mode">
          <button aria-pressed={mode === "simplified"} onClick={() => setMode("simplified")}>
            Simplified ({simplified.length})
          </button>
          <button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
            Direct ({raw.length})
          </button>
        </div>
      </div>

      {!edges.length ? (
        <div style={{ padding: "40px 16px", textAlign: "center" }}>
          <span className="tag tag-pos">All settled in {currency}</span>
          <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            No transfers needed — everyone is square.
          </p>
        </div>
      ) : (
        <svg className="flow-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Money flow graph">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--primary)" />
            </marker>
          </defs>
          {edges.map((e, idx) => {
            const p1 = pos.get(e.from);
            const p2 = pos.get(e.to);
            if (!p1 || !p2) return null;
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy) || 1;
            const pad = 34;
            const x1 = p1.x + (dx / dist) * pad;
            const y1 = p1.y + (dy / dist) * pad;
            const x2 = p2.x - (dx / dist) * (pad + 6);
            const y2 = p2.y - (dy / dist) * (pad + 6);
            const mx = (x1 + x2) / 2 - (dy / dist) * (mode === "raw" ? 18 : 10);
            const my = (y1 + y2) / 2 + (dx / dist) * (mode === "raw" ? 18 : 10);
            return (
              <g key={e.from + "-" + e.to + "-" + idx}>
                <path
                  d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="2.2"
                  strokeOpacity="0.85"
                  markerEnd="url(#arrow)"
                />
                <rect
                  x={mx - 34}
                  y={my - 11}
                  width="68"
                  height="22"
                  rx="11"
                  fill="var(--surface)"
                  stroke="var(--border)"
                />
                <text
                  x={mx}
                  y={my + 4}
                  textAnchor="middle"
                  fill="var(--ink)"
                  fontSize="11"
                  fontWeight="700"
                >
                  {homeMoney.totalText({ [currency]: e.amount })}
                </text>
              </g>
            );
          })}
          {displayNodes.map((m) => {
            const p = pos.get(m.id)!;
            const b = net[m.id] ?? 0;
            const ring = b > 0 ? "var(--pos)" : b < 0 ? "var(--neg)" : "var(--border-strong)";
            const initials = m.name.split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
            return (
              <g key={m.id} transform={`translate(${p.x}, ${p.y})`}>
                <circle r="24" fill="var(--surface)" stroke={ring} strokeWidth="2.5" />
                <text y="4" textAnchor="middle" fill="var(--ink)" fontSize="12" fontWeight="700">
                  {initials}
                </text>
                <text y="38" textAnchor="middle" fill="var(--ink)" fontSize="11.5" fontWeight="600">
                  {memberName(g, m.id).split(" ")[0]}
                </text>
                <text y="51" textAnchor="middle" fill={b > 0 ? "var(--pos)" : b < 0 ? "var(--neg)" : "var(--muted)"} fontSize="10.5" fontWeight="600">
                  {b === 0 ? "settled" : (b > 0 ? "+" : "−") + homeMoney.totalText({ [currency]: Math.abs(b) })}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
