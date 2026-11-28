import { Picker } from "./picker";
import { useEffect, useState } from "react";
import { Form, useLedger, value } from "./context";
import { entryPayers, minor, moneyCompact, type Expense, type Group } from "./data";
import { canCombineExpense, type CombinationEvent, type CombinationSuggestion } from "../../worker/src/combinationMath";

export function ExpenseCombinations({ group, entries, onInspect }: {
  group: Group;
  entries: Expense[];
  onInspect: (id: string) => void;
}) {
  const { request, refresh } = useLedger();
  const [open, setOpen] = useState(false);
  const [selected, select] = useState<string[]>([]);
  const [mode, setMode] = useState("equal");
  const [suggestions, setSuggestions] = useState<CombinationSuggestion[]>([]);
  const [events, setEvents] = useState<CombinationEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = "/v1/groups/" + group.id;
  const active = group.members.filter((member) => !member.removed);
  const eligible = entries.filter((entry) => canCombineExpense(entry, entries));
  const chosen = eligible.filter((entry) => selected.includes(entry.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const first = chosen[0];
  const total = chosen.reduce((sum, entry) => sum + entry.amount, 0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      request<{ suggestions: CombinationSuggestion[] }>(path + "/combine-suggestions"),
      request<{ events: CombinationEvent[] }>(path + "/combine-activity"),
    ]).then(([matches, history]) => {
      if (alive) { setSuggestions(matches.suggestions); setEvents(history.events); }
    }).catch((cause: Error) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [path, request, entries]);

  function partAmount(raw: string) {
    if (mode === "equal") return 1;
    if (mode !== "adjustment") return minor(raw || "0");
    return raw.startsWith("-") ? -minor(raw.slice(1)) : minor(raw.replace(/^\+/, "") || "0");
  }

  async function combine(entryIDs: string[], options: Record<string, unknown> = {}) {
    const result = await request<{ entryID: string }>(path + "/combine", { entryIDs, ...options });
    await refresh();
    select([]);
    setOpen(false);
    onInspect(result.entryID);
  }

  async function accept(suggestion: CombinationSuggestion) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await combine(suggestion.entryIDs); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="card card-pad form-stack expense-combinations" aria-label="Combine expenses">
    <div className="workspace-section-head">
      <h3>Combine expenses</h3>
      <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close selection" : "Select expenses"}
      </button>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {suggestions.map((suggestion) => (
      <div className="row" key={suggestion.entryIDs.join(",")}>
        <div><strong>{suggestion.title}</strong><p className="muted">{suggestion.entryIDs.length} matching rides · split equally among {active.length} group members</p></div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void accept(suggestion)}>Combine rides</button>
      </div>
    ))}
    {open && <Form label={first ? `Combine ${moneyCompact(total, first.currency)}` : "Combine"} submit={async (form) => {
      if (chosen.length < 2) throw new Error("Choose at least two expenses.");
      const parts = active.filter((m) => form.has("member-" + m.id)).map((m) => ({
        memberID: m.id, amount: partAmount(value(form, "value-" + m.id)),
      }));
      await combine(chosen.map((entry) => entry.id), { title: value(form, "title") || undefined, splitMode: mode, parts });
    }}>
      <fieldset className="combination-entries">
        <legend>Choose expenses in one currency</legend>
        {eligible.map((entry) => <label className="row" key={entry.id}>
          <span><input type="checkbox" checked={selected.includes(entry.id)} disabled={!!first && first.currency !== entry.currency}
            onChange={(e) => select(e.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} /> {entry.title} · {entry.createdAt.slice(0, 10)} · {entryPayers(entry).map((payer) => group.members.find((m) => m.id === payer.memberID)?.name ?? "Group member").join(", ")}</span>
          <span>{moneyCompact(entry.amount, entry.currency)}</span>
        </label>)}
        {!eligible.length && <p className="muted">No available expenses in this group.</p>}
      </fieldset>
      <label>Combined description <input type="text" name="title" maxLength={120} placeholder={first?.title} /></label>
      <label>Split method <Picker label="Split method" value={mode} onChange={setMode} options={[{ value: "equal", label: "Equally" }, { value: "exact", label: "Exact amounts" }, { value: "percent", label: "Percentages" }, { value: "shares", label: "Shares" }, { value: "adjustment", label: "Equal + adjustments" }]} /></label>
      <fieldset>
        <legend>Split among</legend>
        {active.map((member) => <div className="row" key={member.id}>
          <label><input name={"member-" + member.id} type="checkbox" defaultChecked /> {member.name}</label>
          {mode !== "equal" && <input type="text" name={"value-" + member.id} inputMode="decimal"
            aria-label={`${mode === "exact" ? "Amount" : mode === "percent" ? "Percentage" : mode === "adjustment" ? "Adjustment" : "Shares"} for ${member.name}`}
            defaultValue={mode === "shares" ? "1" : ""} key={mode} />}
        </div>)}
      </fieldset>
      <p className="muted">Paid amounts and receipt photos carry over. Item claims return when the originals are restored.</p>
    </Form>}
    {events.length > 0 && <details>
      <summary>Combination activity</summary>
      <ul>{events.map((event) => <li key={event.entryID + event.action}>
        {event.action === "combine" ? `Combined ${event.count} expenses` : `Restored ${event.count} expenses`} · {event.title} · {group.members.find((m) => m.userID === event.actor)?.name ?? "Group member"} · {new Date(event.at).toLocaleDateString()}
      </li>)}</ul>
    </details>}
  </section>;
}
