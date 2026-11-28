import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CATEGORIES, categoryMeta } from "./categories";
import { breakdown, entryPayers, memberName, memberPath, moneyCompact, settlementEntry, shortDate, type Expense, type Group } from "./data";
import { useHomeMoney } from "./homeMoney";
import { Picker } from "./picker";
import { Avatar, CategoryIcon } from "./ui";

type LedgerView = "summary" | "transactions";
type Status = "all" | "receipt" | "open" | "recurring";

const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const shareOf = (amount: number, total: number) => total ? amount / total : 0;
const categoryOf = (entry: Expense) => entry.category ?? "Other";
const openItems = (entry: Expense) => entry.bill && !entry.bill.closed
  ? entry.bill.items.filter((item) => !item.memberIDs.length).length : 0;

function position(entry: Expense, id?: string) {
  const involved = !!id && [...entryPayers(entry), ...entry.splits].some((part) => part.memberID === id);
  if (!involved || entry.handled || entry.kind !== "expense") return { involved, net: 0, currency: entry.currency };
  const settled = settlementEntry(entry);
  const paid = entryPayers(settled).reduce((sum, part) => sum + (part.memberID === id ? part.amount : 0), 0);
  const share = settled.splits.reduce((sum, part) => sum + (part.memberID === id ? part.amount : 0), 0);
  return { involved, net: paid - share, currency: settled.currency };
}

