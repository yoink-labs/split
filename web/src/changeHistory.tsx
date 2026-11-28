import { tripPhaseLabels, type TripPhase } from "../../worker/src/tripPhases";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Form, useLedger } from "./context";
import { memberName, memberPath, money, type Group } from "./data";

type Change = { before: unknown; after: unknown };
type Event = {
  id: number; actor: string | null; actorName: string | null; member: string | null;
  timestamp: string; type: string; entity: string; expense: string | null;
  action: string; title: string | null; reason: string | null;
  currency: string | null; chargedCurrency: string | null;
  changes: Record<string, Change>;
};
type Page = { events: Event[]; next: number | null };
const types = {
  expense: "Expenses", receipt: "Receipts", refund: "Refunds", credit: "Credits",
  settlement: "Payments", member: "Members", group: "Group settings",
};
const actions: Record<string, string> = {
  add: "added", edit: "updated", delete: "deleted", restore: "restored", remove: "removed",
  link: "linked", unlink: "unlinked", rename: "renamed", record: "recorded", approve: "approved",
  decline: "declined", cancel: "canceled", combine: "combined", "undo-combine": "undid the combination of",
  close: "closed", reopen: "reopened", claim: "changed the claims on", unclaim: "unclaimed items on",
  "receipt-people": "updated the people on", pair: "paired", move: "moved", detach: "detached", schedule: "updated the schedule for",
  dispute: "disputed", "dispute-edit": "resolved the dispute by editing",
  "dispute-dismiss": "dismissed the dispute on", "dispute-withdraw": "withdrew the dispute on",
  recurring: "recorded", resolve: "resolved", "payment-methods": "updated group payment methods for",
};
const labels: Record<string, string> = {
  paidBy: "payer", splits: "shares", createdAt: "date", chargedAmount: "charged amount",
  chargedCurrency: "charged currency", splitMode: "split method", bill: "receipt items",
  kind: "Group type", phase: "Trip phase",
};

