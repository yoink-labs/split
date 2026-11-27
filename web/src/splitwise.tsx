// Import from Splitwise: pick one or more "Export as spreadsheet" CSVs (one group each),
// preview, map names to people, then import each group atomically.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import { Avatar, CategoryIcon } from "./ui";
import { currencies, money, type Group } from "./data";
import {
  importGroupID,
  mainCurrency,
  parseSplitwise,
  reconcile,
  type SplitwiseGroup,
} from "../../worker/src/splitwiseCsv";
import "./splitwise.css";

type Mapping = "me" | "new" | string;
interface Pending {
  key: string;
  file: string;
  parsed?: SplitwiseGroup;
  error?: string;
  name: string;
  currency: string;
  target: "new" | string;
  mapping: Record<string, Mapping>;
  status: "ready" | "importing" | "done" | "failed";
  result?: string;
}
interface Result {
  groupID: string;
  created: boolean;
  inserted: number;
  duplicates: number;
}

const norm = (s: string) => s.trim().toLowerCase();

function guessMapping(
  g: SplitwiseGroup,
  target: Group | undefined,
  user: string,
): Record<string, Mapping> {
  const full = norm(window.Clerk?.user?.fullName ?? "");
  const first = full.split(" ")[0];
  const mine = target?.members.find((m) => m.userID === user);
  const out: Record<string, Mapping> = {};
  let meTaken = false;
  for (const name of g.members) {
    const n = norm(name);
    const isMe =
      !meTaken &&
      !!full &&
      (n === full || n === first || (mine && n === norm(mine.name)));
    if (isMe) {
      out[name] = "me";
      meTaken = true;
      continue;
    }
    const match = target?.members.find(
      (m) => m.userID !== user && norm(m.name) === n,
    );
    out[name] = match ? match.id : "new";
  }
  return out;
}

