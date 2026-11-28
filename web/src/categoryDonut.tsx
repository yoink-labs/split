import { useState } from "react";
import type { CategoryTotal } from "./analytics";
import { categoryMeta } from "./categories";
import { CategoryIcon } from "./ui";

/**
 * Interactive SVG donut + ranked category breakdown backed by `analyze()` in `web/src/analytics.ts`.
 * Amounts are integer cents (refunds net out); percentages come from largest-remainder `percents()`.
 */
export function CategoryDonut({
  categories,
  total,
  format,
  active = "",
  onSelect,
  compact = false,
}: {
  categories: CategoryTotal[];
  total: number;
  format: (amount: number) => string;
  active?: string;
  onSelect?: (id: string) => void;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState("");
  const positive = categories.filter((c) => c.amount > 0);
  const positiveTotal = positive.reduce((sum, c) => sum + c.amount, 0);
  const max = Math.max(1, ...categories.map((c) => Math.abs(c.amount)));

  const focusID = hovered || active;
  const focused = focusID ? categories.find((c) => c.id === focusID) : undefined;
  const centerLabel = focused ? categoryMeta(focused.id).label : "Net spend";
  const centerValue = format(focused ? focused.amount : total);
  const centerSub = focused ? `${focused.percent}% · ${focused.count} ${focused.count === 1 ? "item" : "items"}` : `${categories.length} ${categories.length === 1 ? "category" : "categories"}`;

  // Scale center readout font size so even long currency figures fit cleanly inside the donut hole.
  const valFontSize = centerValue.length > 13 ? 11.5 : centerValue.length > 10 ? 13 : 15;

  const size = compact ? 156 : 172;
  const cx = size / 2;
  const radius = compact ? 58 : 65;
  const strokeWidth = compact ? 18 : 20;
  const circumference = 2 * Math.PI * radius;
  const gap = positive.length > 1 ? 2 : 0;
  let offset = 0;

  return (
    <div className={"donut-layout" + (compact ? " donut-compact" : "")}>
      <div className="donut-stage">
        <svg
          className="donut-svg"
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={`Spending by category, total ${format(total)}`}
        >
          <circle
            cx={cx}
            cy={cx}
            r={radius}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={strokeWidth}
          />
          {positiveTotal > 0 && positive.map((c) => {
            const meta = categoryMeta(c.id);
            const frac = c.amount / positiveTotal;
            const segLen = frac * circumference;
            const dashLen = Math.max(1.5, segLen - gap);
            const dashOffset = -offset;
            offset += segLen;
            const isActive = focusID === c.id;
            const dimmed = Boolean(focusID && !isActive);
            return (
              <circle
                key={c.id}
                cx={cx}
                cy={cx}
                r={radius}
                fill="none"
                stroke={meta.color}
                strokeWidth={isActive ? strokeWidth + 3 : strokeWidth}
                strokeDasharray={`${dashLen} ${circumference}`}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${cx} ${cx})`}
                className={"donut-slice" + (onSelect ? " clickable" : "") + (dimmed ? " dimmed" : "")}
                onMouseEnter={() => setHovered(c.id)}
                onMouseLeave={() => setHovered("")}
                onClick={() => onSelect?.(c.id)}
              >
                <title>{`${meta.label}: ${format(c.amount)} (${c.percent}%)`}</title>
              </circle>
            );
          })}
          <text x={cx} y={cx - 12} textAnchor="middle" fill="var(--muted)" fontSize="10.5" fontWeight="600">
            {centerLabel.length > 16 ? centerLabel.slice(0, 15) + "…" : centerLabel}
          </text>
          <text
            x={cx}
            y={cx + 6}
            textAnchor="middle"
            fill="var(--ink)"
            fontSize={valFontSize}
            fontWeight="750"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {centerValue}
          </text>
          <text x={cx} y={cx + 22} textAnchor="middle" fill="var(--muted)" fontSize="10" fontWeight="550">
            {centerSub}
          </text>
        </svg>
      </div>

      <ul className="donut-list" aria-label="Category breakdown">
        {categories.map((c) => {
          const meta = categoryMeta(c.id);
          const isSelected = active === c.id;
          const isHovered = hovered === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                className={"donut-row" + (isHovered ? " hovered" : "")}
                aria-pressed={onSelect ? isSelected : undefined}
                onMouseEnter={() => setHovered(c.id)}
                onMouseLeave={() => setHovered("")}
                onFocus={() => setHovered(c.id)}
                onBlur={() => setHovered("")}
                onClick={() => onSelect?.(c.id)}
              >
                <CategoryIcon category={c.id} />
                <span className="donut-row-main">
                  <span className="donut-row-top">
                    <b>{meta.label}</b>
                    <small className="muted">{c.count}</small>
                  </span>
                  <span className="donut-row-bar" aria-hidden="true">
                    <span style={{ inlineSize: `${(Math.max(0, c.amount) / max) * 100}%`, background: meta.color }} />
                  </span>
                </span>
                <span className="donut-row-val">
                  <b className={"num" + (c.amount < 0 ? " pos" : "")}>{format(c.amount)}</b>
                  <small className="muted num">{c.amount < 0 ? "credit" : `${c.percent}%`}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