export function GroupLedger({
  g, entries, memberID, view, category, onSelectCategory, inspectedID, onInspect,
}: {
  g: Group;
  entries: Expense[];
  memberID?: string;
  view: LedgerView;
  category: string;
  onSelectCategory: (category?: string) => void;
  inspectedID?: string;
  onInspect: (id: string) => void;
}) {
  const homeMoney = useHomeMoney();
  const heading = useRef<HTMLHeadingElement>(null);
  const [search, setSearch] = useState("");
  const [payer, setPayer] = useState("");
  const [person, setPerson] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [involved, setInvolved] = useState(false);
  const [owes, setOwes] = useState(false);

  const term = search.trim().toLowerCase();
  const filtered = view === "transactions" ? entries.flatMap((entry) => {
    if (term && ![entry.title, entry.notes, entry.category, categoryMeta(entry.category).label].some((s) => s?.toLowerCase().includes(term))) return [];
    if (category && categoryOf(entry) !== category) return [];
    if (payer && !entryPayers(entry).some((p) => p.memberID === payer)) return [];
    if (person && ![...entryPayers(entry), ...entry.splits].some((p) => p.memberID === person)) return [];
    if (status === "receipt" && !entry.bill && !entry.receiptIDs?.length) return [];
    if (status === "open" && !openItems(entry)) return [];
    if (status === "recurring" && (!entry.recurrence || entry.recurrence === "off")) return [];
    const mine = position(entry, memberID);
    if ((involved && !mine.involved) || (owes && mine.net >= 0)) return [];
    return [{ entry, mine }];
  }) : [];
  const hasFilters = !!(search || category || payer || person || status !== "all" || involved || owes);

  function clearFilters() {
    setSearch("");
    setPayer("");
    setPerson("");
    setStatus("all");
    setInvolved(false);
    setOwes(false);
    if (category) onSelectCategory();
  }

  return (
    <section className="group-ledger" aria-labelledby="group-ledger-title">
      <header className="workspace-section-head">
        <h2 id="group-ledger-title" ref={heading} tabIndex={-1}>{view === "summary" ? "Ledger" : "Transactions"}</h2>
      </header>

      {view === "summary" ? (
        <LedgerSummary g={g} entries={entries} memberID={memberID} onCategory={(cat) => {
          heading.current?.focus();
          onSelectCategory(cat);
        }} />
      ) : (
        <>
          <section className="card ledger-filters" aria-label="Transaction filters">
            <div className="ledger-filter-top">
              {memberID && (
                <div className="ledger-scopes" role="group" aria-label="Filter by your involvement">
                  <button type="button" className="btn btn-sm" aria-pressed={!involved && !owes} onClick={() => { setInvolved(false); setOwes(false); }}>Everyone</button>
                  <button type="button" className="btn btn-sm" aria-pressed={involved} onClick={() => setInvolved(!involved)}>I’m involved</button>
                  <button type="button" className="btn btn-sm" aria-pressed={owes} onClick={() => setOwes(!owes)}>I owe</button>
                </div>
              )}
              <input type="search" aria-label="Search transactions" placeholder="Search transactions…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="ledger-filter-fields">
              <Picker label="Filter by category" value={category} search
                onChange={onSelectCategory}
                options={[{ value: "", label: "All categories" },
                  ...[...new Set([...CATEGORIES.map((c) => c.id), ...entries.map(categoryOf)])].map((cat) => ({
                    value: cat, label: categoryMeta(cat).label, icon: <CategoryIcon category={cat} />,
                  })),
                ]} />
              <Picker label="Filter by payer" value={payer} onChange={setPayer} search={g.members.length > 8}
                options={[{ value: "", label: "Any payer" }, ...g.members.map((m) => ({ value: m.id, label: m.name }))]} />
              <Picker label="Filter by participant" value={person} onChange={setPerson} search={g.members.length > 8}
                options={[{ value: "", label: "Any participant" }, ...g.members.map((m) => ({ value: m.id, label: m.name }))]} />
              <Picker label="Filter by status" value={status} onChange={(value) => setStatus(value as Status)}
                options={[
                  { value: "all", label: "Any status" }, { value: "open", label: "Needs claiming" },
                  { value: "receipt", label: "Has receipt" }, { value: "recurring", label: "Recurring" },
                ]} />
            </div>
            <div className="ledger-filter-foot">
              <p className="muted" role="status">{filtered.length} of {entries.length} transactions</p>
              {hasFilters && <button type="button" className="btn btn-xs btn-ghost" onClick={clearFilters}>Clear filters</button>}
            </div>
            {owes && <p className="muted ledger-note">Shows expenses where your share exceeds what you paid, excluding expenses marked handled. Settle Up shows what you owe after payments.</p>}
          </section>

          {filtered.length ? (
            <div className="card ledger-table-scroll" tabIndex={0} role="region" aria-label="Transactions table">
              <table className="ledger-table transaction-table">
                <thead>
                  <tr>
                    <th scope="col">Transaction</th>
                    <th scope="col" className="ledger-number">Amount</th>
                    <th scope="col">Date</th>
                    <th scope="col">Paid by</th>
                    {memberID && <th scope="col" className="ledger-number">Your position</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(({ entry, mine }) => {
                    const payment = entry.kind === "settlement";
                    const title = payment ? `Payment to ${entry.splits.map((s) => memberName(g, s.memberID)).join(", ")}` : entry.title;
                    const payers = entryPayers(entry).map((p) => memberName(g, p.memberID)).join(", ");
                    const open = openItems(entry);
                    const projected = homeMoney.project(entry);
                    const foreign = entry.currency !== homeMoney.home;
                    return (
                      <tr key={entry.id} className={inspectedID === entry.id ? "selected" : undefined}>
                        <td>
                          <div className="ledger-transaction">
                            <CategoryIcon category={entry.category} settlement={payment} />
                            <div>
                              <button type="button" className="ledger-entry-link" onClick={() => onInspect(entry.id)}>{title}</button>
                              <div className="ledger-entry-meta muted">
                                {payment ? "Settlement" : categoryMeta(entry.category).label}
                                {entry.handled && <span className="tag tag-pos">Handled</span>}
                                {open > 0 && <span className="tag tag-warn">{open} open</span>}
                                {!open && (entry.bill || !!entry.receiptIDs?.length) && <span className="tag">Receipt</span>}
                                {!!entry.commentCount && <span>{entry.commentCount} {entry.commentCount === 1 ? "comment" : "comments"}</span>}
                                {entry.recurrence && entry.recurrence !== "off" && <span className="tag tag-primary">{entry.recurrence}</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="ledger-number">
                          <strong>{projected ? homeMoney.format(projected.amount, foreign) : moneyCompact(entry.amount, entry.currency)}</strong>
                          {foreign && <small className="muted">{projected ? moneyCompact(entry.amount, entry.currency) : "Rate unavailable"}</small>}
                        </td>
                        <td className="ledger-date muted">{shortDate(entry.createdAt)}</td>
                        <td>{payers}</td>
                        {memberID && (
                          <td className="ledger-number">
                            {mine.net ? (
                              <strong className={mine.net < 0 ? "neg" : "pos"}>
                                {mine.net < 0 ? "Owe" : "Owed"} {moneyCompact(Math.abs(mine.net), mine.currency)}
                              </strong>
                            ) : <span className="muted">{entry.handled ? "Handled" : !mine.involved ? "—" : payment ? "Payment" : "Even"}</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="card ledger-empty muted">{entries.length ? "No transactions match these filters." : "No transactions yet."}</p>}
        </>
      )}
    </section>
  );
}

function LedgerSummary({ g, entries, memberID, onCategory }: {
  g: Group;
  entries: Expense[];
  memberID?: string;
  onCategory: (category: string) => void;
}) {
  const homeMoney = useHomeMoney();
  const expenses = entries.filter((e) => e.kind === "expense");
  const projected = expenses.map(homeMoney.project);
  const missing = projected.some((entry) => entry === null);
  const foreign = expenses.some((entry) => entry.currency !== homeMoney.home);
  const currencies = missing ? [...new Set(expenses.map((entry) => entry.currency))].sort() : [homeMoney.home];

  if (!entries.length) return <p className="card ledger-empty muted">Add an expense to see the ledger breakdown.</p>;

  return (
    <>
      {foreign && <p className="ledger-note muted">
        {missing ? "Some exchange rates are unavailable. Spending is shown separately in each recorded currency."
          : `Spending is shown in ${homeMoney.home}. ≈ includes currency conversions.`}
      </p>}
      {currencies.map((currency) => {
        const amounts = missing ? expenses : projected.filter((e): e is Expense => e !== null);
        const matching = amounts.filter((e) => e.currency === currency).map((e) => ({ ...e, category: categoryOf(e) }));
        const spend = breakdown(matching, g.members, currency);
        const categories = Object.entries(spend.categories).sort(([a, left], [b, right]) => right - left || a.localeCompare(b));
        const people = spend.members.filter((m) => m.expenses.length).sort((a, b) => b.share - a.share || b.paid - a.paid || a.name.localeCompare(b.name));
        const myShare = people.find((m) => m.id === memberID)?.share ?? 0;
        const format = (amount: number) => missing ? moneyCompact(amount, currency) : homeMoney.format(amount, foreign);
        return (
          <section className="ledger-statement" key={currency} aria-label={`Spending in ${currency}`}>
            <div className="card statement-totals">
              <div>
                <h3>{missing ? `Total spend in ${currency}` : "Total group spend"}</h3>
                <strong className="num statement-total">{format(spend.total)}</strong>
              </div>
              <dl>
                <div><dt>Expenses</dt><dd>{matching.length}</dd></div>
                {!missing && <div><dt>Payments</dt><dd>{entries.length - expenses.length}</dd></div>}
                {memberID && <div><dt>Your share</dt><dd>{format(myShare)}</dd></div>}
              </dl>
            </div>

            {matching.length > 0 && (
              <div className="statement-breakdowns">
                <details className="card statement-detail" open>
                  <summary>
                    <span><strong>Spending by category</strong><small>{categories.length} {categories.length === 1 ? "category" : "categories"}</small></span>
                  </summary>
                  <ul className="statement-categories">
                    {categories.map(([category, total]) => {
                      const ratio = shareOf(total, spend.total);
                      return (
                        <li key={category}>
                          <button type="button" onClick={() => onCategory(category)} title="View transactions in this category">
                            <CategoryIcon category={category} />
                            <span className="statement-category-label">
                              <strong>{categoryMeta(category).label}</strong>
                              <span className="statement-meter" aria-hidden="true">
                                <span style={{ inlineSize: `${ratio * 100}%`, background: categoryMeta(category).color }} />
                              </span>
                            </span>
                            <span className="statement-category-value">
                              <strong className="num">{format(total)}</strong>
                              <small>{spend.total ? percent.format(ratio) : "—"}</small>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </details>

                <details className="card statement-detail" open>
                  <summary>
                    <span><strong>Spending by person</strong><small>Paid, share, and percentage of total spend</small></span>
                  </summary>
                  <div className="ledger-table-scroll" tabIndex={0} role="region" aria-label={`Spending by person in ${currency}`}>
                    <table className="ledger-table statement-people">
                      <thead>
                        <tr>
                          <th scope="col">Person</th>
                          <th scope="col" className="ledger-number">Paid</th>
                          <th scope="col" className="ledger-number">Share</th>
                          <th scope="col" className="ledger-number">% of spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {people.map((m) => (
                          <tr key={m.id}>
                            <th scope="row">
                              <Link to={memberPath(g, m.id)} className="ledger-person">
                                <Avatar name={m.name} avatarURL={g.members.find((p) => p.id === m.id)?.avatarURL} size={25} />
                                {m.name} {m.id === memberID && <span className="tag tag-primary">You</span>}
                              </Link>
                            </th>
                            <td className="ledger-number">{format(m.paid)}</td>
                            <td className="ledger-number">{format(m.share)}</td>
                            <td className="ledger-number">{spend.total ? percent.format(shareOf(m.share, spend.total)) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
