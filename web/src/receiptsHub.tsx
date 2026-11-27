import { useHomeMoney } from "./homeMoney";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import {
  grossItems,
  itemPortions,
  memberName,
  moneyCompact,
  shortDate,
  type Expense,
  type Group,
} from "./data";
import { Avatar } from "./ui";

const FRACTION_STEPS = [50, 100, 150, 200, 250, 300, 400];
const formatShare = (w: number) => `${w / 100}x`;

function ReceiptViewer({ entryID, receiptIDs }: { entryID: string; receiptIDs: string[] }) {
  const { request } = useLedger();
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  const photoID = receiptIDs[page];

  useEffect(() => {
    if (!photoID) {
      setUrl("");
      return;
    }
    let alive = true;
    let obj = "";
    setFailed(false);
    setUrl("");
    request<Blob>(`/v1/entries/${entryID}/receipts/${photoID}`, undefined, true)
      .then((blob) => {
        if (alive) {
          obj = URL.createObjectURL(blob);
          setUrl(obj);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [request, entryID, photoID]);

  if (!receiptIDs.length) {
    return (
      <div className="photo-stage">
        <div className="photo-toolbar">
          <strong>Receipt Photo</strong>
          <span className="muted">None attached</span>
        </div>
        <div className="photo-viewport" style={{ height: 320, textAlign: "center" }}>
          <div>
            <p className="muted" style={{ fontSize: 13 }}>
              No photo attached to this receipt yet.
            </p>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Upload a photo when editing the expense or push one from your local AI via MCP.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="photo-stage">
      <div className="photo-toolbar">
        <strong>
          Receipt {receiptIDs.length > 1 ? `(${page + 1}/${receiptIDs.length})` : ""}
        </strong>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {receiptIDs.length > 1 && (
            <>
              <button className="btn btn-xs" disabled={page === 0} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              <button
                className="btn btn-xs"
                disabled={page >= receiptIDs.length - 1}
                onClick={() => setPage(page + 1)}
              >
                ›
              </button>
            </>
          )}
          <button className="btn btn-xs" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>
            −
          </button>
          <span className="mono" style={{ minWidth: 38, textAlign: "center", fontSize: 11.5 }}>
            {Math.round(zoom * 100)}%
          </span>
          <button className="btn btn-xs" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))}>
            +
          </button>
          <button className="btn btn-xs btn-ghost" onClick={() => setZoom(1)}>
            Reset
          </button>
        </div>
      </div>
      <div className="photo-viewport">
        {url ? (
          <img src={url} alt="Receipt" style={{ transform: `scale(${zoom})` }} onError={() => {
            setUrl("");
            setFailed(true);
          }} />
        ) : failed ? (
          <p className="muted">Could not load receipt photo.</p>
        ) : (
          <p className="muted">Loading receipt…</p>
        )}
      </div>
    </div>
  );
}

export function ReceiptsHub({
  g,
  entries,
  initialEntryID,
}: {
  g: Group;
  entries: Expense[];
  initialEntryID?: string | null;
}) {
  const { save, user } = useLedger();
  const homeMoney = useHomeMoney();
  const receiptEntries = entries.filter((e) => e.bill || (e.receiptIDs && e.receiptIDs.length > 0));
  const [selectedID, setSelectedID] = useState<string>(
    () => initialEntryID || receiptEntries[0]?.id || "",
  );
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [closingOpen, setClosingOpen] = useState(false);
  const [closeMembers, setCloseMembers] = useState<string[]>(() =>
    g.members.filter((m) => !m.removed).map((m) => m.id),
  );

  const selected = receiptEntries.find((e) => e.id === selectedID) ?? receiptEntries[0];

  if (!receiptEntries.length) {
    return (
      <div className="card card-pad" style={{ textAlign: "center", padding: "48px 24px" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No receipts in this group yet</h3>
        <p className="muted" style={{ maxWidth: 440, margin: "0 auto 16px" }}>
          Add an itemized receipt or attach a receipt photo to an expense—or send a receipt photo to your local LLM via Split MCP.
        </p>
        <Link className="btn btn-primary" to={`/g/${g.id}/new?receipt=1`}>
          + Add itemized receipt
        </Link>
      </div>
    );
  }

  const openList = receiptEntries.filter((e) => e.bill && !e.bill.closed);
  const closedList = receiptEntries.filter((e) => !e.bill || e.bill.closed);

  const bill = selected?.bill;
  const gross = bill ? grossItems(bill) : [];
  const unclaimedItems = gross.filter((i) => !i.memberIDs.length);
  const unclaimedTotal = unclaimedItems.reduce((s, i) => s + i.gross, 0);
  const payer = selected ? g.members.find((m) => m.id === selected.paidBy) : undefined;
  const canClose =
    Boolean(bill && !bill.closed) &&
    Boolean(payer?.userID === user || (!payer?.userID && selected?.editable));
  const activeMembers = g.members.filter((m) => !m.removed);

  async function updateClaim(
    entry: Expense,
    item: NonNullable<Expense["bill"]>["items"][number],
    nextMemberIDs: string[],
    nextShares: Record<string, number>,
  ) {
    setBusyKey(item.id);
    setError("");
    try {
      await save(`/v1/entries/${entry.id}/claim`, {
        itemID: item.id,
        original: item.memberIDs,
        memberIDs: nextMemberIDs,
        shares: nextShares,
        mergeEdits: true,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the claim.");
    } finally {
      setBusyKey("");
    }
  }

  function toggleMember(entry: Expense, item: NonNullable<Expense["bill"]>["items"][number], mid: string) {
    const has = item.memberIDs.includes(mid);
    const nextIDs = has ? item.memberIDs.filter((id) => id !== mid) : [...item.memberIDs, mid];
    void updateClaim(entry, item, nextIDs, {});
  }

  function stepShare(entry: Expense, item: NonNullable<Expense["bill"]>["items"][number], mid: string, delta: number) {
    const current = item.shares?.[mid] ?? 100;
    const idx = FRACTION_STEPS.indexOf(current);
    const next =
      idx >= 0
        ? FRACTION_STEPS[Math.max(0, Math.min(FRACTION_STEPS.length - 1, idx + delta))]
        : Math.max(1, Math.min(100_000, current + delta * 50));
    if (next !== current) void updateClaim(entry, item, item.memberIDs, { [mid]: next });
  }

  async function copyReminder() {
    if (!selected || !bill) return;
    const lines = unclaimedItems.map((i) => `• ${i.title} (${moneyCompact(i.gross, selected.currency)} incl. tax/tip)`);
    const url = new URL(window.location.href);
    url.searchParams.set("receipt", selected.id);
    const text = `Hey! ${unclaimedItems.length} item${unclaimedItems.length === 1 ? "" : "s"} (${moneyCompact(unclaimedTotal, selected.currency)}) still need to be claimed on "${selected.title}" (${g.name}):\n${lines.join("\n")}\nClaim here: ${url}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setError("Could not copy the reminder.");
    }
  }

  function selectReceipt(id: string) {
    setSelectedID(id);
    setClosingOpen(false);
    setError("");
    setCopied(false);
  }

  return (
    <div className="receipts-hub">
      {/* Left Pane: Receipts List */}
      <div className="card" style={{ overflow: "hidden" }}>
        {openList.length > 0 && (
          <>
            <div className="card-head" style={{ padding: "10px 14px" }}>
              <h3 style={{ fontSize: 12, color: "var(--warn)" }}>Needs Claiming ({openList.length})</h3>
            </div>
            {openList.map((e) => {
              const openCount = e.bill?.items.filter((i) => !i.memberIDs.length).length ?? 0;
              return (
                <button
                  key={e.id}
                  type="button"
                  className={"receipt-list-item" + (selected?.id === e.id ? " active" : "")}
                  disabled={Boolean(busyKey)}
                  onClick={() => selectReceipt(e.id)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>{e.title}</strong>
                    <span className="num" style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {homeMoney.entry(e)}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                    <span className="muted">{shortDate(e.createdAt)} · {memberName(g, e.paidBy)}</span>
                    {openCount > 0 ? (
                      <span className="warn" style={{ fontWeight: 600 }}>{openCount} open</span>
                    ) : (
                      <span className="pos" style={{ fontWeight: 600 }}>All claimed</span>
                    )}
                  </div>
                </button>
              );
            })}
          </>
        )}

        {closedList.length > 0 && (
          <>
            <div className="card-head" style={{ padding: "10px 14px" }}>
              <h3 style={{ fontSize: 12, color: "var(--muted)" }}>Closed & Photos ({closedList.length})</h3>
            </div>
            {closedList.map((e) => (
              <button
                key={e.id}
                type="button"
                className={"receipt-list-item" + (selected?.id === e.id ? " active" : "")}
                disabled={Boolean(busyKey)}
                onClick={() => selectReceipt(e.id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <strong style={{ fontSize: 13 }}>{e.title}</strong>
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700 }}>
                    {homeMoney.entry(e)}
                  </span>
                </div>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {shortDate(e.createdAt)} · {e.bill?.closed ? "Closed" : "Photo attached"}
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* Center Pane: Zoomable Receipt Photo */}
      {selected && (
        <ReceiptViewer key={selected.id} entryID={selected.id} receiptIDs={selected.receiptIDs ?? []} />
      )}

      {/* Right Pane: Interactive Fractional Claiming */}
      {selected && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head">
            <div>
              <h3 style={{ fontSize: 15 }}>{selected.title}</h3>
              <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Paid by {memberName(g, selected.paidBy)} · {shortDate(selected.createdAt)} · Total{" "}
                <b className="num">{homeMoney.entry(selected, selected.amount)}</b>
              </p>
            </div>
            {bill?.closed ? (
              <span className="tag tag-pos">Closed</span>
            ) : bill ? (
              <span className="tag tag-warn">Open</span>
            ) : (
              <span className="tag">Standard split</span>
            )}
          </div>

          {error && <p className="error-banner" role="alert">{error}</p>}

          {bill && !bill.closed && (unclaimedItems.length > 0 || canClose) && (
            <div
              style={{
                padding: "12px 16px",
                background: "var(--warn-soft)",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div>
                <strong className="warn" style={{ fontSize: 13 }}>
                  {unclaimedItems.length ? `${unclaimedItems.length} unclaimed · ${homeMoney.entry(selected, unclaimedTotal)}` : "All items claimed"}
                </strong>
                {unclaimedItems.length > 0 && <p className="muted" style={{ fontSize: 12 }}>
                  Currently sitting on {memberName(g, selected.paidBy)} until claimed.
                </p>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {unclaimedItems.length > 0 && <button type="button" className="btn btn-xs" onClick={copyReminder}>
                  {copied ? "Copied!" : "Copy reminder"}
                </button>}
                {canClose && (
                  <button type="button" className="btn btn-xs btn-primary" disabled={Boolean(busyKey)} onClick={() => {
                    setCloseMembers(activeMembers.map((m) => m.id));
                    setClosingOpen(!closingOpen);
                  }}>
                    Close receipt
                  </button>
                )}
              </div>
            </div>
          )}

          {closingOpen && canClose && (
            <div style={{ padding: "12px 16px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                {unclaimedItems.length ? "Split remaining open items evenly across:" : "Confirm the final item allocations."}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {unclaimedItems.length > 0 && activeMembers.map((m) => (
                  <label key={m.id} className="check" style={{ fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={closeMembers.includes(m.id)}
                      onChange={(e) =>
                        setCloseMembers(
                          e.target.checked
                            ? [...closeMembers, m.id]
                            : closeMembers.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={Boolean(busyKey) || (unclaimedItems.length > 0 && !closeMembers.length)}
                  onClick={async () => {
                    setBusyKey(selected.id);
                    setError("");
                    try {
                      await save(`/v1/entries/${selected.id}/close`, { memberIDs: unclaimedItems.length ? closeMembers : [] });
                      setClosingOpen(false);
                    } catch (error) {
                      setError(error instanceof Error ? error.message : "Could not close the receipt.");
                    } finally {
                      setBusyKey("");
                    }
                  }}
                >
                  Confirm & close receipt
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setClosingOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {bill ? (
            <div>
              {gross.map((item) => {
                const isOpen = !item.memberIDs.length;
                const portions = itemPortions(item, selected.paidBy);
                return (
                  <div key={item.id} className={"claim-item" + (isOpen && !bill.closed ? " unclaimed" : "")}>
                    <div className="claim-item-top">
                      <div>
                        <strong style={{ fontSize: 13.5 }}>{item.title}</strong>
                        {isOpen && (
                          <span className="tag tag-warn" style={{ marginLeft: 8 }}>
                            Unclaimed
                          </span>
                        )}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <strong className="num" style={{ fontSize: 13.5 }}>
                          {homeMoney.entry(selected, item.amount)}
                        </strong>
                        {item.gross !== item.amount && (
                          <div className="muted num" style={{ fontSize: 11 }}>
                            {homeMoney.entry(selected, item.gross)} w/ tax & tip
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="claim-pills">
                      {g.members.filter((m) => !m.removed || item.memberIDs.includes(m.id)).map((m) => {
                        const claimed = item.memberIDs.includes(m.id);
                        const weight = item.shares?.[m.id] ?? 100;
                        const myCents = claimed ? portions.reduce((sum, p) => sum + (p.memberID === m.id ? p.amount : 0), 0) : null;
                        return (
                          <div
                            key={m.id}
                            className={"claim-pill" + (claimed ? " on" : "")}
                            style={{ opacity: busyKey === item.id ? 0.6 : 1 }}
                          >
                            <button
                              type="button"
                              disabled={bill.closed || Boolean(busyKey)}
                              onClick={() => toggleMember(selected, item, m.id)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                border: 0,
                                background: "transparent",
                                padding: 0,
                                cursor: bill.closed ? "default" : "pointer",
                                color: "inherit",
                                fontWeight: "inherit",
                              }}
                            >
                              <Avatar name={m.name} avatarURL={m.avatarURL} size={20} />
                              <span>{m.name.split(" ")[0]}</span>
                              {myCents !== null && (
                                <span className="num" style={{ fontSize: 11, opacity: 0.85 }}>
                                  {homeMoney.entry(selected, myCents)}
                                </span>
                              )}
                            </button>
                            {claimed && !bill.closed && !item.roundingSeats && (
                              <span className="qty-stepper" title="Adjust fractional share">
                                <button
                                  type="button"
                                  aria-label={`Decrease ${m.name} share`}
                                  disabled={Boolean(busyKey) || weight === FRACTION_STEPS[0]}
                                  onClick={() => stepShare(selected, item, m.id, -1)}
                                >
                                  −
                                </button>
                                <span>{formatShare(weight)}</span>
                                <button
                                  type="button"
                                  aria-label={`Increase ${m.name} share`}
                                  disabled={Boolean(busyKey) || weight === FRACTION_STEPS.at(-1) || weight === 100_000}
                                  onClick={() => stepShare(selected, item, m.id, 1)}
                                >
                                  +
                                </button>
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div style={{ padding: "12px 16px", background: "var(--surface-2)", fontSize: 12.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span className="muted">Tax (proportional)</span>
                  <b className="num">{homeMoney.entry(selected, bill.tax)}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="muted">Tip (proportional)</span>
                  <b className="num">{homeMoney.entry(selected, bill.tip)}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                  <strong>Receipt Total</strong>
                  <strong className="num">{homeMoney.entry(selected, selected.amount)}</strong>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 16 }}>
              <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                This expense has a receipt photo attached and is split directly:
              </p>
              <div className="panel">
                {selected.splits.map((s) => (
                  <div className="row" key={s.memberID}>
                    <span>{memberName(g, s.memberID)}</span>
                    <b className="num">{homeMoney.entry(selected, s.amount)}</b>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