export function SplitwiseImport() {
  const { data, user, request, refresh } = useLedger();
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileMessage, setFileMessage] = useState("");
  const dragDepth = useRef(0);
  const own = data.groups.filter((g) => g.members.some((m) => m.userID === user));

  useEffect(() => {
    // File drops outside the chooser should leave the in-progress review open.
    function preventFileNavigation(e: globalThis.DragEvent) {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  async function choose(files: FileList | null) {
    if (!files?.length) return;
    if (reading || busy) {
      setFileMessage("Wait for the current files to finish, then add more.");
      return;
    }
    setFileMessage("");
    setReading(true);
    try {
      const next: Pending[] = [];
      for (const file of Array.from(files)) {
        const key = file.name + ":" + file.size + ":" + file.lastModified;
        try {
          if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
            throw new Error("Choose a CSV export from Splitwise.");
          }
          if (file.size > 2_000_000) throw new Error("Choose a file that is 2 MB or smaller.");
          const parsed = await parseSplitwise(await file.text(), file.name);
          next.push({
            key,
            file: file.name,
            parsed,
            name: parsed.name,
            currency: mainCurrency(parsed),
            target: "new",
            mapping: guessMapping(parsed, undefined, user),
            status: "ready",
          });
        } catch (e) {
          next.push({ key, file: file.name, error: e instanceof Error ? e.message : "Could not read this file.", name: "", currency: "USD", target: "new", mapping: {}, status: "failed" });
        }
      }
      setItems((old) => [...old.filter((o) => !next.some((n) => n.key === o.key)), ...next]);
    } finally {
      setReading(false);
    }
  }

  function dragEnter(e: DragEvent<HTMLLabelElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!reading && !busy) setDragging(true);
  }

  function dragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }

  function drop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void choose(e.dataTransfer.files);
  }

  function update(key: string, change: Partial<Pending>) {
    setItems((old) => old.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }

  function problem(i: Pending): string | null {
    if (!i.parsed) return null;
    const values = Object.values(i.mapping);
    if (values.filter((v) => v === "me").length > 1) return "Choose yourself once.";
    if (i.target === "new" && !values.includes("me")) return "Choose which Splitwise name is you.";
    const picked = values.filter((v) => v !== "new");
    if (new Set(picked).size !== picked.length) return "Two names point to the same person.";
    if (i.target === "new" && !i.name.trim()) return "Name the group.";
    return null;
  }

  async function importAll() {
    setBusy(true);
    try {
      for (const i of items) {
        if (i.status !== "ready" || !i.parsed || problem(i)) continue;
        update(i.key, { status: "importing", result: undefined });
        try {
          const people = i.parsed.members.map((name) => {
            const m = i.mapping[name];
            return m === "me" ? { name, me: true } : m === "new" ? { name } : { name, memberID: m };
          });
          const body =
            i.target === "new"
              ? {
                  group: { id: await importGroupID(i.parsed.fingerprint, user), name: i.name.trim(), kind: "trip", currency: i.currency },
                  people,
                  rows: i.parsed.rows,
                }
              : { groupID: i.target, people, rows: i.parsed.rows };
          const r = await request<Result>("/v1/import/splitwise", body);
          update(i.key, {
            status: "done",
            target: r.groupID,
            result:
              !r.created && r.inserted === 0
                ? "Already imported. Nothing changed."
                : `${r.created ? "Created the group. " : ""}Imported ${r.inserted} ${r.inserted === 1 ? "entry" : "entries"}${r.duplicates ? `, skipped ${r.duplicates} already there` : ""}.`,
          });
        } catch (e) {
          update(i.key, { status: "ready", result: e instanceof Error ? e.message : "Import failed. Nothing was saved." });
        }
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const ready = items.filter((i) => i.status === "ready" && i.parsed && !problem(i));
  const hasPendingGroups = items.some((i) => i.parsed && i.status !== "done");
  return (
    <div className="splitwise-import">
      <header className="splitwise-heading">
        <h1>Import from Splitwise</h1>
        <p>Bring your expenses, payments, and balances into Split from a group export.</p>
      </header>

      <div className="splitwise-start">
        <section className="panel splitwise-upload" aria-labelledby="splitwise-upload-title">
          <h2 id="splitwise-upload-title">Add group exports</h2>
          <p>Review your entries and match people before you import.</p>
          <label
            className="splitwise-dropzone"
            data-dragging={dragging}
            onDragEnter={dragEnter}
            onDragLeave={dragLeave}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = busy || reading ? "none" : "copy";
              }
            }}
            onDrop={drop}
          >
            <input
              className="splitwise-file-input"
              type="file"
              multiple
              accept=".csv,text/csv"
              aria-label="Choose Splitwise CSV files"
              aria-describedby="splitwise-file-help"
              disabled={busy || reading}
              onChange={(e) => {
                void choose(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="splitwise-file-icon" aria-hidden="true">CSV</span>
            <span className="btn btn-primary splitwise-file-button">
              {busy ? "Importing…" : reading ? "Reading files…" : items.length ? "Add CSV files" : "Choose CSV files"}
            </span>
            <span className="splitwise-drop-hint">or drag files here</span>
          </label>
          <p id="splitwise-file-help" className="splitwise-file-help">
            One CSV per group, up to 2 MB each. You can add several at once.
          </p>
          {fileMessage && <p className="splitwise-file-help" role="status">{fileMessage}</p>}
        </section>

        <aside className="splitwise-guide" aria-labelledby="splitwise-guide-title">
          <h2 id="splitwise-guide-title">Get your CSV files</h2>
          <dl>
            <div>
              <dt>On the web</dt>
              <dd>Open your group on Splitwise, select the settings gear, then choose <strong>Export as spreadsheet</strong>.</dd>
            </div>
            <div>
              <dt>In the Splitwise app</dt>
              <dd>Open your group, scroll the buttons under the group name to the right, then tap <strong>Export</strong>.</dd>
            </div>
          </dl>
          <a href="https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data" target="_blank" rel="noreferrer">
            Splitwise export help
          </a>
        </aside>
      </div>

      <span className="splitwise-sr-only" role="status">
        {reading ? "Reading files." : items.length ? `${items.length} ${items.length === 1 ? "file" : "files"} in review.` : ""}
      </span>
      {items.length > 0 && (
        <section className="splitwise-review" aria-labelledby="splitwise-review-title">
          <h2 id="splitwise-review-title">Review files</h2>
          {items.map((i) => (
            <Preview
              key={i.key}
              item={i}
              groups={own}
              user={user}
              busy={busy}
              problem={problem(i)}
              update={(change) => update(i.key, change)}
              remove={() => setItems((old) => old.filter((x) => x.key !== i.key))}
            />
          ))}
        </section>
      )}

      {hasPendingGroups && (
        <div className="splitwise-actions">
          <p>Split saves each group in one import. Reimporting skips entries already in Split.</p>
          <button className="btn btn-primary" disabled={busy || reading || !ready.length} onClick={() => void importAll()}>
            {busy ? "Importing…" : ready.length ? `Import ${ready.length} ${ready.length === 1 ? "group" : "groups"}` : "Import groups"}
          </button>
        </div>
      )}
    </div>
  );
}

function Preview({
  item: i,
  groups,
  user,
  busy,
  problem,
  update,
  remove,
}: {
  item: Pending;
  groups: Group[];
  user: string;
  busy: boolean;
  problem: string | null;
  update: (c: Partial<Pending>) => void;
  remove: () => void;
}) {
  if (!i.parsed) {
    return (
      <article className="panel splitwise-preview">
        <header className="splitwise-preview-header">
          <h3>{i.file}</h3>
          <button className="btn btn-ghost" disabled={busy} onClick={remove}>Remove</button>
        </header>
        <div className="splitwise-preview-body">
          <p className="splitwise-feedback splitwise-error" role="alert">{i.error}</p>
        </div>
      </article>
    );
  }

  const g = i.parsed;
  const target = groups.find((x) => x.id === i.target);
  const mismatches = reconcile(g);
  const totalCurrencies = Object.keys(g.totals).sort();
  const expenses = g.rows.filter((r) => !r.payment).length;
  const payments = g.rows.length - expenses;
  const done = i.status === "done";

  return (
    <article className="panel splitwise-preview" aria-label={"Preview of " + i.file}>
      <header className="splitwise-preview-header">
        <div>
          <h3>{i.target === "new" ? i.name.trim() || "Untitled group" : target?.name ?? i.name}</h3>
          <p>{i.file}</p>
        </div>
        {done ? (
          <Link className="btn" to={"/g/" + i.target}>Open group</Link>
        ) : (
          <button className="btn btn-ghost" disabled={busy} onClick={remove} aria-label={"Remove " + i.file}>
            Remove
          </button>
        )}
      </header>
      <div className="splitwise-preview-body">
        <ul className="splitwise-counts" aria-label="File summary">
          <li><b>{expenses}</b> {expenses === 1 ? "expense" : "expenses"}</li>
          <li><b>{payments}</b> {payments === 1 ? "payment" : "payments"}</li>
          <li><b>{g.members.length}</b> {g.members.length === 1 ? "person" : "people"}</li>
        </ul>
        {i.result && (
          <p className={`splitwise-feedback ${done ? "splitwise-ok" : "splitwise-error"}`} role={done ? "status" : "alert"}>
            {i.result}
          </p>
        )}
        {mismatches.length ? (
          <div className="splitwise-feedback splitwise-warning">
            <strong>Balances differ from the Splitwise export</strong>
            <ul>
              {mismatches.map((m) => (
                <li key={JSON.stringify([m.currency, m.member])}>
                  {m.member}: Splitwise {signed(m.expected, m.currency)}, Split {signed(m.imported, m.currency)}
                </li>
              ))}
            </ul>
            <p>Export a fresh copy from Splitwise and check the balances again.</p>
          </div>
        ) : totalCurrencies.length ? (
          <p className="splitwise-feedback splitwise-ok">
            <span aria-hidden="true">✓</span> Balances match Splitwise to the cent ({totalCurrencies.join(", ")}).
          </p>
        ) : (
          <p className="splitwise-feedback splitwise-warning">
            Balance verification needs a Total balance row in the export.
          </p>
        )}

        <div className="splitwise-review-grid" data-complete={done}>
          {!done && (
            <fieldset className="splitwise-settings" disabled={busy} aria-label="Group settings and people">
              <h4>Group settings</h4>
              <div className="splitwise-fields">
                <label className="field">
                  Import into
                  <select
                    value={i.target}
                    onChange={(e) => {
                      const targetID = e.target.value;
                      update({ target: targetID, mapping: guessMapping(g, groups.find((x) => x.id === targetID), user) });
                    }}
                  >
                    <option value="new">A new group</option>
                    {groups.map((x) => (
                      <option key={x.id} value={x.id}>{x.name} ({x.currency})</option>
                    ))}
                  </select>
                </label>
                {i.target === "new" && (
                  <label className="field">
                    Currency
                    <select value={i.currency} onChange={(e) => update({ currency: e.target.value })}>
                      {currencies.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {i.target === "new" && (
                <label className="field">
                  Group name
                  <input type="text" value={i.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} />
                </label>
              )}

              <div className="splitwise-people">
                <h4>Match people</h4>
                <p className="splitwise-hint">Choose your name and match anyone already in the group.</p>
                {g.members.map((name) => (
                  <div className="splitwise-person" key={name}>
                    <Avatar name={name} size={32} />
                    <div>
                      <strong>{name}</strong>
                      {totalCurrencies.length > 0 && <small>{standing(g.totals, name)}</small>}
                    </div>
                    <select
                      aria-label={"Match " + name}
                      value={i.mapping[name] ?? "new"}
                      onChange={(e) => update({ mapping: { ...i.mapping, [name]: e.target.value } })}
                    >
                      <option value="me">Me</option>
                      {target?.members
                        .filter((m) => m.userID !== user)
                        .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      <option value="new">New placeholder</option>
                    </select>
                  </div>
                ))}
                {problem && <p className="splitwise-feedback splitwise-warning">{problem}</p>}
              </div>
            </fieldset>
          )}

          <section className="splitwise-entries" aria-label="Entry preview">
            <h4>Entries</h4>
            <ul className="splitwise-entry-list">
              {g.rows.slice(0, 5).map((row, index) => <EntryPreview key={index} row={row} />)}
            </ul>
            {g.rows.length > 5 && (
              <details>
                <summary>Show {g.rows.length - 5} more {g.rows.length === 6 ? "entry" : "entries"}</summary>
                <ul className="splitwise-entry-list">
                  {g.rows.slice(5).map((row, index) => <EntryPreview key={index} row={row} />)}
                </ul>
              </details>
            )}
            {g.skipped.length > 0 && (
              <details>
                <summary>{g.skipped.length} {g.skipped.length === 1 ? "row" : "rows"} left out</summary>
                <ul className="splitwise-skipped">
                  {g.skipped.map((message, index) => <li key={index}>{message}</li>)}
                </ul>
              </details>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}

function EntryPreview({ row }: { row: SplitwiseGroup["rows"][number] }) {
  const payers = (row.payers ?? [{ name: row.payer }]).map((payer) => payer.name).join(" & ");
  return (
    <li className="splitwise-entry">
      <CategoryIcon category={row.category} settlement={row.payment} />
      <div>
        <strong>{row.title}</strong>
        <small>{shortDay(row.day)} · {row.payment ? "Payment" : row.category ?? "General"} · {payers} paid</small>
      </div>
      <b>{money(row.amount, row.currency)}</b>
    </li>
  );
}

function signed(amount: number, currency: string) {
  return (amount > 0 ? "+" : amount < 0 ? "−" : "") + money(Math.abs(amount), currency);
}
/** "gets back ARS 112,854.55 · owes USD 120.00" from Splitwise's Total balance rows. */
function standing(totals: Record<string, Record<string, number>>, name: string) {
  const parts = Object.keys(totals)
    .sort()
    .map((c) => [c, totals[c][name] ?? 0] as const)
    .filter(([, v]) => v)
    .map(([c, v]) => (v > 0 ? "gets back " : "owes ") + money(Math.abs(v), c));
  return parts.length ? "In Splitwise: " + parts.join(" · ") : "Settled in Splitwise";
}
function shortDay(day: string) {
  const m = day.match(/^\d{4}-(\d\d)-(\d\d)$/);
  return m ? ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[1]) - 1] + " " + Number(m[2]) : day;
}
