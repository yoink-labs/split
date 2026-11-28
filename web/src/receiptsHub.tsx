import { useHomeMoney } from "./homeMoney";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import {
  grossItems,
  itemPortions,
  MAX_RECEIPTS,
  memberName,
  moneyCompact,
  receiptPhoto,
  shortDate,
  type Expense,
  type Group,
  type InboxReceipt,
} from "./data";
import { Picker } from "./picker";
import { Avatar } from "./ui";

const FRACTION_STEPS = [50, 100, 150, 200, 250, 300, 400];
const formatShare = (w: number) => `${w / 100}x`;

/** Loads one receipt photo through the signed-in request helper and hands back an object URL. */
function useReceiptImage(path: string | null) {
  const { request } = useLedger();
  const [state, setState] = useState<{ url: string; failed: boolean }>({ url: "", failed: false });
  useEffect(() => {
    setState({ url: "", failed: false });
    if (!path) return;
    let alive = true;
    let obj = "";
    request<Blob>(path, undefined, true)
      .then((blob) => {
        if (!alive) return;
        obj = URL.createObjectURL(blob);
        setState({ url: obj, failed: false });
      })
      .catch(() => {
        if (alive) setState({ url: "", failed: true });
      });
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [request, path]);
  return { ...state, fail: () => setState({ url: "", failed: true }) };
}

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const receiptCount = (e: Expense) => e.receiptIDs?.length ?? 0;

/** Expenses in the group that can take one more receipt photo, newest first. */
function receiptTargets(entries: Expense[], except?: string) {
  return entries
    .filter((e) => e.kind === "expense" && !e.combinedCount && e.id !== except && receiptCount(e) < MAX_RECEIPTS)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function ExpenseChoice({
  label,
  entries,
  value,
  onChange,
}: {
  label: string;
  entries: Expense[];
  value: string;
  onChange: (id: string) => void;
}) {
  const homeMoney = useHomeMoney();
  const options = [
    { value: "", label: "Choose an expense…" },
    ...entries.map((e) => ({
      value: e.id,
      label: `${e.title} · ${shortDate(e.createdAt)} · ${homeMoney.entry(e)}${receiptCount(e) ? ` · ${receiptCount(e)}/${MAX_RECEIPTS} photos` : ""}`,
    })),
  ];
  return <Picker label={label} value={value} options={options} onChange={onChange} search={entries.length > 6} />;
}

function ReceiptViewer({
  entry,
  entries,
  onMoved,
}: {
  entry: Expense;
  entries: Expense[];
  onMoved: () => void;
}) {
  const { save } = useLedger();
  const receiptIDs = entry.receiptIDs ?? [];
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = Math.min(page, Math.max(0, receiptIDs.length - 1));
  const photoID = receiptIDs[current];
  const image = useReceiptImage(photoID ? `/v1/entries/${entry.id}/receipts/${photoID}` : null);
  const targets = receiptTargets(entries, entry.id);

  async function move(to: string | null) {
    if (!photoID || busy) return;
    setBusy(true);
    setError("");
    try {
      await save(`/v1/entries/${entry.id}/receipts/${photoID}/move`, { entryID: to });
      setMoving(false);
      setTarget("");
      setPage(0);
      onMoved();
    } catch (error) {
      setError(errorText(error, "Could not move the receipt."));
    } finally {
      setBusy(false);
    }
  }

  if (!receiptIDs.length) {
    return (
      <div className="photo-stage">
        <div className="photo-toolbar">
          <strong>Receipt photo</strong>
          <span className="muted">None attached</span>
        </div>
        <div className="photo-viewport photo-empty">
          <div className="photo-empty-copy">
            <p className="muted">No photo attached to this expense yet.</p>
            <p className="muted">
              Pair one from the receipts inbox, upload one when editing the expense, or push one via Split MCP.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="photo-stage">
      <div className="photo-toolbar">
        <div className="photo-toolbar-left">
          <strong>
            Receipt{receiptIDs.length > 1 ? ` ${current + 1}/${receiptIDs.length}` : ""}
          </strong>
          {receiptIDs.length > 1 && (
            <div className="photo-pager">
              <button type="button" className="btn btn-xs" aria-label="Previous photo" disabled={current === 0} onClick={() => setPage(current - 1)}>
                ‹
              </button>
              <button
                type="button"
                className="btn btn-xs"
                aria-label="Next photo"
                disabled={current >= receiptIDs.length - 1}
                onClick={() => setPage(current + 1)}
              >
                ›
              </button>
            </div>
          )}
        </div>
        <div className="photo-toolbar-right">
          <div className="photo-zoom-group" role="group" aria-label="Zoom">
            <button type="button" className="btn btn-xs" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>
              −
            </button>
            <button type="button" className="btn btn-xs photo-zoom-pct mono" title="Reset zoom" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="btn btn-xs" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))}>
              +
            </button>
          </div>
          {!entry.combinedCount && <button type="button" className="btn btn-xs" aria-expanded={moving} disabled={busy} onClick={() => { setMoving(!moving); setError(""); }}>
            Move…
          </button>}
        </div>
      </div>
      {moving && (
        <div className="receipt-move">
          <p>Move this photo to another expense in the group, or back to the receipts inbox.</p>
          <ExpenseChoice label="Move receipt to" entries={targets} value={target} onChange={setTarget} />
          <div className="receipt-move-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !target} onClick={() => void move(target)}>
              {busy ? "Moving…" : "Move"}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void move(null)}>
              Back to inbox
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMoving(false)}>
              Cancel
            </button>
          </div>
          {error && <p className="error-banner" role="alert">{error}</p>}
        </div>
      )}
      <div className="photo-viewport">
        {image.url ? (
          <img src={image.url} alt="Receipt" style={{ transform: `scale(${zoom})` }} onError={image.fail} />
        ) : image.failed ? (
          <p className="muted">Could not load receipt photo.</p>
        ) : (
          <p className="muted">Loading receipt…</p>
        )}
      </div>
    </div>
  );
}

