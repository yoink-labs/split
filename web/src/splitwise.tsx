import { Picker } from "./picker";
// Import from Splitwise: pick one or more "Export as spreadsheet" CSVs (one group each),
// preview, map names to people, then import each group atomically.
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import { CategoryIcon } from "./ui";
import { convert, fx, useHomeCurrency, type Quote } from "./fx";
import { money, type Group } from "./data";
import {
  importGroupID,
  parseSplitwise,
  reconcile,
  settledImportRow,
  type ImportRow,
  type SplitwiseGroup,
} from "../../worker/src/splitwiseCsv";
import { ImportAnalytics, ImportInvite, ImportPerson, type PersonDraft } from "./splitwiseReview";
import "./splitwise.css";

interface Pending {
  key: string;
  file: string;
  parsed?: SplitwiseGroup;
  error?: string;
  name: string;
  conversion?: { currency: string; rows?: ImportRow[]; error?: string };
  rateRetry?: number;
  target: "new" | string;
  mapping: Record<string, PersonDraft>;
  importedPeople?: { name: string; memberID: string }[];
  status: "ready" | "importing" | "done" | "failed";
  result?: string;
}
interface Result {
  groupID: string;
  created: boolean;
  inserted: number;
  duplicates: number;
  people: NonNullable<Pending["importedPeople"]>;
}

const norm = (s: string) => s.trim().toLowerCase();

function guessMapping(
  g: SplitwiseGroup,
  target: Group | undefined,
  user: string,
  userName: string,
): Record<string, PersonDraft> {
  const full = norm(userName);
  const first = full.split(" ")[0];
  const members = target?.members.filter((member) => !member.removed) ?? [];
  const mine = members.find((member) => member.userID === user);
  const self = g.members.find((name) => norm(name) === norm(mine?.name ?? ""))
    ?? g.members.find((name) => norm(name) === full)
    ?? g.members.find((name) => norm(name) === first);
  return Object.fromEntries(g.members.map((name) => [
    name,
    { match: name === self ? "me" : members.find((m) => m.userID !== user && norm(m.name) === norm(name))?.id ?? "new" },
  ]));
}

async function prepareRows(rows: ImportRow[], currency: string, cancelled: () => boolean, retry: boolean) {
  const key = (row: ImportRow) => row.currency + "@" + row.day;
  const foreign = [...new Map(rows.filter((row) => row.currency !== currency).map((row) => [key(row), row])).values()];
  const quotes = new Map<string, Quote>();
  for (let index = 0; index < foreign.length; index += 4) {
    if (cancelled()) return [];
    await Promise.all(foreign.slice(index, index + 4).map(async (row) => {
      const quote = await fx.historical(row.currency, currency, row.day, retry);
      if (!quote) throw new Error(`No historical rate from ${row.currency} to ${currency} for ${row.day}.`);
      quotes.set(key(row), quote);
    }));
  }
  return rows.map((row) => {
    if (row.currency === currency) return row;
    const quote = quotes.get(key(row))!;
    if (convert(row.amount, quote.rateE8) > 100_000_000_000) throw new Error(`The estimated amount for “${row.title}” exceeds Split’s limit.`);
    return { ...row, exchange: { target: currency, rateE8: quote.rateE8, source: quote.source, date: quote.date } };
  });
}

