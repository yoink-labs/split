import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import {
  allocate,
  currencies,
  itemSplit,
  minor,
  receiptPhoto,
  stamp,
  type Group,
} from "./data";
import type { Bill } from "../../worker/src/items";

export function ExpenseForm() {
  const { gid } = useParams(),
    { data } = useLedger(),
    g = data.groups.find((g) => g.id === gid);
  return g ? <Composer key={g.id} g={g} /> : <p>Group unavailable.</p>;
}
function Composer({ g }: { g: Group }) {
  const { save, user } = useLedger(),
    nav = useNavigate(),
    [id] = useState(() => crypto.randomUUID()),
    [createdAt] = useState(stamp);
  const weights = g.defaultWeights ?? {},
    hasDefaults = Object.values(weights).some((w) => w > 0);
  const [mode, setMode] = useState(hasDefaults ? "shares" : "equal");
  const [selected, setSelected] = useState(
    g.members
      .filter((p) => !hasDefaults || (weights[p.id] ?? 0) > 0)
      .map((p) => p.id),
  );
  const photosByFile = useRef(
    new WeakMap<File, Promise<{ id: string; data: string }>>(),
  );
  const [rows, setRows] = useState<string[]>([crypto.randomUUID()]);
  const [currency, setCurrency] = useState(g.currency);
  return (
    <>
      <p className="eyebrow">{g.name}</p>
      <h1>Add expense</h1>
      <Form
        label="Save expense"
        submit={async (f) => {
          const files = (f.getAll("photos") as File[]).filter(
            (file) => file.size,
          );
          if (files.length > 4) throw new Error("Choose up to four photos.");
          const photos = await Promise.all(
            files.map((file) => {
              let photo = photosByFile.current.get(file);
              if (!photo) {
                photo = receiptPhoto(file).catch((error) => {
                  photosByFile.current.delete(file);
                  throw error;
                });
                photosByFile.current.set(file, photo);
              }
              return photo;
            }),
          );
          const paidBy = value(f, "payer");
          let bill: Bill | undefined;
          if (mode === "items") {
            bill = {
              closed: false,
              tax: minor(value(f, "tax") || "0"),
              tip: minor(value(f, "tip") || "0"),
              items: rows.map((id) => ({
                id,
                title: value(f, "name-" + id),
                amount: minor(value(f, "price-" + id)),
                memberIDs: f.getAll("claims-" + id).map(String),
              })),
            };
          }
          const amount = bill
            ? bill.items.reduce((sum, i) => sum + i.amount, bill.tax + bill.tip)
            : minor(value(f, "amount"));
          if (amount <= 0) throw new Error("The total must be positive.");
          const inputs =
            mode === "equal"
              ? selected.map(() => 1)
              : bill
                ? []
                : selected.map((id) => minor(value(f, "weight-" + id) || "0"));
          if (mode === "exact" && inputs.reduce((a, b) => a + b, 0) !== amount)
            throw new Error("Individual amounts must add up to the total.");
          if (mode === "percent" && inputs.reduce((a, b) => a + b, 0) !== 10000)
            throw new Error("Percentages must add up to 100%.");
          const portions = bill
            ? []
            : mode === "exact"
              ? inputs
              : allocate(amount, inputs);
          const splits = bill
            ? itemSplit(bill, paidBy)
            : selected.map((memberID, i) => ({
                memberID,
                amount: portions[i],
              }));
          const category = value(f, "category");
          await save("/v1/entries", {
            id,
            groupID: g.id,
            title: value(f, "title"),
            amount,
            currency,
            paidBy,
            splits,
            splitMode: bill ? "exact" : mode,
            kind: "expense",
            createdAt,
            ...(category ? { category } : {}),
            ...(bill ? { bill } : {}),
            ...(photos.length ? { photos } : {}),
          });
          nav("/g/" + g.id + "/e/" + id, { replace: true });
        }}
      >
        <div className="columns">
          <label>
            Description
            <input
              required
              name="title"
              maxLength={120}
              placeholder="Dinner, groceries, tickets…"
              autoFocus
            />
          </label>
          <label>
            Paid by
            <select
              name="payer"
              defaultValue={g.members.find((p) => p.userID === user)?.id}
            >
              {g.members.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="columns">
          <label>
            Currency
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Category (optional)
            <input name="category" maxLength={50} />
          </label>
        </div>
        <label>
          Split method
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {[
              ["equal", "Equally"],
              ["exact", "Exact amounts"],
              ["percent", "Percentages"],
              ["shares", "Shares"],
              ["items", "Receipt items"],
            ].map(([v, label]) => (
              <option value={v} key={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {mode === "items" ? (
          <>
            <h2>Receipt items</h2>
            {rows.map((id, i) => (
              <div className="item-editor" key={id}>
                <div className="columns">
                  <label>
                    Item {i + 1}
                    <input name={"name-" + id} required maxLength={100} />
                  </label>
                  <label>
                    Price
                    <input name={"price-" + id} required inputMode="decimal" />
                  </label>
                </div>
                <details>
                  <summary>Who claimed this item?</summary>
                  {g.members.map((p) => (
                    <label className="check" key={p.id}>
                      <input
                        type="checkbox"
                        name={"claims-" + id}
                        value={p.id}
                      />
                      {p.name}
                    </label>
                  ))}
                </details>
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((r) => r !== id))}
                  >
                    Remove item
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              disabled={rows.length >= 50}
              onClick={() => setRows([...rows, crypto.randomUUID()])}
            >
              Add line item
            </button>
            <div className="columns">
              <label>
                Tax
                <input name="tax" inputMode="decimal" placeholder="0.00" />
              </label>
              <label>
                Tip
                <input name="tip" inputMode="decimal" placeholder="0.00" />
              </label>
            </div>
            <small>
              Tax and tip follow the item prices. Unclaimed items stay with the
              payer.
            </small>
          </>
        ) : (
          <>
            <label>
              Amount ({currency})
              <input
                name="amount"
                required
                inputMode="decimal"
                placeholder="0.00"
              />
            </label>
            <h2>Split with</h2>
            {g.members.map((p) => (
              <div className="row" key={p.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.name}
                </label>
                {mode !== "equal" && selected.includes(p.id) && (
                  <input
                    key={mode}
                    aria-label={p.name + " " + mode}
                    name={"weight-" + p.id}
                    inputMode="decimal"
                    defaultValue={mode === "shares" ? (weights[p.id] ?? 1) : ""}
                    required
                  />
                )}
              </div>
            ))}
          </>
        )}
        <label>
          Receipt photos (up to four)
          <input type="file" name="photos" accept="image/*" multiple />
        </label>
      </Form>
    </>
  );
}
