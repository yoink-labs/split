import { useId, useMemo, useState } from "react";
import { AVATAR_PRESETS, avatarStyleFor, categoryMeta } from "./categories";
import { dayHeading, memberName, monthHeading, type Expense, type Group } from "./data";
import { Picker } from "./picker";
import { Avatar, CategoryIcon } from "./ui";

type SpendRow = { entry: Expense; category: string; period: string; amount: number; estimated: boolean };
type Segment = { id: string; label: string; color: string; amount: number };
const PERSON_COLORS = [0, 2, 4, 6, 3, 5, 1, 7].map((index) => AVATAR_PRESETS[index].bg);
const HOUSING = new Set(["Lodging", "Rent & Utilities"]);
const axisFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const periodFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

function totals(rows: SpendRow[], key: "category" | "period") {
  const result = new Map<string, number>();
  for (const row of rows) result.set(row[key], (result.get(row[key]) ?? 0) + row.amount);
  return result;
}

function periodKeys(rows: SpendRow[], daily: boolean, start?: string, end?: string) {
  const dates = [...new Set(rows.map((row) => row.period))].sort();
  if (!daily || !dates.length) return dates;
  const first = start && start < dates[0] ? start : dates[0];
  const last = end && end > dates[dates.length - 1] ? end : dates[dates.length - 1];
  const origin = Date.parse(first + "T00:00:00Z");
  const length = Math.round((Date.parse(last + "T00:00:00Z") - origin) / 86400000) + 1;
  // Keep days with no expenses visible on short trips.
  return length > 0 && length <= 62
    ? Array.from({ length }, (_, i) => new Date(origin + i * 86400000).toISOString().slice(0, 10))
    : dates;
}