export function SplitwiseImport() {
  const { data, user, userName, request, refresh } = useLedger();
  const [home] = useHomeCurrency();
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileMessage, setFileMessage] = useState("");
  const dragDepth = useRef(0);
  const own = data.groups.filter((g) => g.members.some((m) => m.userID === user && !m.removed));

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
            target: "new",
            mapping: guessMapping(parsed, undefined, user, userName),
            status: "ready",
          });
        } catch (e) {
          next.push({ key, file: file.name, error: e instanceof Error ? e.message : "Could not read this file.", name: "", target: "new", mapping: {}, status: "failed" });
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
    const people = Object.values(i.mapping);
    if (i.target === "new" && !people.some((person) => person.match === "me")) return "Choose which Splitwise name is you.";
    const members = own.find((group) => group.id === i.target)?.members;
    const picked = people.flatMap(({ match, account }) => {
      if (match === "new") return [];
      if (match === "account") return account ? ["user:" + account.userID] : [];
      if (match === "me") return ["user:" + user];
      const member = members?.find((m) => m.id === match);
      return [member?.userID ? "user:" + member.userID : match];
    });
    if (new Set(picked).size !== picked.length) return "Two names point to the same person.";
    if (people.some((person) => person.match === "account" && !person.account)) return "Choose a Split account from the search results.";
    if (i.target === "new" && !i.name.trim()) return "Name the group.";
    return null;
  }

  async function importAll() {
    setBusy(true);
    try {
      for (const i of items) {
        if (i.status !== "ready" || !i.parsed || i.conversion?.currency !== home || !i.conversion.rows || problem(i)) continue;
        update(i.key, { status: "importing", result: undefined });
        try {
          const people = i.parsed.members.map((name) => {
            const { match, displayName, account } = i.mapping[name];
            const member = own.find((group) => group.id === i.target)?.members.find((m) => m.id === match);
            const rename = displayName?.trim() || undefined;
            if (match === "me") return { name, me: true, displayName: i.target === "new" ? rename : undefined };
            if (match === "account") return { name, userID: account!.userID };
            if (match === "new") return { name, displayName: rename };
            return { name, memberID: match, displayName: member?.userID ? undefined : rename };
          });
          const body = {
            ...(i.target === "new"
              ? { group: { id: await importGroupID(i.parsed.fingerprint, user), name: i.name.trim(), kind: "trip", currency: home } }
              : { groupID: i.target }),
            settlementCurrency: home,
            people,
            rows: i.conversion.rows,
          };
          const r = await request<Result>("/v1/import/splitwise", body);
          update(i.key, {
            status: "done",
            target: r.groupID,
            importedPeople: r.people,
            result:
              !r.created && r.inserted === 0
                ? "All entries were already in Split."
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

  const ready = items.filter((i) => i.status === "ready" && i.parsed && i.conversion?.currency === home && i.conversion.rows && !problem(i));
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
              userName={userName}
              home={home}
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
  userName,
  home,
  busy,
  problem,
  update,
  remove,
}: {
  item: Pending;
  groups: Group[];
  user: string;
  userName: string;
  home: string;
  busy: boolean;
  problem: string | null;
  update: (c: Partial<Pending>) => void;
  remove: () => void;
}) {
  const mismatches = useMemo(() => i.parsed ? reconcile(i.parsed) : [], [i.parsed]);
  const done = i.status === "done";
  useEffect(() => {
    if (!i.parsed || done) return;
    let cancelled = false;
    void prepareRows(i.parsed.rows, home, () => cancelled, !!i.rateRetry).then(
      (rows) => { if (!cancelled) update({ conversion: { currency: home, rows } }); },
      (error) => { if (!cancelled) update({ conversion: { currency: home, error: error instanceof Error ? error.message : "Historical rates are unavailable." } }); },
    );
    return () => { cancelled = true; };
  }, [i.parsed, home, i.rateRetry, done]);
  const currency = done ? i.conversion?.currency ?? home : home;
  const conversion = i.conversion?.currency === currency ? i.conversion : undefined;
  const settledRows = useMemo(() => conversion?.rows?.map(settledImportRow), [conversion?.rows]);
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
  const checked = g.rows.every((row) => Object.hasOwn(g.totals, row.currency));
  const expenses = g.rows.filter((r) => !r.payment).length;
  const payments = g.rows.length - expenses;

  const memberOptions = target?.members.filter((m) => m.userID !== user && !m.removed) ?? [];
  const mappedName = (source: string) => {
    const person = i.mapping[source];
    const importedID = i.importedPeople?.find((item) => item.name === source)?.memberID;
    const imported = importedID && target?.members.find((member) => member.id === importedID);
    if (imported) return imported.name;
    if (person.match === "me") return person.displayName?.trim() || target?.members.find((m) => m.userID === user)?.name || userName || source;
    if (person.match === "account") return memberOptions.find((member) => member.userID === person.account?.userID)?.name ?? person.account?.name ?? source;
    if (person.match === "new") return person.displayName?.trim() || source;
    const member = memberOptions.find((m) => m.id === person.match);
    return (!member?.userID && person.displayName?.trim()) || member?.name || source;
  };
  const invitees = i.importedPeople?.filter(({ name, memberID }) => {
    const person = i.mapping[name];
    const member = target?.members.find((m) => m.id === memberID);
    return person.email?.trim() && (member ? !member.userID && !member.removed : person.match === "new");
  });

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
          <p className="splitwise-feedback splitwise-warning">Some balances in the source file differ from Splitwise’s totals.</p>
        ) : checked ? (
          <p className="splitwise-feedback splitwise-ok">Source balances match the Splitwise export.</p>
        ) : null}

        <div className="splitwise-review-grid" data-complete={done}>
          {!done && (
            <fieldset className="splitwise-settings" disabled={busy} aria-label="Group settings and people">
              <h4>Group settings</h4>
              <div className="splitwise-fields">
                <label className="field">
                  Import into
                  <Picker label="Import into"
                    value={i.target}
                    onChange={(selected) => {
                      const targetID = selected;
                      const next = guessMapping(g, groups.find((x) => x.id === targetID), user, userName);
                      for (const name of g.members) {
                        const person = i.mapping[name];
                        next[name] = {
                          ...next[name], email: person.email, displayName: person.displayName,
                          ...(person.match === "account" ? { match: person.match, account: person.account } : {}),
                        };
                      }
                      const mine = g.members.find((name) => i.mapping[name].match === "me");
                      if (mine) for (const name of g.members) {
                        if (name === mine) next[name] = { ...next[name], match: "me" };
                        else if (next[name].match === "me") next[name].match = "new";
                      }
                      update({ target: targetID, mapping: next });
                    }} options={[{ value: "new", label: "A new group" }, ...groups.map((group) => ({ value: group.id, label: `${group.name} (${group.currency})` }))]} />
                </label>
              </div>
              {i.target === "new" && (
                <label className="field">
                  Group name
                  <input type="text" value={i.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} />
                </label>
              )}

              <div className="splitwise-people">
                <h4>Match people</h4>
                <p className="splitwise-hint">Claim your history, link a Split account, or prepare an email invite.</p>
                {g.members.map((name) => (
                  <ImportPerson
                    key={JSON.stringify([i.target, name])}
                    source={name}
                    person={i.mapping[name]}
                    members={memberOptions}
                    newGroup={i.target === "new"}
                    update={(person) => {
                      const mapping = { ...i.mapping, [name]: person };
                      if (person.match === "me") {
                        for (const other of g.members) {
                          if (other !== name && mapping[other].match === "me") mapping[other] = { ...mapping[other], match: "new" };
                        }
                      }
                      update({ mapping });
                    }}
                  />
                ))}
                {problem && <p className="splitwise-feedback splitwise-warning">{problem}</p>}
              </div>
            </fieldset>
          )}

          <div className="splitwise-data">
            {done && !!invitees?.length && (
              <section className="splitwise-invites" aria-label="Email invites">
                <h4>Email invites</h4>
                {invitees.map(({ name, memberID }) => (
                  <ImportInvite key={memberID} groupID={i.target} memberID={memberID} name={mappedName(name)} email={i.mapping[name].email!} />
                ))}
              </section>
            )}
            {settledRows ? (
              <ImportAnalytics group={g} rows={settledRows} currency={currency} estimated={conversion?.rows?.some((row) => !!row.exchange) ?? false} mappedName={mappedName} />
            ) : (
              <div className="splitwise-analytics">
                <h4>Analytics preview in {currency}</h4>
                <p role="status" className="splitwise-hint">{conversion?.error ?? "Loading historical exchange rates…"}</p>
                {conversion?.error && <button className="btn btn-sm" disabled={busy} onClick={() => update({ conversion: undefined, rateRetry: (i.rateRetry ?? 0) + 1 })}>Retry exchange rates</button>}
              </div>
            )}
            <section className="splitwise-entries" aria-label="Entry preview">
              <h4>Entries</h4>
              <ul className="splitwise-entry-list">
                {g.rows.slice(0, 5).map((row, index) => <EntryPreview key={index} row={row} converted={settledRows?.[index]} mappedName={mappedName} />)}
              </ul>
              {g.rows.length > 5 && (
                <details>
                  <summary>Show {g.rows.length - 5} more {g.rows.length === 6 ? "entry" : "entries"}</summary>
                  <ul className="splitwise-entry-list">
                    {g.rows.slice(5).map((row, index) => <EntryPreview key={index} row={row} converted={settledRows?.[index + 5]} mappedName={mappedName} />)}
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
      </div>
    </article>
  );
}

function EntryPreview({ row, converted, mappedName }: {
  row: ImportRow;
  converted?: ImportRow;
  mappedName: (name: string) => string;
}) {
  const payers = (row.payers ?? [{ name: row.payer }]).map((payer) => mappedName(payer.name)).join(" & ");
  return (
    <li className="splitwise-entry">
      <CategoryIcon category={row.category} settlement={row.payment} />
      <div>
        <strong>{row.title}</strong>
        <small>{shortDay(row.day)} · {row.payment ? "Payment" : row.category ?? "General"} · {payers} paid</small>
        <small>{row.payment ? "Received by " : "Split between "}{row.splits.map((share) => mappedName(share.name)).join(", ")}</small>
      </div>
      <b>{converted ? (row.currency !== converted.currency ? "≈ " : "") + money(converted.amount, converted.currency) : "—"}</b>
    </li>
  );
}

function shortDay(day: string) {
  const m = day.match(/^\d{4}-(\d\d)-(\d\d)$/);
  return m ? ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[1]) - 1] + " " + Number(m[2]) : day;
}
