import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { dateText } from "./data";

export interface OpenDispute {
  id: string;
  entryID: string;
  groupID: string;
  title: string;
  canResolve: boolean;
  canWithdraw: boolean;
  actorName: string;
  comment: string;
}

type DisputeAction = "open" | "dismiss" | "withdraw";
interface DisputeEvent {
  id: string;
  entryID: string;
  groupID: string;
  title: string;
  action: "opened" | "edited" | "dismissed" | "withdrawn";
  actorName: string;
  comment: string;
  at: string;
}

const actionLabels = { open: "Dispute", dismiss: "Dismiss dispute", withdraw: "Withdraw dispute" };
const activityLabels = { opened: "disputed", edited: "resolved by editing", dismissed: "dismissed the dispute on", withdrawn: "withdrew the dispute on" };

export function DisputeControls({ id, eligible, dispute, onChange }: {
  id: string; eligible: boolean; dispute?: OpenDispute; onChange: () => Promise<void>;
}) {
  const { save } = useLedger();
  const [action, setAction] = useState<DisputeAction>();
  if (!eligible && !dispute) return null;
  return (
    <div className="card card-pad">
      {dispute && <p><span className="tag tag-pending">Pending</span> Disputed by {dispute.actorName}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {eligible && !dispute && <button className="btn btn-sm" onClick={() => setAction("open")}>Dispute</button>}
        {dispute?.canResolve && <Link className="btn btn-sm" to={`/g/${dispute.groupID}/e/${id}/edit`}>Edit and resolve</Link>}
        {dispute?.canResolve && <button className="btn btn-sm" onClick={() => setAction("dismiss")}>Dismiss dispute</button>}
        {dispute?.canWithdraw && <button className="btn btn-sm" onClick={() => setAction("withdraw")}>Withdraw dispute</button>}
      </div>
      {action && (
        <Form key={action} label={actionLabels[action]} cancel={() => setAction(undefined)} submit={async (fields) => {
          await save(`/v1/entries/${id}/dispute`, { action, comment: value(fields, "comment") });
          setAction(undefined);
          await onChange();
        }}>
          <label className="field">
            {action === "open" ? "What should the payer review?" : action === "withdraw" ? "Reply (optional)" : "Reply to the dispute"}
            <textarea name="comment" required={action !== "withdraw"} maxLength={2000} rows={3} />
          </label>
        </Form>
      )}
    </div>
  );
}

export function DisputesScreen() {
  const { data, request, demo } = useLedger();
  const [events, setEvents] = useState<DisputeEvent[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) return;
    let active = true;
    request<{events: DisputeEvent[]}>("/v1/disputes/activity")
      .then(({ events }) => { if (active) { setEvents(events); setError(""); } })
      .catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [data, demo, request]);
  const disputes = (data.disputes ?? []).filter(d => d.canResolve);
  return (
    <>
      <h1>Disputes to resolve</h1>
      <div className="card card-pad">
        {!disputes.length && <p className="muted">No disputes need your attention.</p>}
        {disputes.map(d => (
          <Link className="row" key={d.id} to={`/g/${d.groupID}/e/${d.entryID}`}>
            <div><strong>{d.title}</strong><p>{d.actorName}: {d.comment}</p></div>
            <span className="tag tag-pending">Pending</span>
          </Link>
        ))}
      </div>
      <h2>Dispute activity</h2>
      <div className="card card-pad">
        {error && <p role="alert">{error}</p>}
        {!error && !events.length && <p className="muted">No dispute activity yet.</p>}
        {events.map(event => (
          <div className="row" key={event.id}>
            <div>
              <strong>{event.actorName} {activityLabels[event.action]}{" "}
                {data.entries.some(e => e.id === event.entryID)
                  ? <Link to={`/g/${event.groupID}/e/${event.entryID}`}>{event.title}</Link> : event.title}
              </strong>
              {event.comment && <p>{event.comment}</p>}
            </div>
            <span className="muted">{dateText(event.at)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
