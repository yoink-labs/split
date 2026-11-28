import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { categoryMeta } from "./categories";
import { entryPayers, memberName, moneyCompact, shortDate, type Expense, type Group } from "./data";
import { useHomeMoney } from "./homeMoney";
import { CategoryIcon } from "./ui";
import "./analytics.css";

export const openItems = (entry: Expense) => entry.bill && !entry.bill.closed
  ? entry.bill.items.filter((item) => !item.memberIDs.length).length : 0;

export interface ExtraColumn {
  header: string;
  cell: (entry: Expense) => ReactNode;
}

/**
 * Every transaction list in the web app: a bounded scroll frame with a sticky header, pages of
 * `pageSize` rows, and an optional link to the full ledger. It never grows past its frame.
 */
export function TransactionTable({
  g, entries, all = entries, label, pageSize = 50, inspectedID, onInspect, extra, viewAll, header, empty = "No transactions yet.", size = "full",
}: {
  g: Group;
  entries: Expense[];
  /** Every entry in the group, so a refund can name its original even when filters hide it. */
  all?: Expense[];
  label: string;
  pageSize?: number;
  inspectedID?: string;
  onInspect: (id: string) => void;
  extra?: ExtraColumn;
  viewAll?: { to: string; label: string };
  header?: ReactNode;
  empty?: string;
  /** `compact` uses a shorter frame for panels on the Overview and Analytics tabs. */
  size?: "full" | "compact";
}) {
  const homeMoney = useHomeMoney();
  const frame = useRef<HTMLDivElement>(null);
  const [requested, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(requested, pages - 1);
  const start = page * pageSize;
  const visible = entries.slice(start, start + pageSize);

  function go(next: number) {
    setPage(next);
    frame.current?.scrollTo({ top: 0 });
  }

  if (!entries.length) {
    return (
      <div className="card txn-card">
        {header && <div className="card-head txn-head">{header}</div>}
        <p className="txn-empty muted">{empty}</p>
        {viewAll && <footer className="txn-foot"><Link className="txn-all" to={viewAll.to}>{viewAll.label}</Link></footer>}
      </div>
    );
  }

  return (
    <div className={"card txn-card txn-" + size}>
      {header && <div className="card-head txn-head">{header}</div>}
      <div ref={frame} className="txn-frame" tabIndex={0} role="region" aria-label={label}>
        <table className="ledger-table transaction-table txn-table">
          <thead>
            <tr>
              <th scope="col">Transaction</th>
              <th scope="col" className="ledger-number">Amount</th>
              <th scope="col" className="txn-col-date">Date</th>
              <th scope="col" className="txn-col-payer">Paid by</th>
              {extra && <th scope="col" className="ledger-number">{extra.header}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const payment = entry.kind === "settlement";
              const refund = entry.kind === "refund";
              const original = refund && entry.refundOf ? all.find((e) => e.id === entry.refundOf) : undefined;
              const title = payment ? `Payment to ${entry.splits.map((s) => memberName(g, s.memberID)).join(", ")}` : entry.title;
              const payers = entryPayers(entry).map((p) => memberName(g, p.memberID)).join(", ");
              const open = openItems(entry);
              const projected = homeMoney.project(entry);
              const foreign = entry.currency !== homeMoney.home;
              return (
                <tr key={entry.id} className={[inspectedID === entry.id ? "selected" : "", refund ? "refund-row" : "", entry.pending ? "pending-row" : ""].filter(Boolean).join(" ") || undefined}>
                  <td>
                    <div className="ledger-transaction">
                      <CategoryIcon category={entry.category} settlement={payment} />
                      <div className="txn-title">
                        <button type="button" className="ledger-entry-link" onClick={() => onInspect(entry.id)}>{title}</button>
                        <div className="ledger-entry-meta muted">
                          <span className="txn-inline-date">{shortDate(entry.createdAt)} ·</span>
                          {payment ? "Settlement" : categoryMeta(entry.category).label}
                          {refund && <span className="tag tag-refund">{entry.refundOf ? "Refund" : "Credit"}</span>}
                          {original && (
                            <button type="button" className="ledger-refund-of" onClick={() => onInspect(original.id)}>
                              of {original.title}
                            </button>
                          )}
                          {entry.pending && <span className="tag tag-pending" title={entry.pendingNote}>Pending</span>}
                          {entry.pending && entry.pendingNote && <span className="ledger-pending-note">{entry.pendingNote}</span>}
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
                    <strong className={refund ? "pos" : undefined}>{projected ? homeMoney.format(refund ? -projected.amount : projected.amount, foreign) : (refund ? "−" : "") + moneyCompact(entry.amount, entry.currency)}</strong>
                    {foreign && <small className="muted">{projected ? moneyCompact(entry.amount, entry.currency) : "Rate unavailable"}</small>}
                  </td>
                  <td className="ledger-date muted txn-col-date">{shortDate(entry.createdAt)}</td>
                  <td className="txn-col-payer">{refund ? <><span className="muted">Received by </span>{payers}</> : payers}</td>
                  {extra && <td className="ledger-number">{extra.cell(entry)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="txn-foot">
        <span className="muted" role="status">
          {pages > 1 ? `${start + 1}–${start + visible.length} of ${entries.length}` : `${entries.length} ${entries.length === 1 ? "transaction" : "transactions"}`}
        </span>
        {pages > 1 && (
          <span className="txn-pager">
            <button type="button" className="btn btn-xs" disabled={page === 0} onClick={() => go(page - 1)}>Previous</button>
            <span className="muted">Page {page + 1} of {pages}</span>
            <button type="button" className="btn btn-xs" disabled={page >= pages - 1} onClick={() => go(page + 1)}>Next</button>
          </span>
        )}
        {viewAll && <Link className="txn-all" to={viewAll.to}>{viewAll.label}</Link>}
      </footer>
    </div>
  );
}
