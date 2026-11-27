import { useHomeMoney } from "./homeMoney";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import { dateText, memberName, money, type Group } from "./data";

export function PendingPayments({ group }: { group?: Group }) {
  const { data, save, user } = useLedger();
  const homeMoney = useHomeMoney();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const groups = group ? [group] : data.groups;
  const requests = (data.settlementRequests ?? []).flatMap((entry) => {
    const g = groups.find((item) => item.id === entry.groupID);
    return g ? [{ entry, g }] : [];
  });
  if (!requests.length) return null;

  async function decide(id: string, action: "approve" | "decline" | "cancel") {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await save(`/v1/settlements/${id}/${action}`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this payment.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>Payments awaiting approval</h3>
          <p className="muted">Balances update after the recipient confirms.</p>
        </div>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {requests.map(({ entry, g }) => {
        const recipient = g.members.find((member) => member.id === entry.splits[0]?.memberID);
        const incoming = recipient?.userID === user;
        return (
          <div className="row" key={entry.id} style={{ flexWrap: "wrap", gap: 12 }}>
            <div>
              <strong>{incoming ? `${memberName(g, entry.paidBy)} paid you` : `You paid ${recipient?.name ?? "a member"}`}</strong>
              <span className="num" style={{ marginLeft: 8 }}>{homeMoney.entry(entry)}</span>
              {entry.currency !== homeMoney.home && <div className="muted">Payment sent as {money(entry.amount, entry.currency)}</div>}
              <div className="muted" style={{ fontSize: 12 }}>
                {!group && <><Link to={`/g/${g.id}?tab=settle`}>{g.name}</Link> · </>}
                {dateText(entry.createdAt)}
                {!incoming && !recipient?.userID && " · Waiting for recipient to join"}
              </div>
              {entry.notes && <p>{entry.notes}</p>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {incoming ? (
                <>
                  <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => void decide(entry.id, "decline")}>Decline</button>
                  <button className="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => void decide(entry.id, "approve")}>Confirm received</button>
                </>
              ) : (
                <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => void decide(entry.id, "cancel")}>Cancel request</button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