export function SpendingDashboard({ group, entries, currency, convertedIDs, format, onOpenEntry }: {
  group: Group;
  entries: Expense[];
  currency: string;
  convertedIDs: ReadonlySet<string>;
  format: (amount: number, estimated?: boolean) => string;
  onOpenEntry: (entry: Expense) => void;
}) {
  const [by, setBy] = useState<"category" | "people">("category");
  const [member, setMember] = useState("");
  const [housing, setHousing] = useState(false);
  const [period, setPeriod] = useState("");
  const [category, setCategory] = useState("");
  const [daily, setDaily] = useState(group.kind === "trip");
  const headingID = useId();
  const rows = useMemo(() => entries
    .filter((entry) => entry.kind === "expense" && entry.currency === currency)
    .map((entry) => ({
      entry, category: categoryMeta(entry.category).id,
      period: entry.createdAt.slice(0, daily ? 10 : 7),
      amount: entry.amount,
      estimated: convertedIDs.has(entry.id),
    })), [entries, currency, daily, convertedIDs]);
  const people = group.members.filter((person) => !person.removed || rows.some(({ entry }) =>
    entry.splits.some((split) => split.memberID === person.id && split.amount > 0)));
  const person = people.find((candidate) => candidate.id === member);
  const shares = person ? rows.map((row) => ({
    ...row, amount: row.entry.splits.find((split) => split.memberID === person.id)?.amount ?? 0,
  })).filter((row) => row.amount > 0) : rows;
  const housingRows = shares.filter((row) => HOUSING.has(row.category));
  const housingTotal = housingRows.reduce((sum, row) => sum + row.amount, 0);
  const scoped = housing ? housingRows : shares;
  const total = scoped.reduce((sum, row) => sum + row.amount, 0);
  const periods = periodKeys(rows, daily, group.startDate ?? undefined, group.endDate ?? undefined);
  const byPeriod = totals(scoped, "period");
  const estimatedPeriods = new Set(scoped.filter((row) => row.estimated).map((row) => row.period));
  const periodAmount = (key: string) => format(byPeriod.get(key) ?? 0, estimatedPeriods.has(key));
  const max = Array.from(byPeriod.values()).reduce((highest, amount) => Math.max(highest, amount), 0);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, max / 4)));
  const tick = Math.ceil(max / 4 / magnitude) * magnitude || 1;
  const ceiling = tick * 4;
  const activePeriod = periods.includes(period) ? period : "";
  const detail = activePeriod ? scoped.filter((row) => row.period === activePeriod) : scoped;
  const detailTotal = detail.reduce((sum, row) => sum + row.amount, 0);
  const grouping = person ? "category" : by;
  const textPeriod = daily ? dayHeading : monthHeading;
  const usedColors = new Set<string>();
  const personLabels = new Map(people.map((p) => {
    const avatar = avatarStyleFor(p.name, p.avatarURL);
    const preferred = avatar.image ? avatarStyleFor(p.name).bg : avatar.bg;
    const color = usedColors.has(preferred) ? PERSON_COLORS.find((candidate) => !usedColors.has(candidate)) ?? preferred : preferred;
    usedColors.add(color);
    return [p.id, { label: p.name, color }];
  }));
  const estimatedCategories = new Set(detail.filter((row) => row.estimated).map((row) => row.category));
  const denominator = BigInt(detailTotal || 1);
  const breakdown = [...totals(detail, "category")].sort((a, b) => b[1] - a[1]).map(([id, amount]) => {
    const scaled = BigInt(amount) * 100n;
    return { id, amount, percent: Number(scaled / denominator), remainder: scaled % denominator };
  });
  const pointsLeft = detailTotal ? 100 - breakdown.reduce((sum, row) => sum + row.percent, 0) : 0;
  const byRemainder = [...breakdown].sort((a, b) => a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1);
  for (const row of byRemainder.slice(0, pointsLeft)) row.percent += 1;
  const activeCategory = breakdown.some(({ id }) => id === category) ? category : "";
  const transactions = activeCategory ? detail.filter((row) => row.category === activeCategory) : detail;
  const [limit, setLimit] = useState(5);
  const stacks = new Map<string, Map<string, number>>();
  for (const row of scoped) {
    let parts = stacks.get(row.period);
    if (!parts) stacks.set(row.period, parts = new Map());
    const slices = grouping === "people" ? row.entry.splits.map((split) => [split.memberID, split.amount] as const)
      : [[row.category, row.amount] as const];
    for (const [id, amount] of slices) {
      if (amount > 0) parts.set(id, (parts.get(id) ?? 0) + amount);
    }
  }
  const segment = (id: string) => grouping === "people"
    ? personLabels.get(id) ?? { label: memberName(group, id), color: "#64748b" }
    : categoryMeta(id);
  const legendTotals = new Map<string, number>();
  for (const parts of stacks.values()) {
    for (const [id, amount] of parts) legendTotals.set(id, (legendTotals.get(id) ?? 0) + amount);
  }
  const legend: Segment[] = [...legendTotals]
    .map(([id, amount]) => ({ id, amount, ...segment(id) }))
    .sort((a, b) => b.amount - a.amount);

  const legendOrder = new Map(legend.map((item, index) => [item.id, index]));

  function selectMember(id: string) {
    setMember(id);
    if (id) setBy("category");
    setCategory("");
    setLimit(5);
  }

  return (
    <section aria-labelledby={headingID} className="spend-board card">
      <header className="spend-header">
        <div>
          <h2 id={headingID}>{daily ? group.kind === "trip" ? "Daily trip spend" : "Daily spend" : "Monthly spend"}</h2>
          <p className="muted">{person ? person.name + "’s allocated share" : "Group expenses"} · {currency}</p>
        </div>
        <div className="spend-controls">
          <div className="seg" role="group" aria-label="Color bars by">
            <button type="button" aria-pressed={grouping === "category"} onClick={() => setBy("category")}>Category</button>
            <button type="button" aria-pressed={grouping === "people"} onClick={() => {
              selectMember("");
              setBy("people");
            }}>Person</button>
          </div>
          <Picker label="Spending for" value={person?.id ?? ""} search={people.length > 8} onChange={selectMember}
            options={[{ value: "", label: "Everyone" }, ...people.map((p) => ({
              value: p.id, label: p.name, icon: <Avatar name={p.name} avatarURL={p.avatarURL} size={21} />,
            }))]} />
        </div>
      </header>
      <div className="spend-grid">
        <div className="spend-main">
          <div className="spend-metrics">
            <div>
              <span>{housing ? "Housing spend" : person ? "Total share" : "Total spend"}</span>
              <strong className="num">{format(total, scoped.some((row) => row.estimated))}</strong>
            </div>
            <button type="button" className="spend-housing" aria-pressed={housing} onClick={() => {
              setHousing(!housing); setPeriod(""); setCategory(""); setLimit(5);
            }}>
              <CategoryIcon category="Lodging" />
              <span><b>Housing</b><small>Lodging and rent & utilities</small></span>
              <strong className="num">{format(housingTotal, housingRows.some((row) => row.estimated))}</strong>
            </button>
          </div>
          {periods.length > 0 && <div className="spend-resolution">
            {activePeriod ? <span>{textPeriod(activePeriod)} · <b>{periodAmount(activePeriod)}</b></span>
              : <span>Select a date to see its expenses</span>}
            <div className="seg" role="group" aria-label="Group spending by date">
              {[true, false].map((isDaily) => (
                <button type="button" key={String(isDaily)} aria-pressed={daily === isDaily} onClick={() => {
                  setDaily(isDaily); setPeriod(""); setCategory(""); setLimit(5);
                }}>{isDaily ? "Day" : "Month"}</button>
              ))}
            </div>
          </div>}
          {periods.length > 0 ? (
            <div className="spend-plot">
              <div className="spend-axis" aria-hidden="true">
                {[4, 3, 2, 1, 0].map((n) => <span key={n}>{axisFormat.format(n * tick / 100)}</span>)}
              </div>
              <div className="spend-scroll" tabIndex={periods.length > 9 ? 0 : undefined}
                role="group" aria-label="Spending timeline">
                <div className="spend-columns" style={{ gridTemplateColumns: `repeat(${periods.length}, minmax(${daily ? 44 : 66}px, 1fr))` }}>
                  <div className="spend-gridlines" aria-hidden="true"><i /><i /><i /><i /><i /></div>
                  {periods.map((key) => {
                    const amount = byPeriod.get(key) ?? 0;
                    const parts = stacks.get(key);
                    const label = daily
                      ? periodFormat.format(new Date(key + "T00:00:00Z"))
                      : monthFormat.format(new Date(key + "-01T00:00:00Z"));
                    return (
                      <button key={key} type="button" className="spend-column" aria-pressed={activePeriod === key}
                        aria-label={`${textPeriod(key)}, ${periodAmount(key)}`} title={`${textPeriod(key)} · ${periodAmount(key)}`}
                        onClick={() => { setPeriod(activePeriod === key ? "" : key); setCategory(""); setLimit(5); }}>
                        <span className="spend-column-track">
                          <span className="spend-column-stack" style={{ height: `${amount / ceiling * 100}%` }}>
                            {parts && [...parts].sort(([a], [b]) => (legendOrder.get(a) ?? 0) - (legendOrder.get(b) ?? 0))
                              .map(([id, part]) => <span key={id} style={{ flexGrow: part, background: segment(id).color }} />)}
                          </span>
                        </span>
                        <span className="spend-date">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : <p className="spend-empty muted">Add an expense to see spending over time.</p>}
          {legend.length > 0 && <div className="spend-legend" aria-label="Chart legend">
            {legend.map((item) => grouping === "people" ? (
              <button type="button" key={item.id} onClick={() => selectMember(item.id)}
                disabled={!personLabels.has(item.id)}><i style={{ background: item.color }} />{item.label}</button>
            ) : (
              <span key={item.id}><i style={{ background: item.color }} />{item.label}</span>
            ))}
          </div>}
        </div>
        <aside className="spend-detail">
          <header>
            <div>
              <h3>{activePeriod ? textPeriod(activePeriod) : housing ? "Housing breakdown" : "Spending breakdown"}</h3>
              <strong className="num">{format(detailTotal, detail.some((row) => row.estimated))}</strong>
            </div>
            {activePeriod && <button type="button" className="btn btn-xs" onClick={() => {
              setPeriod(""); setCategory(""); setLimit(5);
            }}>All dates</button>}
          </header>
          <div className="spend-breakdown" aria-label="Spending by category">
            {breakdown.map(({ id, amount, percent }) => {
              const meta = categoryMeta(id);
              return (
                <button type="button" key={id} aria-pressed={activeCategory === id} onClick={() => {
                  setCategory(activeCategory === id ? "" : id); setLimit(5);
                }}>
                  <i style={{ background: meta.color }} />
                  <span>{meta.label}</span>
                  <b className="num">{format(amount, estimatedCategories.has(id))}</b>
                  <small>{percent}%</small>
                </button>
              );
            })}
          </div>
          <div className="spend-transactions">
            <h4>{activeCategory ? categoryMeta(activeCategory).label + " expenses" : "Expenses"} <span>{transactions.length}</span></h4>
            {transactions.length === 0 && <p className="muted">No expenses for this selection.</p>}
            {transactions.slice(0, limit).map(({ entry, amount, category: id, estimated }) => (
              <button type="button" key={entry.id} onClick={() => onOpenEntry(entry)}>
                <CategoryIcon category={id} />
                <span><b>{entry.title}</b><small>{periodFormat.format(new Date(entry.createdAt))}</small></span>
                <strong className="num">{format(amount, estimated)}</strong>
              </button>
            ))}
            {transactions.length > limit && <button type="button" className="spend-more" onClick={() => setLimit(limit + 10)}>
              Show more expenses
            </button>}
          </div>
        </aside>
      </div>
    </section>
  );
}
