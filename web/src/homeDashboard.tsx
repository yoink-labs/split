import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { analyze, bucketKey, type Granularity } from "./analytics";
import { CategoryChart, TimeChart } from "./analyticsView";
import { categoryMeta } from "./categories";
import { useLedger } from "./context";
import { entryPath, memberPath, money, shortDate, sign } from "./data";
import { personalLedger } from "./homeDashboardData";
import { useHomeMoney } from "./homeMoney";
import { PendingPayments } from "./settlements";
import { Avatar, CategoryIcon, EmptyState } from "./ui";
import "./homeDashboard.css";

const PAGE_SIZE = 12;

export function HomeOverview() {
  const { data, user } = useLedger();
  const ledger = useMemo(() => personalLedger(data.groups, data.entries, user), [data.groups, data.entries, user]);
  const home = useHomeMoney();
  const [grain, setGrain] = useState<Granularity>("week");
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [direction, setDirection] = useState("");
  const [bucket, setBucket] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const feed = useRef<HTMLElement>(null);
  const categories = [...new Set(ledger.transactions.filter(({ entry }) => entry.kind !== "settlement")
    .map(({ entry }) => categoryMeta(entry.category).id))].sort();
  const report = analyze(ledger.transactions.map(({ entry }) => entry), home.project, home.home, { memberByGroup: ledger.seats }, [], grain);
  const format = (amount: number) => home.format(amount, report.estimated);
  const person = report.people[0];
  const names = new Map(ledger.summaries.map(({ group }) => [group.id, group.name]));
  const groupSpend = new Map<string, number>();
  for (const row of report.priced) groupSpend.set(row.entry.groupID, (groupSpend.get(row.entry.groupID) ?? 0) + row.amount!);
  const filtered = ledger.transactions.filter((row) =>
    (!group || row.entry.groupID === group)
    && (!category || (row.entry.kind !== "settlement" && categoryMeta(row.entry.category).id === category))
    && (!direction || (row.entry.kind !== "settlement" && (direction === "owed" ? row.direction > 0 : row.direction < 0)))
    && (!bucket || (row.entry.kind !== "settlement" && bucketKey(row.entry.createdAt.slice(0, 10), grain) === bucket)));
  const currencies = [...ledger.totals.keys()].sort();
  if (!currencies.length) currencies.push(home.home);

  function update(set: (value: string) => void, value: string) {
    set(value);
    setLimit(PAGE_SIZE);
  }

  function filterFromChart(set: (value: string) => void, value: string) {
    update(set, value);
    if (value) feed.current?.focus();
  }

  return (
    <div className="personal-home">
      <header className="page-head">
        <h1 className="page-title">Home</h1>
        <div className="head-actions">
          {ledger.summaries.length > 0 && <a className="btn btn-sm btn-ghost" href="#personal-transactions">Your transactions</a>}
          <Link className="btn btn-sm" to="/import/splitwise">Import Splitwise</Link>
          <Link className="btn btn-sm btn-primary" to="/new">+ New trip or group</Link>
        </div>
      </header>
      {!ledger.summaries.length ? <EmptyState title="No groups yet"
        message="Create a group or import one from Splitwise to see your balances and spending."
        action={{ label: "Create a group", to: "/new" }} /> : <>
        <section className="personal-balance" aria-label="Net position">
          <h2>Net position</h2>
          {currencies.map((currency) => {
            const { owe, owed } = ledger.totals.get(currency) ?? { owe: 0, owed: 0 };
            return <div className="personal-balance-row" key={currency}>
              <span className="personal-currency">{currency}</span>
              <dl>
                <div><dt>Net balance</dt><dd className="personal-net num">{money(owed - owe, currency)}</dd></div>
                <div><dt>You owe</dt><dd className="num">{money(owe, currency)}</dd></div>
                <div><dt>You’re owed</dt><dd className="num">{money(owed, currency)}</dd></div>
              </dl>
            </div>;
          })}
        </section>
        <PendingPayments />
        <div className="personal-columns">
          <div className="personal-stack">
            <section className="card personal-panel">
              <h2>Your spending</h2>
              <p className="muted">All time · {home.home} · Net of refunds
                {report.estimated && <> · ≈ Includes currency conversions</>}
                {report.excluded > 0 && <> · {report.excluded} excluded without a rate</>}
              </p>
              <dl className="personal-spend-totals">
                <div><dt>You paid</dt><dd className="num">{format(person?.paid ?? 0)}</dd></div>
                <div><dt>Your share</dt><dd className="num">{format(report.total)}</dd></div>
                <div><dt>Paid minus share</dt><dd className="num">{home.format(person?.net ?? 0, report.estimated, true)}</dd></div>
              </dl>
            </section>
            {report.priced.length > 0 && <>
              <TimeChart data={report} grain={grain} onGrain={(value) => { setGrain(value); update(setBucket, ""); }}
                format={format} active={bucket} onSelect={(value) => filterFromChart(setBucket, bucket === value ? "" : value)} />
              <div className="personal-breakdowns">
                <CategoryChart data={report} format={format} active={category}
                  onSelect={(value) => filterFromChart(setCategory, category === value ? "" : value)} />
                <section className="card personal-panel">
                  <h3>By group</h3>
                  {[...groupSpend].sort((a, b) => b[1] - a[1]).map(([id, amount]) =>
                    <button className="personal-group-filter" type="button" key={id} aria-pressed={group === id}
                      onClick={() => filterFromChart(setGroup, group === id ? "" : id)}>
                      <span>{names.get(id)}</span><strong className="num">{format(amount)}</strong>
                    </button>)}
                </section>
              </div>
            </>}
          </div>
          <aside className="personal-stack" aria-label="People and groups">
            <section className="card personal-panel">
              <h2>Balances by person</h2>
              <p className="muted">Suggested payments across groups</p>
              {!ledger.people.size && <p className="personal-empty">Everyone is settled up.</p>}
              {[...ledger.people].sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([key, balance]) =>
                <details className="personal-person" key={key}>
                  <summary>
                    <Avatar name={balance.name} avatarURL={balance.avatarURL} size={32} />
                    <div>{[...balance.net].sort().map(([currency, amount]) => <div key={currency}>
                      <strong>{amount < 0 ? `You owe ${balance.name}` : amount > 0 ? `${balance.name} owes you` : balance.name}</strong>
                      <span className={amount < 0 ? "neg num" : amount > 0 ? "pos num" : "muted"}>
                        {amount === 0 ? `Net zero in ${currency}` : `${money(Math.abs(amount), currency)}`}
                      </span>
                    </div>)}</div>
                    <span aria-hidden="true" className="personal-chevron">›</span>
                  </summary>
                  {balance.lines.map(({ group, person, currency, amount }) =>
                    <div className="personal-transfer" key={`${group.id}/${person.id}/${currency}`}>
                      <Link to={memberPath(group, person.id)}>{group.name}</Link>
                      <span className="num">{amount < 0 ? "You owe" : "Owed to you"} {money(Math.abs(amount), currency)}</span>
                      {amount < 0 && !person.removed && <Link className="btn btn-xs" to={`/g/${group.id}?${new URLSearchParams({ tab: "settle", to: person.id, currency })}`}>Settle up</Link>}
                    </div>)}
                </details>)}
            </section>
            <section className="card personal-panel">
              <h2>Your groups</h2>
              {ledger.summaries.map(({ group, mine }) => <Link className="personal-group-row" key={group.id} to={`/g/${group.id}`}>
                <strong>{group.name}{group.archived && <small>Archived</small>}</strong>
                <span className="num">{[...mine].sort().map(([currency, amount]) =>
                  <span className={amount < 0 ? "neg" : "pos"} key={currency}>{money(amount, currency)}</span>)}
                  {!mine.size && <span className="muted">Settled up</span>}</span>
              </Link>)}
            </section>
          </aside>
        </div>
        <section className="card personal-panel" id="personal-transactions" ref={feed} tabIndex={-1} aria-labelledby="personal-transactions-title">
          <h2 id="personal-transactions-title">Your transactions</h2>
          <div className="personal-filters">
            <label>Group<select value={group} onChange={(event) => update(setGroup, event.target.value)}>
              <option value="">All groups</option>
              {ledger.summaries.map(({ group }) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select></label>
            <label>Category<select value={category} onChange={(event) => update(setCategory, event.target.value)}>
              <option value="">All categories</option>
              {categories.map((id) => <option key={id} value={id}>{categoryMeta(id).label}</option>)}
            </select></label>
            <label>Direction<select value={direction} onChange={(event) => update(setDirection, event.target.value)}>
              <option value="">All transactions</option><option value="owed">Owed to you</option><option value="owe">You owe</option>
            </select></label>
            {bucket && <button className="btn btn-sm" type="button" onClick={() => update(setBucket, "")}>Clear period {bucket}</button>}
          </div>
          {filtered.slice(0, limit).map(({ entry, paid, share }) => <Link className="personal-transaction" to={entryPath(entry)} key={entry.id}>
            <CategoryIcon category={entry.category} settlement={entry.kind === "settlement"} />
            <span><strong>{entry.title}</strong><small>{names.get(entry.groupID)} · {shortDate(entry.createdAt)}</small></span>
            <span className="num">
              {!!paid && <span>{entry.kind === "refund" ? "Received" : entry.kind === "settlement" ? "Sent" : "Paid"} {money(paid, entry.currency)}</span>}
              {!!share && <span>{entry.kind === "settlement" ? "Received" : "Your share"} {money(entry.kind === "settlement" ? share : sign(entry) * share, entry.currency)}</span>}
            </span>
          </Link>)}
          {!filtered.length && <p className="personal-empty muted">No transactions match your filters.</p>}
          {filtered.length > limit && <button className="btn btn-sm personal-more" type="button" onClick={() => setLimit(limit + PAGE_SIZE)}>Show more transactions</button>}
        </section>
      </>}
    </div>
  );
}
