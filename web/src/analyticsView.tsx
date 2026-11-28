import { dailyCosts } from "../../worker/src/ledger";
import { useId, useRef, useState, type CSSProperties } from "react";
import { analyze, drillRows, type Analytics, type Drill, type Granularity } from "./analytics";
import { categoryMeta } from "./categories";
import { CategoryDonut } from "./categoryDonut";
import { entryPayers, memberName, moneyCompact, type Expense, type Group } from "./data";
import { useHomeMoney } from "./homeMoney";
import { Picker } from "./picker";
import { TransactionTable } from "./transactionTable";
import { Avatar } from "./ui";
import "./analytics.css";

type Range = "all" | "trip" | "30d" | "90d" | "12m" | "custom";
const RANGE_LABELS: Record<Range, string> = {
  all: "All time", trip: "Trip dates", "30d": "30 days", "90d": "90 days", "12m": "12 months", custom: "Custom",
};

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const labelDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const labelMonth = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const longMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const axis = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function bucketLabel(key: string, grain: Granularity, long = false) {
  const date = new Date((grain === "month" ? key + "-01" : key) + "T00:00:00Z");
  if (grain === "month") return (long ? longMonth : labelMonth).format(date);
  if (grain === "week") return (long ? "Week of " + longDay.format(date) : labelDay.format(date));
  return (long ? longDay : labelDay).format(date);
}

/** A rounded axis ceiling and tick so the tallest bar sits under the top gridline. */
function scale(max: number) {
  const raw = Math.max(1, max) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * magnitude).find((n) => n >= raw) ?? raw;
  return Math.ceil(step);
}

function rangeBounds(range: Range, g: Group, custom: { from: string; to: string }) {
  const today = Date.now();
  switch (range) {
    case "trip": return { from: g.startDate ?? "", to: g.endDate ?? "" };
    case "30d": return { from: utcDay(today - 29 * 86_400_000), to: utcDay(today) };
    case "90d": return { from: utcDay(today - 89 * 86_400_000), to: utcDay(today) };
    case "12m": return { from: utcDay(today - 364 * 86_400_000), to: utcDay(today) };
    case "custom": return custom.from && custom.to && custom.from > custom.to ? { from: custom.to, to: custom.from } : custom;
    default: return { from: "", to: "" };
  }
}

export function DailyCostView({ g, entries, memberID, from = "", to = "" }: {
  g: Group; entries: Expense[]; memberID?: string; from?: string; to?: string;
}) {
  const [selected, setSelected] = useState("");
  const [useHome, setUseHome] = useState(false);
  const home = useHomeMoney();
  const people = g.members.filter(m => !m.removed || entries.some(e => e.splits.some(s => s.memberID === m.id)));
  const person = people.find(m => m.id === (memberID || selected)) ?? people[0];
  const relevant = person ? entries.filter(e => e.kind !== "settlement" && e.splits.some(s => s.memberID === person.id)) : [];
  const projected = useHome ? relevant.map(home.project) : relevant;
  const missing = projected.filter(entry => !entry).length;
  const days = person ? dailyCosts(projected.filter((entry): entry is Expense => entry !== null), person.id).filter(day =>
    (!from || day.day >= from) && (!to || day.day <= to)) : [];
  return (
    <section className="card card-pad" aria-label="Daily costs">
      <h3>Daily costs</h3>
      {!memberID && people.length > 0 && <Picker label="Daily costs for" value={person?.id ?? ""} onChange={setSelected}
        options={people.map(m => ({ value: m.id, label: m.name }))} />}
      <label className="check">
        <input type="checkbox" checked={useHome} onChange={event => setUseHome(event.target.checked)} />
        Show home currency ({home.home})
      </label>
      {useHome && <p className="muted">Totals in {home.home}. Foreign costs use exchange rates or the recorded card charge.</p>}
      {missing > 0 && <p role="status">{missing} expenses omitted because a rate is unavailable.</p>}
      <div className="panel" style={{ maxHeight: "28rem", overflowY: "auto" }}>
        {days.map(day => (
          <div className="row" key={day.day + day.currency}>
            <div>
              <strong>{bucketLabel(day.day, "day", true)}</strong>
              <div className="muted">{day.items.map(item => item.title + " " + moneyCompact(item.amount, day.currency)).join(" + ")}</div>
            </div>
            <b className="num">{moneyCompact(day.amount, day.currency)}</b>
          </div>
        ))}
        {!days.length && <p className="muted">No daily costs in this range.</p>}
      </div>
    </section>
  );
}

