import { useHomeMoney } from "./homeMoney";
import { useState } from "react";
import { categoryMeta } from "./categories";
import {
  dayHeading,
  entryPayers,
  memberName,
  moneyCompact,
  monthHeading,
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
  onSelectMember,
}: {
  g: Group;
  entries: Expense[];
  currency: string;
  onSelectMember?: (memberID: string) => void;
}) {
  const expenses = entries
    .map(settlementEntry)
    .filter((e) => e.kind === "expense" && e.currency === currency);
  const rows = g.members
    .map((m) => {
      const paid = expenses.reduce(
        (s, e) => s + entryPayers(e).filter((p) => p.memberID === m.id).reduce((n, p) => n + p.amount, 0),
        0,
      );
      const share = expenses.reduce(
        (s, e) => s + (e.splits.find((x) => x.memberID === m.id)?.amount ?? 0),
        0,
      );
      return { member: m, paid, share, net: paid - share };
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
                  Paid <b style={{ color: "var(--ink)" }}>{moneyCompact(r.paid, currency)}</b> · Share{" "}
                  <b style={{ color: "var(--ink)" }}>{moneyCompact(r.share, currency)}</b>
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

/** Interactive SVG Donut + clickable category breakdown. */
export function CategoryChart({
  entries,
  currency,
  onSelectCategory,
}: {
  entries: Expense[];
  currency: string;
  onSelectCategory?: (category: string) => void;
}) {
  const expenses = entries
    .map(settlementEntry)
    .filter((e) => e.kind === "expense" && e.currency === currency);
  const buckets = new Map<string, number>();
  for (const e of expenses) {
    const key = e.category || "Other";
    buckets.set(key, (buckets.get(key) ?? 0) + e.amount);
  }
  const items = [...buckets.entries()]
    .map(([name, amount]) => ({ name, amount, meta: categoryMeta(name) }))
    .sort((a, b) => b.amount - a.amount);
  const total = items.reduce((s, i) => s + i.amount, 0);

  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="card card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700 }}>Spend by Category</h3>
        <span className="muted" style={{ fontSize: 12 }}>Click to filter</span>
      </div>
      {!total ? (
        <p className="muted">No categorized expenses in {currency} yet.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "144px minmax(0, 1fr)", gap: 16, alignItems: "center" }}>
          <svg viewBox="0 0 144 144" width="144" height="144" aria-label="Spend by category chart">
            <circle cx="72" cy="72" r={radius} fill="none" stroke="var(--surface-2)" strokeWidth="18" />
            {items.map((item) => {
              const frac = item.amount / total;
              const len = frac * circumference;
              const dashOffset = -offset;
              offset += len;
              return (
                <circle
                  key={item.name}
                  cx="72"
                  cy="72"
                  r={radius}
                  fill="none"
                  stroke={item.meta.color}
                  strokeWidth="18"
                  strokeDasharray={`${Math.max(1, len - 1.5)} ${circumference}`}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 72 72)"
                  style={{ cursor: onSelectCategory ? "pointer" : "default" }}
                  onClick={() => onSelectCategory?.(item.name)}
                >
                  <title>{`${item.meta.label}: ${moneyCompact(item.amount, currency)} (${Math.round(frac * 100)}%)`}</title>
                </circle>
              );
            })}
            <text x="72" y="69" textAnchor="middle" fill="var(--muted)" fontSize="10" fontWeight="600">
              Total
            </text>
            <text x="72" y="85" textAnchor="middle" fill="var(--ink)" fontSize="13.5" fontWeight="700">
              {moneyCompact(total, currency)}
            </text>
          </svg>
          <div className="chart-legend">
            {items.slice(0, 6).map((item) => (
              <button
                key={item.name}
                type="button"
                className="legend-row"
                onClick={() => onSelectCategory?.(item.name)}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: item.meta.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.meta.label}
                  </span>
                </span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {moneyCompact(item.amount, currency)}{" "}
                  <span className="muted" style={{ fontWeight: 500 }}>
                    {Math.round((item.amount / total) * 100)}%
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Daily (for trips) or Monthly (for long-term groups) spending bar chart. */
export function TimelineChart({
  g,
  entries,
  currency,
}: {
  g: Group;
  entries: Expense[];
  currency: string;
}) {
  const byDay = g.kind === "trip";
  const expenses = entries
    .map(settlementEntry)
    .filter((e) => e.kind === "expense" && e.currency === currency);
  const buckets = new Map<string, number>();
  for (const e of expenses) {
    const key = byDay ? e.createdAt.slice(0, 10) : e.createdAt.slice(0, 7);
    buckets.set(key, (buckets.get(key) ?? 0) + e.amount);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(1, ...points.map((p) => p[1]));

  return (
    <div className="card card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700 }}>
          {byDay ? "Daily Trip Spend" : "Monthly Spend"}
        </h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {points.length} {byDay ? (points.length === 1 ? "day" : "days") : points.length === 1 ? "month" : "months"}
        </span>
      </div>
      {!points.length ? (
        <p className="muted">No spending timeline yet.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
            gap: 8,
            alignItems: "end",
            height: 150,
            paddingTop: 18,
          }}
        >
          {points.map(([key, amount]) => {
            const pct = Math.max(6, Math.round((amount / max) * 100));
            const label = byDay ? key.slice(5) : key.slice(2);
            const full = byDay ? dayHeading(key) : monthHeading(key);
            return (
              <div
                key={key}
                title={`${full}: ${moneyCompact(amount, currency)}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  height: "100%",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <span className="num" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  {moneyCompact(amount, currency).replace(/\.00$/, "")}
                </span>
                <div
                  style={{
                    width: "100%",
                    maxWidth: 42,
                    height: `${pct}%`,
                    background: "var(--primary)",
                    borderRadius: "6px 6px 2px 2px",
                    opacity: 0.88,
                  }}
                />
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  {label}
                </span>
              </div>
            );
          })}
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