function format(field: string, side: "before" | "after", event: Event, group: Group): string {
  const value = event.changes[field][side];
  if (field === "phase") return value === null ? "Automatic" : tripPhaseLabels[value as TripPhase] ?? String(value);
  if (field === "kind") {
    if (value === "trip") return "Trip";
    if (value === "home") return "Long-term / Home";
    if (value === "friend") return "Friends tab";
  }
  if (value === null) return "None";
  const currency = (event.changes.currency?.[side] as string | undefined) ?? event.currency ?? group.currency;
  const name = (id: string) => memberName(group, id);
  if (typeof value === "number" && (field === "amount" || field === "chargedAmount")) {
    const code = field === "chargedAmount"
      ? (event.changes.chargedCurrency?.[side] as string | undefined) ?? event.chargedCurrency ?? currency
      : currency;
    return money(value, code);
  }
  if (field === "paidBy" || field === "canonicalMember") return name(String(value));
  if (field === "linkedAccount") return group.members.find(member => member.userID === value)?.name ?? "Linked account";
  if (field === "createdAt") return String(value).slice(0,10);
  if (field === "participants") return (value as string[]).map(name).join(", ");
  if (field === "splits" || field === "payers") {
    return (value as { memberID: string; amount: number; nights?: number; stay?: {start: string; end: string} }[])
      .map(p => {
        const stay = p.stay ? ", " + p.stay.start + " to " + p.stay.end : "";
        const nights = p.nights === undefined ? "" : " (" + p.nights + " nights" + stay + ")";
        return name(p.memberID) + " " + money(p.amount, currency) + nights;
      }).join(", ");
  }
  if (field === "bill") {
    const bill = value as { closed: boolean; tax: number; tip: number; items: {title: string; amount: number; memberIDs: string[]; shares?: Record<string, number>}[] };
    const items = bill.items.map(i => i.title + " " + money(i.amount, currency) +
      " (" + (i.memberIDs.map(id => name(id) + (i.shares?.[id] ? " ×" + i.shares[id] / 100 : "")).join(", ") || "unclaimed") + ")");
    return [bill.closed ? "Closed" : "Open", ...items, "Tax " + money(bill.tax, currency), "Tip " + money(bill.tip, currency)].join("; ");
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function ChangeHistory({ group, expense, liveIDs, revision }: {
  group: Group; expense?: string; liveIDs?: ReadonlySet<string>; revision?: object;
}) {
  const { request, save, user, demo } = useLedger();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  const filter = expense ? new URLSearchParams({ expense }).toString() : new URLSearchParams(
    ["expense", "member", "type", "from", "to"].flatMap(key => params.get(key) ? [[key, params.get(key)!]] : []),
  ).toString();
  const endpoint = "/v1/groups/" + group.id + "/history?" + filter;

  useEffect(() => {
    let active = true;
    setError("");
    setPage(undefined);
    if (!demo) request<Page>(endpoint).then(value => { if (active) setPage(value); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [demo, endpoint, request, revision]);

  function update(key: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }
  async function more() {
    if (!page?.next) return;
    try {
      const next = await request<Page>(endpoint + "&before=" + page.next);
      setPage(current => current === page ? { events: [...page.events, ...next.events], next: next.next } : current);
    } catch (e) { setError((e as Error).message); }
  }
  const activity = "/g/" + group.id + "?tab=activity";
  return (
    <section className="card card-pad change-history" aria-label={expense ? "History" : "Activity"}>
      <h4>{expense ? "History" : "Activity"}</h4>
      {!expense && <div className="history-filters">
        <label className="field">Person<select value={params.get("member") ?? ""} onChange={e => update("member", e.target.value)}>
          <option value="">Everyone</option>
          {group.members.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label>
        <label className="field">Type<select value={params.get("type") ?? ""} onChange={e => update("type", e.target.value)}>
          <option value="">All changes</option>
          {Object.entries(types).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select></label>
        <label className="field">From<input type="date" value={params.get("from") ?? ""} onChange={e => update("from", e.target.value)} /></label>
        <label className="field">Through<input type="date" value={params.get("to") ?? ""} onChange={e => update("to", e.target.value)} /></label>
        {params.has("expense") && <button type="button" className="btn btn-sm" onClick={() => update("expense", "")}>Show all items</button>}
      </div>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {demo ? <p className="muted">History is available in synced groups.</p>
        : !page && !error ? <p className="muted" role="status">Loading changes…</p>
        : page?.events.length === 0 ? <p className="muted">No changes recorded.</p> : null}
      {page && <ol className="history-timeline">
        {page.events.map((event, index) => {
          const name = event.actorName ?? (event.actor ? "Group member" : event.action === "recurring" ? "Split" : "Unknown actor");
          const title = event.title ?? (event.type === "group" ? group.name : event.type);
          const linkedID = liveIDs?.has(event.entity) ? event.entity : event.expense;
          const href = linkedID
            ? liveIDs?.has(linkedID) ? "/g/" + group.id + "/e/" + linkedID : activity + "&expense=" + linkedID
            : event.type === "member" ? group.members.some(person => person.id === event.entity)
              ? memberPath(group, event.entity) : "/g/" + group.id + "?tab=members"
            : event.type === "receipt" ? "/g/" + group.id + "?tab=receipts" : "/g/" + group.id + "?tab=settings";
          const lifecycle = page.events.findIndex(e => e.type === "expense" && e.entity === params.get("expense") &&
            ["add", "delete", "restore", "combine", "undo-combine"].includes(e.action));
          const restorable = !expense && index === lifecycle && event.type === "expense" &&
            event.action === "delete" && event.actor === user && !liveIDs?.has(event.entity);
          const amountEdit = expense && event.action === "edit" && event.changes.amount?.before !== null && event.changes.amount?.before !== undefined;
          const fields = Object.entries(event.changes).filter(([key]) => !amountEdit || key !== "amount");
          return <li key={event.id}>
            <p><strong>{name}</strong> {amountEdit
              ? <>changed the amount from {format("amount", "before", event, group)} to {format("amount", "after", event, group)}.</>
              : <>{actions[event.action] ?? event.action} {expense ? title : <Link to={href}>{title}</Link>}.</>}</p>
            <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time>
            {event.reason && <p className="history-reason">Reason: {event.reason}</p>}
            {fields.length > 0 && <dl>
              {fields.map(([field, change]) =>
                <div key={field}><dt>{labels[field] ?? field.replace(/[A-Z]/g, letter => " " + letter.toLowerCase())}</dt>
                  <dd>{(change.before !== null || (field === "phase" && event.action === "edit")) && <>{format(field, "before", event, group)} <span aria-label="changed to">→</span> </>}
                    {format(field, "after", event, group)}</dd></div>,
              )}
            </dl>}
            {restorable && <Form label="Restore expense" submit={async () => {
              await save("/v1/entries/" + event.entity + "/restore", {});
              setPage(await request<Page>(endpoint));
            }} />}
          </li>;
        })}
      </ol>}
      {page?.next && <button className="btn btn-sm" onClick={() => void more()}>Earlier changes</button>}
    </section>
  );
}