function InboxTile({
  g,
  receipt,
  entries,
  mine,
  busy,
  onPair,
  onDelete,
}: {
  g: Group;
  receipt: InboxReceipt;
  entries: Expense[];
  mine: boolean;
  busy: boolean;
  onPair: (entryID: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const image = useReceiptImage(`/v1/groups/${g.id}/receipts/${receipt.id}`);
  const [pairing, setPairing] = useState(false);
  const [target, setTarget] = useState("");
  const [zoomed, setZoomed] = useState(false);
  return (
    <li className={"inbox-tile" + (pairing ? " pairing" : "")}>
      <div className="inbox-tile-row">
        <button type="button" className="inbox-thumb" aria-label="View receipt photo" onClick={() => setZoomed(!zoomed)} disabled={!image.url}>
          {image.url ? <img src={image.url} alt="" onError={image.fail} /> : <span className="muted">{image.failed ? "No preview" : "Loading…"}</span>}
        </button>
        <div className="inbox-tile-body">
          <div className="inbox-meta">
            <strong>{receipt.note?.trim() || "Receipt photo"}</strong>
            <span className="muted">{memberName(g, receipt.uploadedBy)} · {shortDate(receipt.createdAt)}</span>
          </div>
          {!pairing && (
            <div className="receipt-move-actions">
              <button type="button" className="btn btn-xs btn-primary" disabled={busy || !entries.length} onClick={() => setPairing(true)}>
                Pair with expense
              </button>
              {mine && (
                <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => void onDelete()}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {pairing && (
        <div className="inbox-pair">
          <ExpenseChoice label="Pair receipt with" entries={entries} value={target} onChange={setTarget} />
          <div className="receipt-move-actions">
            <button type="button" className="btn btn-xs btn-primary" disabled={busy || !target}
              onClick={() => void onPair(target).then(() => setPairing(false), () => {})}>
              {busy ? "Pairing…" : "Pair"}
            </button>
            <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => setPairing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {zoomed && image.url && (
        <div className="inbox-zoom" role="dialog" aria-label="Receipt photo" onClick={() => setZoomed(false)}>
          <img src={image.url} alt="Receipt" />
        </div>
      )}
    </li>
  );
}

/** Receipts uploaded to the group before anyone has paired them with an expense. */
function ReceiptsInbox({
  g,
  entries,
  receipts,
  loading,
  reload,
  onPaired,
}: {
  g: Group;
  entries: Expense[];
  receipts: InboxReceipt[];
  loading: boolean;
  reload: () => Promise<void>;
  onPaired: (entryID: string) => void;
}) {
  const { request, save, user } = useLedger();
  const me = g.members.find((m) => m.userID === user && !m.removed);
  const [busyID, setBusyID] = useState("");
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const targets = receiptTargets(entries);

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of files.slice(0, MAX_RECEIPTS)) {
        const { id, data } = await receiptPhoto(file);
        await request(`/v1/groups/${g.id}/receipts`, { id, data, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}) });
      }
      setNote("");
      if (files.length > MAX_RECEIPTS) setError(`Uploaded the first ${MAX_RECEIPTS} photos.`);
    } catch (error) {
      setError(errorText(error, "Could not upload the receipt."));
    } finally {
      if (input.current) input.current.value = "";
      setUploading(false);
      await reload();
    }
  }

  async function pair(receipt: InboxReceipt, entryID: string) {
    setBusyID(receipt.id);
    setError("");
    try {
      await save(`/v1/groups/${g.id}/receipts/${receipt.id}/pair`, { entryID });
      await reload();
      onPaired(entryID);
    } catch (error) {
      setError(errorText(error, "Could not pair the receipt."));
      throw error;
    } finally {
      setBusyID("");
    }
  }

  async function remove(receipt: InboxReceipt) {
    if (!window.confirm("Delete this receipt photo from the inbox?")) return;
    setBusyID(receipt.id);
    setError("");
    try {
      await request(`/v1/groups/${g.id}/receipts/${receipt.id}/delete`, {});
      await reload();
    } catch (error) {
      setError(errorText(error, "Could not delete the receipt."));
    } finally {
      setBusyID("");
    }
  }

  return (
    <section className="card receipts-inbox" aria-labelledby="receipts-inbox-title">
      <div className="card-head">
        <div>
          <h3 id="receipts-inbox-title" style={{ fontSize: 15 }}>
            Receipts inbox {receipts.length > 0 && <span className="tag">{receipts.length}</span>}
          </h3>
          <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Upload a receipt now and pair it with an expense later. Each expense holds up to {MAX_RECEIPTS} photos.
          </p>
        </div>
        <div className="inbox-upload">
          <input type="text" value={note} maxLength={200} placeholder="Note (optional)" aria-label="Receipt note"
            onChange={(event) => setNote(event.target.value)} disabled={uploading} />
          <label className={"btn btn-sm" + (uploading ? " disabled" : "")}>
            <input ref={input} type="file" accept="image/*" multiple hidden disabled={uploading}
              onChange={(event) => void upload(Array.from(event.currentTarget.files ?? []))} />
            {uploading ? "Uploading…" : "Upload receipt"}
          </label>
        </div>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {receipts.length ? (
        <ul className="inbox-grid">
          {receipts.map((r) => (
            <InboxTile key={r.id} g={g} receipt={r} entries={targets} mine={r.uploadedBy === me?.id}
              busy={busyID === r.id} onPair={(entryID) => pair(r, entryID)} onDelete={() => remove(r)} />
          ))}
        </ul>
      ) : (
        <p className="muted inbox-empty">{loading ? "Loading the inbox…" : "No unpaired receipts. Uploaded photos wait here until someone pairs them."}</p>
      )}
    </section>
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
  const { save, user, request, demo } = useLedger();
  const homeMoney = useHomeMoney();
  const [inbox, setInbox] = useState<InboxReceipt[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxError, setInboxError] = useState("");
  const reloadInbox = useCallback(async () => {
    try {
      const { receipts } = await request<{ receipts: InboxReceipt[] }>(`/v1/groups/${g.id}/receipts`);
      setInbox(receipts);
      setInboxError("");
    } catch (error) {
      setInboxError(errorText(error, "Could not load the receipts inbox."));
    } finally {
      setInboxLoading(false);
    }
  }, [request, g.id]);
  useEffect(() => {
    void reloadInbox();
  }, [reloadInbox]);
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

  const inboxPanel = (
    <>
      {inboxError && <p className="error-banner" role="alert">{inboxError}</p>}
      <ReceiptsInbox g={g} entries={entries} receipts={inbox} loading={inboxLoading} reload={reloadInbox}
        onPaired={(entryID) => selectReceipt(entryID)} />
    </>
  );

  if (!receiptEntries.length) {
    return (
      <div className="form-stack" style={{ gap: 16 }}>
      {inboxPanel}
      <div className="card card-pad" style={{ textAlign: "center", padding: "48px 24px" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No receipts in this group yet</h3>
        <p className="muted" style={{ maxWidth: 440, margin: "0 auto 16px" }}>
          Add an itemized receipt or attach a receipt photo to an expense—or send a receipt photo to your local LLM via Split MCP.
        </p>
        <Link className="btn btn-primary" to={`/g/${g.id}/new?receipt=1`}>
          + Add itemized receipt
        </Link>
      </div>
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
  const activeMembers = g.members.filter((m) => !m.removed);
  const canClaim = demo || activeMembers.some((m) => m.userID === user);
  const canClose = canClaim && Boolean(bill && !bill.closed) &&
    Boolean(payer?.userID === user || (!payer?.userID && selected?.editable));

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
    <div className="receipts-page">
      {inboxPanel}
      <div className="receipts-hub">
        {/* Left Pane: Receipts List */}
        <div className="card receipts-list-pane">
          <div className="receipts-list-scroll">
            {openList.length > 0 && (
              <div className="receipts-list-group">
                <div className="receipts-list-subhead">
                  <span className="warn">Needs claiming</span>
                  <span className="tag tag-warn">{openList.length}</span>
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
                      <div className="receipt-list-top">
                        <strong>{e.title}</strong>
                        <span className="num">{homeMoney.entry(e)}</span>
                      </div>
                      <div className="receipt-list-sub">
                        <span className="muted">{shortDate(e.createdAt)} · {memberName(g, e.paidBy)}</span>
                        {openCount > 0 ? (
                          <span className="warn">{openCount} open</span>
                        ) : (
                          <span className="pos">All claimed</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {closedList.length > 0 && (
              <div className="receipts-list-group">
                <div className="receipts-list-subhead">
                  <span className="muted">Closed & photos</span>
                  <span className="tag">{closedList.length}</span>
                </div>
                {closedList.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={"receipt-list-item" + (selected?.id === e.id ? " active" : "")}
                    disabled={Boolean(busyKey)}
                    onClick={() => selectReceipt(e.id)}
                  >
                    <div className="receipt-list-top">
                      <strong>{e.title}</strong>
                      <span className="num">{homeMoney.entry(e)}</span>
                    </div>
                    <span className="muted receipt-list-sub">
                      {shortDate(e.createdAt)} · {e.bill?.closed ? "Closed" : "Photo attached"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Center Pane: Zoomable Receipt Photo */}
        {selected && (
          <ReceiptViewer key={selected.id} entry={selected} entries={entries} onMoved={() => void reloadInbox()} />
        )}

        {/* Right Pane: Interactive Fractional Claiming */}
        {selected && (
          <div className="card receipts-detail-pane">
            <div className="card-head">
              <div style={{ minWidth: 0 }}>
                <h3 style={{ fontSize: 15 }}>{selected.title}</h3>
                <p className="muted card-sub">
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

            {error && <p className="error-banner" role="alert" style={{ margin: "10px 14px 0" }}>{error}</p>}

            {bill && !bill.closed && (unclaimedItems.length > 0 || canClose) && (
              <div className="receipts-alert-bar">
                <div>
                  <strong className="warn">
                    {unclaimedItems.length ? `${unclaimedItems.length} unclaimed · ${homeMoney.entry(selected, unclaimedTotal)}` : "All items claimed"}
                  </strong>
                  {unclaimedItems.length > 0 && <p className="muted">
                    Sitting on {memberName(g, selected.paidBy)} until claimed.
                  </p>}
                </div>
                <div className="receipt-move-actions">
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
              <div className="receipts-close-bar">
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
              <>
                <div className="receipts-items-scroll">
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
                                  disabled={!canClaim || Boolean(busyKey)}
                                  onClick={() => toggleMember(selected, item, m.id)}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    border: 0,
                                    background: "transparent",
                                    padding: 0,
                                    cursor: canClaim ? "pointer" : "default",
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
                                {claimed && canClaim && !item.roundingSeats && (
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
                </div>

                <div className="receipts-total-foot">
                  <div>
                    <span className="muted">Tax (proportional)</span>
                    <b className="num">{homeMoney.entry(selected, bill.tax)}</b>
                  </div>
                  <div>
                    <span className="muted">Tip (proportional)</span>
                    <b className="num">{homeMoney.entry(selected, bill.tip)}</b>
                  </div>
                  <div className="receipts-total-row">
                    <strong>Receipt total</strong>
                    <strong className="num">{homeMoney.entry(selected, selected.amount)}</strong>
                  </div>
                </div>
              </>
            ) : (
              <div className="receipts-items-scroll" style={{ padding: 16 }}>
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
    </div>
  );
}
