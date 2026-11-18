// Import from Splitwise: pick one or more "Export as spreadsheet" CSVs (one group each),
// preview, map names to people, then import each group atomically.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLedger } from "./context";
import { currencies, money, type Group } from "./data";
import {
  importGroupID,
  mainCurrency,
  parseSplitwise,
  reconcile,
  type SplitwiseGroup,
} from "../../worker/src/splitwiseCsv";

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
  const own = data.groups.filter((g) => g.members.some((m) => m.userID === user));

  async function choose(files: FileList | null) {
    if (!files?.length) return;
    const next: Pending[] = [];
    for (const file of Array.from(files)) {
      const key = file.name + ":" + file.size + ":" + file.lastModified;
      if (file.size > 2_000_000) {
        next.push({ key, file: file.name, error: "Choose a file under 2 MB.", name: "", currency: "USD", target: "new", mapping: {}, status: "failed" });
        continue;
      }
      try {
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
  return (
    <>
      <p className="eyebrow">Free · no Splitwise account link needed</p>
      <h1>Import from Splitwise</h1>
      <section className="panel steps">
        <h2>Export from Splitwise</h2>
        <ol>
          <li>
            On <b>splitwise.com</b>, open the group, select the <b>settings gear</b>, then{" "}
            <b>Export as spreadsheet</b>.
          </li>
          <li>
            In the Splitwise app, open the group, scroll the buttons under the group name to the
            right, then tap <b>Export</b>.
          </li>
          <li>Repeat for each group. Choose all the CSV files here at once; each becomes a group.</li>
        </ol>
        <small>
          Files in any language work. Split checks the imported balances against Splitwise’s
          Total balance row. Steps from{" "}
          <a href="https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data" target="_blank" rel="noreferrer">
            Splitwise Help
          </a>
          .
        </small>
        <label className="file-pick">
          <span className="primary">Choose Splitwise CSV files</span>
          <input
            type="file"
            multiple
            accept=".csv,text/csv"
            onChange={(e) => {
              void choose(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </section>

      {items.map((i) => (
        <Preview key={i.key} item={i} groups={own} user={user} problem={problem(i)} update={(c) => update(i.key, c)} remove={() => setItems(items.filter((x) => x.key !== i.key))} />
      ))}

      {items.some((i) => i.parsed) && (
        <div className="import-bar">
          <button className="primary" disabled={busy || !ready.length} onClick={() => void importAll()}>
            {busy ? "Importing…" : `Import ${ready.length} ${ready.length === 1 ? "group" : "groups"}`}
          </button>
          <small>Each group imports all at once or not at all. Importing the same file again adds nothing.</small>
        </div>
      )}
    </>
  );
}

function Preview({
  item: i,
  groups,
  user,
  problem,
  update,
  remove,
}: {
  item: Pending;
  groups: Group[];
  user: string;
  problem: string | null;
  update: (c: Partial<Pending>) => void;
  remove: () => void;
}) {
  if (!i.parsed)
    return (
      <section className="panel import-card">
        <div className="row">
          <strong>{i.file}</strong>
          <button className="link" onClick={remove}>Remove</button>
        </div>
        <p className="error">{i.error}</p>
      </section>
    );
  const g = i.parsed;
  const target = groups.find((x) => x.id === i.target);
  const mismatches = reconcile(g);
  const expenses = g.rows.filter((r) => !r.payment).length;
  const done = i.status === "done";
  return (
    <section className="panel import-card" aria-label={"Preview of " + i.file}>
      <div className="row">
        <div>
          <strong>{i.target === "new" ? i.name || g.name : target?.name}</strong>
          <small>
            {i.file} · {expenses} {expenses === 1 ? "expense" : "expenses"} · {g.rows.length - expenses}{" "}
            {g.rows.length - expenses === 1 ? "payment" : "payments"} · {g.members.length} people
          </small>
        </div>
        {!done && <button className="link" onClick={remove}>Remove</button>}
      </div>
      {mismatches.length ? (
        <div className="notice warn" role="alert">
          <strong>Doesn’t match Splitwise’s Total balance</strong>
          {mismatches.map((m) => (
            <small key={m.currency + m.member}>
              {m.member}: Splitwise {money(m.expected, m.currency)}, imported {money(m.imported, m.currency)}
            </small>
          ))}
          <small>Check the file wasn’t edited, then export it again from Splitwise.</small>
        </div>
      ) : Object.keys(g.totals).length ? (
        <p className="notice ok">✓ Matches Splitwise’s Total balance to the cent ({Object.keys(g.totals).sort().join(", ")}).</p>
      ) : (
        <p className="notice warn">This file has no Total balance row, so the balances can’t be checked.</p>
      )}
      {!done && (
        <fieldset disabled={i.status === "importing"}>
          <div className="columns">
            <label>
              Import into
              <select
                value={i.target}
                onChange={(e) => {
                  const t = e.target.value;
                  update({ target: t, mapping: guessMapping(g, groups.find((x) => x.id === t), user) });
                }}
              >
                <option value="new">A new group</option>
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.currency})
                  </option>
                ))}
              </select>
            </label>
            {i.target === "new" ? (
              <label>
                Currency
                <select value={i.currency} onChange={(e) => update({ currency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span />
            )}
          </div>
          {i.target === "new" && (
            <label>
              Group name
              <input value={i.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} />
            </label>
          )}
          <h2>People</h2>
          {g.members.map((name) => (
            <label className="row map" key={name}>
              <span>{name}</span>
              <select
                value={i.mapping[name] ?? "new"}
                onChange={(e) => update({ mapping: { ...i.mapping, [name]: e.target.value } })}
              >
                <option value="me">Me</option>
                {target?.members
                  .filter((m) => m.userID !== user)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                <option value="new">New placeholder</option>
              </select>
            </label>
          ))}
          {problem && <p className="error">{problem}</p>}
        </fieldset>
      )}
      <details>
        <summary>First entries</summary>
        {g.rows.slice(0, 6).map((r, n) => (
          <p className="row" key={n}>
            <span>
              {r.title}
              <small>
                {r.day} · {r.payment ? "payment" : r.category ?? "expense"} · {r.payer} paid
              </small>
            </span>
            <b>{money(r.amount, r.currency)}</b>
          </p>
        ))}
      </details>
      {g.skipped.length > 0 && (
        <details>
          <summary>{g.skipped.length} left out</summary>
          {g.skipped.map((s) => (
            <small key={s}>{s}</small>
          ))}
        </details>
      )}
      {i.result && <p className={done ? "notice ok" : "error"}>{i.result}</p>}
      {done && (
        <Link className="secondary" to={"/g/" + i.target}>
          Open group
        </Link>
      )}
    </section>
  );
}
