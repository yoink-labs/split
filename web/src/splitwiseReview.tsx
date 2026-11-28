import { useMemo, useState } from "react";
import { importedBalances, type ImportRow, type SplitwiseGroup } from "../../worker/src/splitwiseCsv";
import { Form, useLedger, value } from "./context";
import { money, type Person } from "./data";
import { Avatar } from "./ui";

interface SplitAccount { userID: string; name: string; username?: string | null }

export interface PersonDraft {
  match: string;
  account?: SplitAccount;
  displayName?: string;
  email?: string;
}

export function ImportPerson({ source, person, members, newGroup, update }: {
  source: string;
  person: PersonDraft;
  members: Person[];
  newGroup: boolean;
  update: (person: PersonDraft) => void;
}) {
  const { request, demo } = useLedger();
  const [matches, setMatches] = useState<SplitAccount[]>();
  const member = members.find((m) => m.id === person.match);
  const placeholder = person.match === "new" || Boolean(member && !member.userID);

  return (
    <div className="splitwise-person">
      <Avatar name={source} size={32} />
      <strong>{source}</strong>
      <select aria-label={"Match " + source} value={person.match} onChange={(e) => {
        setMatches(undefined);
        update({ ...person, match: e.target.value, account: undefined });
      }}>
        <option value="new">Placeholder</option>
        <option value="me">This is me</option>
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        <option value="account">Link a Split account</option>
      </select>
      <div className="splitwise-person-fields">
        {(placeholder || (person.match === "me" && newGroup)) && (
          <details className="splitwise-person-details">
            <summary>{person.displayName?.trim() || (placeholder && !demo ? "Edit name or invite" : "Edit name")}</summary>
            <div className="splitwise-person-fields">
              <label className="field">
                Name in Split
                <input type="text" value={person.displayName ?? ""} placeholder={member?.name ?? source} maxLength={60}
                  onChange={(e) => update({ ...person, displayName: e.target.value })} />
              </label>
              {placeholder && !demo && (
                <label className="field">
                  Invite email (optional)
                  <input type="email" value={person.email ?? ""} placeholder="name@example.com" maxLength={254}
                    onChange={(e) => update({ ...person, email: e.target.value })} />
                  <small>Prepare a personal invite after importing.</small>
                </label>
              )}
            </div>
          </details>
        )}
        {person.match === "account" && (
          person.account ? (
            <>
              <div className="splitwise-account">
                <span>{person.account.name}{person.account.username ? " (@" + person.account.username + ")" : ""}</span>
                <button type="button" className="btn btn-sm" onClick={() => {
                  setMatches(undefined);
                  update({ ...person, account: undefined });
                }}>Change</button>
              </div>
              <small>This account can access the group after import.</small>
            </>
          ) : (
            <>
              <Form label="Search Split" submit={async (form) => {
                setMatches(undefined);
                setMatches(await request<SplitAccount[]>("/v1/people/search", { query: value(form, "query") }));
              }}>
                <label className="field">
                  Email, username, or shared contact
                  <input name="query" required maxLength={254} />
                </label>
              </Form>
              {matches?.length === 0 && <p className="splitwise-hint" role="status">No Split accounts found.</p>}
              {matches?.map((account) => (
                <button type="button" className="btn btn-sm" key={account.userID} onClick={() => update({ ...person, account })}>
                  Link {account.name}{account.username ? " (@" + account.username + ")" : ""}
                </button>
              ))}
            </>
          )
        )}
      </div>
    </div>
  );
}

export function ImportInvite({ groupID, memberID, name, email }: { groupID: string; memberID: string; name: string; email: string }) {
  const { request } = useLedger();
  const [draft, setDraft] = useState<{ email: string; url: string }>();
  if (draft) {
    const recipient = encodeURIComponent(draft.email).replace(/%40/g, "@");
    const body = encodeURIComponent(`Hi ${name},\n\nJoin our group on Split to claim your imported history.\n\n${draft.url}`);
    return (
      <div className="splitwise-invite">
        <strong>{name}</strong>
        <a className="btn" href={`mailto:${recipient}?subject=Your%20Split%20invite&body=${body}`}>Open email draft</a>
        <label className="field">
          Personal invite link
          <input readOnly value={draft.url} onFocus={(event) => event.currentTarget.select()} />
        </label>
      </div>
    );
  }
  return (
    <div className="splitwise-invite">
      <Form label="Prepare email invite" submit={async (form) => {
        const address = value(form, "email");
        const result = await request<{ url: string }>(`/v1/groups/${groupID}/invites`, { memberID, email: address });
        setDraft({ email: address, url: result.url });
      }}>
        <label className="field">
          Invite {name}
          <input name="email" type="email" defaultValue={email.trim()} required maxLength={254} />
        </label>
      </Form>
    </div>
  );
}

export function ImportAnalytics({ group, rows, currency, estimated, mappedName }: {
  group: SplitwiseGroup;
  rows: ImportRow[];
  currency: string;
  estimated: boolean;
  mappedName: (name: string) => string;
}) {
  const summary = useMemo(() => {
    const categories = new Map<string, number>();
    let expenses = 0, payments = 0, spend = 0, settled = 0;
    for (const row of rows) {
      if (row.payment) {
        payments++;
        settled += row.amount;
      } else {
        expenses++;
        spend += row.amount;
        const category = row.category ?? "General";
        categories.set(category, (categories.get(category) ?? 0) + row.amount);
      }
    }
    return { expenses, payments, spend, settled, balances: importedBalances({ rows })[currency],
      categories: [...categories].sort(([a, first], [b, second]) => second - first || a.localeCompare(b)) };
  }, [rows, currency]);
  const amount = (value: number) => (estimated ? "≈ " : "") + money(value, currency);

  return (
    <section className="splitwise-analytics" aria-label="Import analytics preview">
      <h4>Analytics preview in {currency}</h4>
      {estimated && <p className="splitwise-hint">Estimates use published rates for each transaction’s date, or the previous available rate.</p>}
      <div className="splitwise-currency-data">
        <dl>
          <div><dt>Expenses ({summary.expenses})</dt><dd>{amount(summary.spend)}</dd></div>
          <div><dt>Payments ({summary.payments})</dt><dd>{amount(summary.settled)}</dd></div>
        </dl>
        <details className="splitwise-currency">
          <summary>Spending by category and balances</summary>
          <div className="splitwise-currency-data">
            {summary.categories.length > 0 && (
              <>
                <h5>Spending by category</h5>
                <dl>{summary.categories.map(([category, value]) => (
                  <div key={category}><dt>{category}</dt><dd>{amount(value)}</dd></div>
                ))}</dl>
              </>
            )}
            <h5>Balances after these entries</h5>
            <dl>{group.members.map((source) => {
              const net = summary.balances?.[source] ?? 0;
              const name = mappedName(source);
              return <div key={source}><dt>{name}{name !== source && <small> ({source})</small>}</dt>
                <dd>{net === 0 ? "Settled" : (net > 0 ? "Gets back " : "Owes ") + amount(Math.abs(net))}</dd></div>;
            })}</dl>
          </div>
        </details>
      </div>
    </section>
  );
}