export function GroupAnalytics({ g, entries, onInspect, inspectedID }: {
  g: Group;
  entries: Expense[];
  onInspect: (id: string) => void;
  inspectedID?: string;
}) {
  const homeMoney = useHomeMoney();
  const tripRange = !!(g.startDate || g.endDate);
  const [range, setRange] = useState<Range>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [memberID, setMemberID] = useState("");
  const [grain, setGrain] = useState<Granularity>("week");
  const [drill, setDrill] = useState<Drill | null>(null);
  const drillPanel = useRef<HTMLElement>(null);

  const bounds = rangeBounds(range, g, custom);
  const people = g.members.filter((m) => !m.removed || entries.some((e) =>
    e.splits.some((s) => s.memberID === m.id) || entryPayers(e).some((p) => p.memberID === m.id)));
  const member = people.find((m) => m.id === memberID);
  const data = analyze(entries, homeMoney.project, homeMoney.home, { ...bounds, memberID: member?.id },
    g.members.map((m) => m.id), grain);
  const format = (amount: number, estimated = data.estimated) => homeMoney.format(amount, estimated);
  const drilled = drillRows(data, drill);
  const drillTotal = drilled.reduce((sum, row) => sum + (row.amount ?? 0), 0);

  function select(next: Drill) {
    const same = drill && JSON.stringify(drill) === JSON.stringify(next);
    setDrill(same ? null : next);
    if (!same) requestAnimationFrame(() => drillPanel.current?.scrollIntoView({
      block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
  }
  function resetDrill<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setDrill(null); };
  }

  const drillTitle = !drill ? "All expenses in range"
    : drill.kind === "bucket" ? bucketLabel(drill.key, data.granularity, true)
    : drill.kind === "category" ? categoryMeta(drill.id).label
    : drill.kind === "person" ? `${memberName(g, drill.memberID)}’s expenses`
    : `Paid in ${drill.currency}`;
  const ledgerLink = `/g/${g.id}?` + new URLSearchParams(drill?.kind === "category"
    ? { tab: "transactions", cat: drill.id } : { tab: "transactions" });
  const largest = data.categories[0];
  const average = data.priced.length ? Math.round(data.total / data.priced.length) : 0;

  return (
    <section className="analytics" aria-label="Group analytics">
      <div className="card analytics-filters" role="group" aria-label="Analytics filters">
        <div className="seg analytics-range" role="group" aria-label="Date range">
          {(Object.keys(RANGE_LABELS) as Range[]).filter((key) => key !== "trip" || tripRange).map((key) => (
            <button type="button" key={key} aria-pressed={range === key} onClick={() => resetDrill(setRange)(key)}>
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="analytics-dates">
            <label className="field">From
              <input type="date" value={custom.from} onChange={(e) => resetDrill(setCustom)({ ...custom, from: e.target.value })} />
            </label>
            <label className="field">To
              <input type="date" value={custom.to} onChange={(e) => resetDrill(setCustom)({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
        <div className="analytics-filter-end">
          <span className="analytics-scope muted">
            View as
          </span>
          <Picker label="View as" value={member?.id ?? ""} search={people.length > 8} onChange={resetDrill(setMemberID)}
            options={[{ value: "", label: "Everyone" }, ...people.map((p) => ({
              value: p.id, label: p.name, icon: <Avatar name={p.name} avatarURL={p.avatarURL} size={21} />,
            }))]} />
        </div>
      </div>

      <DailyCostView g={g} entries={entries} memberID={member?.id} {...bounds} />

      {data.rows.length === 0 ? (
        <p className="card ledger-empty muted">
          {entries.some((e) => e.kind === "expense") ? "No expenses in this range. Choose a wider date range or another member." : "Add an expense to see analytics."}
        </p>
      ) : (
        <>
          <dl className="metric-strip analytics-stats">
            <div className="metric-cell">
              <dt className="metric-label">{member ? `${member.name}’s share` : "Total spend"}</dt>
              <dd className="metric-val num">{format(data.total)}</dd>
              {(data.estimated || data.excluded > 0) && (
                <div className="metric-sub">
                  {data.estimated && `≈ converted to ${homeMoney.home}`}
                  {data.estimated && data.excluded > 0 && " · "}
                  {data.excluded > 0 && `${data.excluded} unpriced`}
                </div>
              )}
            </div>
            <div className="metric-cell">
              <dt className="metric-label">Entries</dt>
              <dd className="metric-val num">{data.rows.length}</dd>
              <div className="metric-sub">{data.buckets.filter((b) => b.count > 0).length} active {data.granularity === "day" ? "days" : data.granularity === "week" ? "weeks" : "months"}</div>
            </div>
            <div className="metric-cell">
              <dt className="metric-label">{member ? "Paid" : "Average entry"}</dt>
              <dd className="metric-val num">{format(member ? data.people[0]?.paid ?? 0 : average)}</dd>
              <div className="metric-sub">Net of refunds</div>
            </div>
            {largest && (
              <div className="metric-cell">
                <dt className="metric-label">Largest category</dt>
                <dd className="metric-val">{categoryMeta(largest.id).label}</dd>
                <div className="metric-sub num">{largest.percent}% · {format(largest.amount)}</div>
              </div>
            )}
          </dl>

          <TimeChart data={data} grain={grain} onGrain={resetDrill(setGrain)} format={format}
            active={drill?.kind === "bucket" ? drill.key : ""} onSelect={(key) => select({ kind: "bucket", key })} />

          <div className="analytics-grid">
            <CategoryChart data={data} format={format}
              active={drill?.kind === "category" ? drill.id : ""} onSelect={(id) => select({ kind: "category", id })} />
            <PeopleChart g={g} data={data} format={format} highlight={member?.id}
              active={drill?.kind === "person" ? drill.memberID : ""} onSelect={(id) => select({ kind: "person", memberID: id })} />
          </div>

          <CurrencyChart data={data} home={homeMoney.home} format={format}
            active={drill?.kind === "currency" ? drill.currency : ""} onSelect={(currency) => select({ kind: "currency", currency })} />

          <section ref={drillPanel} className="analytics-drill" aria-live="polite" aria-labelledby="analytics-drill-title">
            <TransactionTable key={JSON.stringify([drill, bounds, member?.id])} g={g} size="compact" pageSize={25}
              entries={drilled.map((row) => row.entry)} label={`${drillTitle} transactions`}
              inspectedID={inspectedID} onInspect={onInspect}
              header={
                <>
                  <div>
                    <h3 id="analytics-drill-title">{drillTitle}</h3>
                    <p className="muted card-sub">
                      {drilled.length} {drilled.length === 1 ? "entry" : "entries"}
                      {drilled.some((row) => row.amount !== null) && <> · <b className="num">{format(drillTotal, drilled.some((r) => r.estimated))}</b>{member && " share"}</>}
                    </p>
                  </div>
                  {drill ? <button type="button" className="btn btn-xs" onClick={() => setDrill(null)}>Show all</button>
                    : <span className="muted analytics-hint">Select a bar, slice, or row to filter</span>}
                </>
              }
              viewAll={{ to: ledgerLink, label: "Open full ledger" }}
              extra={member ? { header: `${member.name}’s share`, cell: (entry) => homeMoney.portion(entry, member.id) } : undefined} />
          </section>
        </>
      )}
    </section>
  );
}

export function TimeChart({ data, grain, onGrain, format, active, onSelect }: {
  data: Analytics;
  grain: Granularity;
  onGrain: (grain: Granularity) => void;
  format: (amount: number, estimated?: boolean) => string;
  active: string;
  onSelect: (key: string) => void;
}) {
  const tooltipID = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ key: string; x: number; left: boolean } | null>(null);
  const [highlight, setHighlight] = useState("");
  const [pinned, setPinned] = useState("");
  const category = highlight || pinned;
  const stackIDs = data.categories.map((c) => c.id);
  const extrema = data.buckets.reduce(({ max, min }, bucket) => {
    let positive = 0, negative = 0;
    for (const amount of bucket.parts.values()) {
      positive += Math.max(0, amount);
      negative += Math.min(0, amount);
    }
    return { max: Math.max(max, positive), min: Math.min(min, negative) };
  }, { max: 0, min: 0 });
  const tick = scale(extrema.max - extrema.min);
  const above = Math.max(extrema.min === 0 ? 4 : 0, Math.ceil(extrema.max / tick));
  const below = Math.ceil(-extrema.min / tick);
  const ticks = Array.from({ length: above + below + 1 }, (_, index) => (above - index) * tick);
  const span = (above + below) * tick;
  const position = (amount: number) => (above * tick - amount) / span * 100;
  function showBucket(key: string, target: HTMLButtonElement) {
    const bounds = target.getBoundingClientRect();
    const chartBounds = plot.current?.getBoundingClientRect();
    if (!chartBounds) return;
    const midpoint = bounds.left + bounds.width / 2;
    const left = midpoint < chartBounds.left + chartBounds.width / 2;
    setHover({ key, x: (left ? bounds.right : bounds.left) - chartBounds.left, left });
  }
  const withSpend = data.buckets.filter((b) => b.count > 0);
  const mean = withSpend.length ? Math.round(data.total / data.buckets.length) : 0;
  const every = Math.max(1, Math.ceil(data.buckets.length / 10));
  const focus = data.buckets.find((b) => b.key === (hover?.key || active));
  const hovered = data.buckets.find((b) => b.key === hover?.key);
  const busiest = withSpend.reduce<typeof withSpend[number] | undefined>((top, b) => !top || b.amount > top.amount ? b : top, undefined);
  const noun = data.granularity === "day" ? "day" : data.granularity === "week" ? "week" : "month";

  return (
    <section className="card analytics-card analytics-time" aria-labelledby="analytics-time-title">
      <header className="analytics-card-head">
        <div>
          <h3 id="analytics-time-title">Spending over time</h3>
          <p className="muted analytics-readout" aria-live="polite">
            {focus ? <>{bucketLabel(focus.key, data.granularity, true)} · <b className="num">{format(focus.amount)}</b> · {focus.count} {focus.count === 1 ? "expense" : "expenses"}</>
              : busiest ? <>Busiest {noun}: {bucketLabel(busiest.key, data.granularity, true)} · <b className="num">{format(busiest.amount)}</b></> : "No priced expenses in range"}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Group by">
          {(["day", "week", "month"] as const).map((key) => (
            <button type="button" key={key} aria-pressed={grain === key} onClick={() => onGrain(key)}>
              {key[0].toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>
      </header>
      <div className="tchart" ref={plot} onKeyDown={(event) => { if (event.key === "Escape") setHover(null); }}>
        <div className="tchart-axis" aria-hidden="true">
          {ticks.map((n) => <span key={n}>{axis.format(n / 100)}</span>)}
        </div>
        <div className="tchart-scroll" onScroll={() => setHover(null)} tabIndex={data.buckets.length > 24 ? 0 : undefined} role="group" aria-label="Spending by period">
          <div className="tchart-plot" style={{ gridTemplateColumns: `repeat(${data.buckets.length}, minmax(${data.buckets.length > 60 ? 9 : 16}px, 1fr))` }}>
            <div className="tchart-grid" aria-hidden="true">{ticks.map((n) => <i key={n} className={n === 0 ? "zero" : undefined} style={{ top: `${position(n)}%` }} />)}</div>
            {mean !== 0 && <div className="tchart-mean" style={{ "--mean": `${position(mean) / 100}` } as CSSProperties} aria-hidden="true">
              <span>avg {format(mean)}</span>
            </div>}
            {data.buckets.map((b, index) => {
              let positive = 0, negative = 0;
              const segments = stackIDs.flatMap((id) => {
                const amount = b.parts.get(id) ?? 0;
                if (amount === 0) return [];
                const top = amount > 0 ? (positive += amount) : negative;
                if (amount < 0) negative += amount;
                return [{ id, top: position(top), height: Math.abs(amount) / span * 100 }];
              });
              return (
                <button type="button" key={b.key} className="tchart-col" aria-pressed={active === b.key}
                  disabled={!b.count}
                  aria-label={`${bucketLabel(b.key, data.granularity, true)}: ${format(b.amount)}, ${b.count} expenses`}
                  aria-describedby={hovered?.key === b.key ? tooltipID : undefined}
                  onMouseEnter={(event) => showBucket(b.key, event.currentTarget)} onMouseLeave={() => setHover(null)}
                  onFocus={(event) => showBucket(b.key, event.currentTarget)} onBlur={() => setHover(null)}
                  onClick={() => onSelect(b.key)}>
                  <span className="tchart-track">
                    {segments.map(({ id, top, height }) => (
                      <span key={id} className="tchart-segment" data-dimmed={!!category && category !== id}
                        style={{ top: `${top}%`, height: `${height}%`, background: categoryMeta(id).color }}
                        onMouseEnter={() => setHighlight(id)} onMouseLeave={() => setHighlight("")} />
                    ))}
                  </span>
                  <span className="tchart-label" aria-hidden="true">{index % every === 0 ? bucketLabel(b.key, data.granularity) : ""}</span>
                </button>
              );
            })}
          </div>
        </div>
        {hover && hovered && (
          <div className="tchart-tooltip" id={tooltipID} role="tooltip" data-bar-left={hover.left} style={{ "--tooltip-x": `${hover.x}px` } as CSSProperties}>
            <b>{bucketLabel(hovered.key, data.granularity, true)} · {format(hovered.amount)}</b>
            <ul>
              {stackIDs.filter((id) => hovered.parts.has(id)).map((id) => (
                <li key={id}><i style={{ background: categoryMeta(id).color }} />
                  <span>{categoryMeta(id).label}</span><b className="num">{format(hovered.parts.get(id)!)}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ul className="analytics-legend tchart-legend" aria-label="Highlight a category">
        {stackIDs.map((id) => <li key={id}>
          <button type="button" aria-pressed={pinned === id}
            onMouseEnter={() => setHighlight(id)} onMouseLeave={() => setHighlight("")}
            onFocus={() => setHighlight(id)} onBlur={() => setHighlight("")}
            onClick={() => setPinned((current) => current === id ? "" : id)}>
            <i style={{ background: categoryMeta(id).color }} />{categoryMeta(id).label}
          </button>
        </li>)}
      </ul>
    </section>
  );
}

export function CategoryChart({ data, format, active, onSelect }: {
  data: Analytics;
  format: (amount: number) => string;
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="card analytics-card" aria-labelledby="analytics-cat-title">
      <header className="analytics-card-head">
        <div>
          <h3 id="analytics-cat-title">By category</h3>
          <p className="muted">{data.categories.length} {data.categories.length === 1 ? "category" : "categories"} · click to filter</p>
        </div>
      </header>
      <CategoryDonut compact categories={data.categories} total={data.total} format={format} active={active} onSelect={onSelect} />
    </section>
  );
}

function PeopleChart({ g, data, format, highlight, active, onSelect }: {
  g: Group;
  data: Analytics;
  format: (amount: number, estimated?: boolean, signed?: boolean) => string;
  highlight?: string;
  active: string;
  onSelect: (id: string) => void;
}) {
  const rows = [...data.people].sort((a, b) => b.share - a.share || b.paid - a.paid);
  const max = Math.max(1, ...rows.flatMap((r) => [r.paid, r.share]));
  return (
    <section className="card analytics-card" aria-labelledby="analytics-people-title">
      <header className="analytics-card-head">
        <div>
          <h3 id="analytics-people-title">By person</h3>
          <p className="muted">What each person paid against their share</p>
        </div>
        <ul className="analytics-legend analytics-legend-inline" aria-label="Bars">
          <li><i className="apeople-paid" />Paid</li>
          <li><i className="apeople-share" />Share</li>
        </ul>
      </header>
      <ul className="apeople">
        {rows.map((r) => {
          const person = g.members.find((m) => m.id === r.memberID);
          const name = memberName(g, r.memberID);
          return (
            <li key={r.memberID} className={highlight === r.memberID ? "highlight" : undefined}>
              <button type="button" aria-pressed={active === r.memberID} onClick={() => onSelect(r.memberID)}
                aria-label={`${name}: paid ${format(r.paid)}, share ${format(r.share)}`}>
                <Avatar name={name} avatarURL={person?.avatarURL} size={28} />
                <span className="apeople-body">
                  <span className="apeople-name"><b>{name}</b>{person?.removed && <small className="muted"> archived</small>}</span>
                  <span className="apeople-bars" aria-hidden="true">
                    <span className="apeople-paid" style={{ inlineSize: `${(r.paid / max) * 100}%` }} />
                    <span className="apeople-share" style={{ inlineSize: `${(r.share / max) * 100}%` }} />
                  </span>
                  <span className="apeople-figures muted"><span>Paid <b className="num">{format(r.paid)}</b></span><span>Share <b className="num">{format(r.share)}</b></span></span>
                </span>
                <span className={"apeople-net num " + (r.net > 0 ? "pos" : r.net < 0 ? "neg" : "muted")}>
                  {r.net === 0 ? "Even" : format(r.net, undefined, true)}
                  <small className="muted">{r.net > 0 ? "covered others" : r.net < 0 ? "covered by others" : ""}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CurrencyChart({ data, home, format, active, onSelect }: {
  data: Analytics;
  home: string;
  format: (amount: number, estimated?: boolean) => string;
  active: string;
  onSelect: (currency: string) => void;
}) {
  const max = Math.max(1, ...data.currencies.map((c) => c.home ?? 0));
  return (
    <section className="card analytics-card analytics-currencies" aria-labelledby="analytics-fx-title">
      <header className="analytics-card-head">
        <div>
          <h3 id="analytics-fx-title">By currency</h3>
          <p className="muted">{data.currencies.length === 1 ? `Every expense was paid in ${data.currencies[0].currency}` : `Paid in ${data.currencies.length} currencies, totalled in ${home}`}</p>
        </div>
      </header>
      <ul className="acur-grid">
        {data.currencies.map((c) => (
          <li key={c.currency}>
            <button type="button" aria-pressed={active === c.currency} onClick={() => onSelect(c.currency)}>
              <span className="acur-code">{c.currency}</span>
              <span className="arank-label">
                <span><b>{moneyCompact(c.original, c.currency)}</b><small className="muted">{c.count} {c.count === 1 ? "entry" : "entries"}</small></span>
                <span className="arank-bar"><span style={{ inlineSize: `${((c.home ?? 0) / max) * 100}%`, background: "var(--primary)" }} /></span>
              </span>
              <span className="arank-value">
                <b className="num">{c.home === null ? "Rate unavailable" : c.currency === home ? format(c.home, false) : format(c.home, true)}</b>
                <small className="muted num">{c.home === null ? "" : `${c.percent}%`}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
