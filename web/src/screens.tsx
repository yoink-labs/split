import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Form, useLedger, value } from "./context";
import {
  breakdown,
  currencies,
  dateText,
  entryPath,
  grossItems,
  memberEntries,
  memberName,
  memberPath,
  membersGroups,
  minor,
  money,
  settlementEntry,
  stamp,
  type Expense,
  type Group,
} from "./data";

export function Groups() {
  const { data } = useLedger();
  return (
    <>
      <div className="titlebar">
        <h1>Groups</h1>
        <div className="actions">
          <Link className="secondary" to="/join">
            Join group
          </Link>
          <Link className="primary" to="/new">
            New group
          </Link>
        </div>
      </div>
      {data.groups.length === 0 && (
        <p>
          Create a group or enter an invitation code to start sharing expenses.
        </p>
      )}
      <div className="group-grid">
        {data.groups.map((g) => {
          const entries = data.entries.filter(
            (e) => e.groupID === g.id && e.kind === "expense",
          );
          return (
            <Link className="group-card" key={g.id} to={"/g/" + g.id}>
              <span className="eyebrow">
                {g.kind} · {g.currency}
              </span>
              <h2>{g.name}</h2>
              <span>
                {g.members.length} people · {entries.length} expenses
              </span>
              <span aria-hidden="true" className="arrow">
                ↗
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
export function NewGroup() {
  const { user, save } = useLedger(),
    nav = useNavigate(),
    [id] = useState(() => crypto.randomUUID()),
    [seat] = useState(() => crypto.randomUUID());
  return (
    <>
      <h1>New group</h1>
      <Form
        label="Create group"
        submit={async (f) => {
          await save("/v1/groups", {
            id,
            name: value(f, "name"),
            currency: value(f, "currency"),
            kind: value(f, "kind"),
            members: [
              {
                id: seat,
                name: window.Clerk.user?.fullName || "Split member",
                userID: user,
              },
            ],
          });
          nav("/g/" + id, { replace: true });
        }}
      >
        <label>
          Group name
          <input name="name" maxLength={80} required autoFocus />
        </label>
        <label>
          Type
          <select name="kind">
            <option value="trip">Trip</option>
            <option value="home">Home</option>
            <option value="friend">Friends</option>
          </select>
        </label>
        <label>
          Currency
          <select name="currency">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </Form>
    </>
  );
}
export function Join() {
  const { request, refresh } = useLedger(),
    nav = useNavigate(),
    { code } = useParams();
  return (
    <>
      <h1>Join a group</h1>
      <Form
        label="Join group"
        submit={async (f) => {
          const input = value(f, "code");
          const token =
            input.match(
              /^https:\/\/split-api\.yoinklabs\.dev\/join\/([\w-]+)$/,
            )?.[1] ?? input;
          const r = await request<{ groupID: string }>("/v1/join", { token });
          await refresh();
          nav("/g/" + r.groupID, { replace: true });
        }}
      >
        <label>
          Invitation code or link
          <input
            name="code"
            defaultValue={code}
            required
            autoCapitalize="characters"
          />
        </label>
      </Form>
    </>
  );
}
export function Account() {
  const { data, user } = useLedger(),
    [theme, setTheme] = useState(document.documentElement.dataset.theme);
  const first = data.groups.find((g) =>
    g.members.some((p) => p.userID === user),
  );
  return (
    <>
      <h1>You</h1>
      <section className="panel">
        {first ? (
          <Link
            className="row"
            to={memberPath(
              first,
              first.members.find((p) => p.userID === user)!.id,
            )}
          >
            <strong>{window.Clerk.user?.fullName || "Your profile"}</strong>
            <span>Your charges by group ›</span>
          </Link>
        ) : (
          <p>Join a group to see your charges.</p>
        )}
        <label>
          Appearance
          <select
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value);
              document.documentElement.dataset.theme = e.target.value;
              localStorage.setItem("split-theme", e.target.value);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <button onClick={() => void window.Clerk.signOut()}>Sign out</button>
      </section>
    </>
  );
}
function EntryRow({ e, g, seat }: { e: Expense; g: Group; seat?: string }) {
  const open = e.bill?.items.filter((i) => !i.memberIDs.length).length;
  return (
    <Link className="row" to={entryPath(e)}>
      <div>
        <strong>{e.title}</strong>
        <small>
          {dateText(e.createdAt)} · Paid by {memberName(g, e.paidBy)}
        </small>
        {!!open && <small className="accent">{open} open purchases</small>}
      </div>
      <div className="amount">
        <b>{money(e.amount, e.currency)}</b>
        {seat && e.kind === "expense" && (
          <small>
            Share{" "}
            {money(
              e.splits.find((s) => s.memberID === seat)?.amount ?? 0,
              e.currency,
            )}
          </small>
        )}
      </div>
    </Link>
  );
}
function People({ g }: { g: Group }) {
  const { save, request } = useLedger(),
    [invite, setInvite] = useState(""),
    [matches, setMatches] = useState<{ userID: string; name: string }[]>([]),
    [error, setError] = useState("");
  return (
    <>
      <h2>People</h2>
      <div className="panel">
        {g.members.map((p) => (
          <Link className="row" key={p.id} to={memberPath(g, p.id)}>
            <strong>{p.name}</strong>
            <small>{p.userID ? "Joined" : "Placeholder"} ›</small>
          </Link>
        ))}
      </div>
      <details>
        <summary>Add a person</summary>
        <Form
          label="Add placeholder"
          submit={async (f) => {
            await save("/v1/groups/" + g.id + "/members", {
              id: crypto.randomUUID(),
              name: value(f, "person"),
              email: value(f, "email"),
            });
          }}
        >
          <label>
            Name
            <input name="person" required maxLength={60} />
          </label>
          <label>
            Email (optional)
            <input type="email" name="email" />
          </label>
        </Form>
        <Form
          label="Search Split"
          submit={async (f) => {
            const result = await request<{ userID: string; name: string }[]>(
              "/v1/people/search",
              { query: value(f, "query") },
            );
            setMatches(result);
            setError("");
            if (!result.length) setError("No matches.");
          }}
        >
          <label>
            Exact email, username or shared contact
            <input name="query" required />
          </label>
        </Form>
        {matches.map((p) => (
          <button
            key={p.userID}
            onClick={() => {
              void save("/v1/groups/" + g.id + "/members", {
                id: crypto.randomUUID(),
                ...p,
              })
                .then(() => setMatches([]))
                .catch((e) => setError(e.message));
            }}
          >
            Add {p.name}
          </button>
        ))}
      </details>
      <details>
        <summary>Invite someone</summary>
        <Form
          label="Create invitation"
          submit={async (f) => {
            const memberID = value(f, "member");
            const result = await request<{ url: string; code: string }>(
              "/v1/groups/" + g.id + "/invites",
              memberID ? { memberID } : {},
            );
            setInvite(result.url);
          }}
        >
          <label>
            Invitation for
            <select name="member">
              <option value="">Anyone with the link</option>
              {g.members
                .filter((p) => !p.userID)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        </Form>
        {invite && (
          <label>
            Share this link
            <input readOnly value={invite} onFocus={(e) => e.target.select()} />
          </label>
        )}
      </details>
      {error && <p role="status">{error}</p>}
    </>
  );
}
function Balances({ g, entries }: { g: Group; entries: Expense[] }) {
  const { save } = useLedger(),
    converted = entries.map(settlementEntry);
  const codes = [...new Set([g.currency, ...converted.map((e) => e.currency)])];
  return (
    <>
      {codes.map((currency) => {
        const stats = breakdown(converted, g.members, currency);
        return (
          <section key={currency}>
            <div className="summary">
              <small>Total spent · {currency}</small>
              <h2>{money(stats.total, currency)}</h2>
            </div>
            <h2>Member balances</h2>
            <div className="panel">
              {stats.members.map((p) => (
                <Link className="row" key={p.id} to={memberPath(g, p.id)}>
                  <div>
                    <strong>{p.name}</strong>
                    <small>
                      Paid {money(p.paid, currency)} · Share{" "}
                      {money(p.share, currency)}
                    </small>
                  </div>
                  <b>
                    {p.net
                      ? (p.net > 0 ? "Owed " : "Owes ") +
                        money(Math.abs(p.net), currency)
                      : "All square"}
                  </b>
                </Link>
              ))}
            </div>
            <h2>Settle up</h2>
            {!stats.settlements.length && (
              <p>Everyone is square in {currency}.</p>
            )}
            {stats.settlements.map((t) => (
              <details key={t.from + t.to}>
                <summary>
                  {memberName(g, t.from)} → {memberName(g, t.to)} ·{" "}
                  {money(t.amount, currency)}
                </summary>
                <Form
                  label="Record payment"
                  submit={async (f) => {
                    const amount = minor(value(f, "amount"));
                    if (amount <= 0 || amount > t.amount)
                      throw new Error(
                        "Enter an amount up to the outstanding balance.",
                      );
                    await save("/v1/entries", {
                      id: crypto.randomUUID(),
                      groupID: g.id,
                      title: "Settle-up payment",
                      amount,
                      currency,
                      paidBy: t.from,
                      splits: [{ memberID: t.to, amount }],
                      kind: "settlement",
                      splitMode: "exact",
                      createdAt: stamp(),
                    });
                  }}
                >
                  <label>
                    Amount paid
                    <input
                      name="amount"
                      inputMode="decimal"
                      defaultValue={(t.amount / 100).toFixed(2)}
                      required
                    />
                  </label>
                  <small>Records a payment already made.</small>
                </Form>
              </details>
            ))}
            {Object.entries({
              Category: stats.categories,
              Month: stats.months,
            }).map(([label, buckets]) => (
              <details key={label}>
                <summary>By {label.toLowerCase()}</summary>
                {Object.entries(buckets)
                  .sort()
                  .map(([k, v]) => (
                    <p className="row" key={k}>
                      {k}
                      <b>{money(v, currency)}</b>
                    </p>
                  ))}
              </details>
            ))}
          </section>
        );
      })}
    </>
  );
}
export function GroupScreen() {
  const { data } = useLedger(),
    { gid } = useParams(),
    [query, setQuery] = useSearchParams(),
    [open, setOpen] = useState(false);
  const g = data.groups.find((g) => g.id === gid);
  if (!g) return <p>Group unavailable.</p>;
  const entries = data.entries
      .filter((e) => e.groupID === gid)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      ),
    view = query.get("tab") ?? "expenses";
  return (
    <>
      <p className="eyebrow">
        {g.kind} · {g.currency}
      </p>
      <div className="titlebar">
        <h1>{g.name}</h1>
        <Link className="primary" to={"/g/" + gid + "/new"}>
          Add expense
        </Link>
      </div>
      <div className="tabs">
        {["expenses", "balances", "people"].map((tab) => (
          <button
            key={tab}
            aria-pressed={view === tab}
            onClick={() => setQuery({ tab }, { replace: true })}
          >
            {tab}
          </button>
        ))}
      </div>
      {view === "people" ? (
        <People g={g} />
      ) : view === "balances" ? (
        <Balances g={g} entries={entries} />
      ) : (
        <>
          <h2>Group ledger</h2>
          {(open ||
            entries.some((e) =>
              e.bill?.items.some((i) => !i.memberIDs.length),
            )) && (
            <label className="check">
              <input
                type="checkbox"
                checked={open}
                onChange={(e) => setOpen(e.target.checked)}
              />
              Open purchases only
            </label>
          )}
          {!entries.length && (
            <p>Your first shared expense will appear here.</p>
          )}
          <div className="panel">
            {entries
              .filter(
                (e) => !open || e.bill?.items.some((i) => !i.memberIDs.length),
              )
              .map((e) => (
                <EntryRow key={e.id} e={e} g={g} />
              ))}
          </div>
        </>
      )}
    </>
  );
}
export function MemberScreen() {
  const { data } = useLedger(),
    nav = useNavigate(),
    { gid, mid } = useParams(),
    g = data.groups.find((g) => g.id === gid),
    p = g?.members.find((p) => p.id === mid);
  if (!g || !p) return <p>Member unavailable in this group.</p>;
  const shared = membersGroups(data.groups, g, p),
    entries = memberEntries(data.entries, g.id, p.id);
  return (
    <>
      <p className="eyebrow">{p.userID ? "Group member" : "Placeholder"}</p>
      <div className="titlebar">
        <h1>{p.name}</h1>
        {shared.length > 1 ? (
          <label>
            Group
            <select
              value={g.id}
              onChange={(e) => {
                const s = shared.find((s) => s.group.id === e.target.value)!;
                nav(memberPath(s.group, s.person.id));
              }}
            >
              {shared.map((s) => (
                <option key={s.group.id} value={s.group.id}>
                  {s.group.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Link to={"/g/" + g.id}>{g.name}</Link>
        )}
      </div>
      {["expense", "settlement"].map((kind) => {
        const rows = entries.filter((e) => e.kind === kind);
        if (kind === "settlement" && !rows.length) return null;
        return (
          <section key={kind}>
            <h2>{kind === "expense" ? "Charges" : "Payments"}</h2>
            {!rows.length && <p>No charges in this group yet.</p>}
            <div className="panel">
              {rows.map((e) => (
                <EntryRow key={e.id} e={e} g={g} seat={p.id} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
function Photo({
  entry,
  id,
  index,
}: {
  entry: string;
  id: string;
  index: number;
}) {
  const { request } = useLedger(),
    [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false),
    [attempt, retry] = useState(0),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let alive = true,
      object = "";
    setUrl("");
    setFailed(false);
    request<Blob>("/v1/entries/" + entry + "/receipts/" + id, undefined, true)
      .then((blob) => {
        if (alive) {
          object = URL.createObjectURL(blob);
          setUrl(object);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [request, entry, id, attempt]);
  return (
    <>
      <button
        className="thumb"
        aria-label={"View receipt " + (index + 1)}
        onClick={() => (url ? dialog.current?.showModal() : retry(attempt + 1))}
      >
        {url ? (
          <img src={url} alt="Receipt thumbnail" />
        ) : failed ? (
          "Retry"
        ) : (
          "Loading…"
        )}
      </button>
      <dialog ref={dialog} className="viewer">
        <button onClick={() => dialog.current?.close()}>Close photo</button>
        {url && <img src={url} alt={"Receipt page " + (index + 1)} />}
      </dialog>
    </>
  );
}
function ClaimForm({
  e,
  g,
  item,
}: {
  e: Expense;
  g: Group;
  item?: NonNullable<Expense["bill"]>["items"][number];
}) {
  const { save } = useLedger(),
    [original] = useState(item?.memberIDs ?? []),
    [saved, setSaved] = useState(false);
  return (
    <Form
      label={item ? "Save claims" : "Close receipt"}
      submit={async (f) => {
        const memberIDs = f.getAll("member").map(String);
        if (!item && !memberIDs.length)
          throw new Error("Choose someone to cover open purchases.");
        await save(
          "/v1/entries/" + e.id + "/" + (item ? "claim" : "close"),
          item
            ? { itemID: item.id, original, memberIDs, mergeEdits: true }
            : { memberIDs },
        );
        setSaved(true);
      }}
    >
      {g.members.map((p) => (
        <label className="check" key={p.id}>
          <input
            type="checkbox"
            name="member"
            value={p.id}
            defaultChecked={!item || original.includes(p.id)}
            onChange={() => setSaved(false)}
          />
          {p.name}
        </label>
      ))}
      {saved && <small role="status">Claims saved</small>}
    </Form>
  );
}
export function ExpenseScreen() {
  const { data, user } = useLedger(),
    { gid, eid } = useParams(),
    g = data.groups.find((g) => g.id === gid),
    e = data.entries.find((e) => e.id === eid && e.groupID === gid);
  if (!g || !e) return <p>Entry unavailable.</p>;
  const payer = g.members.find((p) => p.id === e.paidBy),
    bill = e.bill,
    open = bill
      ? grossItems(bill)
          .filter((i) => !i.memberIDs.length)
          .reduce((sum, i) => sum + i.gross, 0)
      : 0;
  return (
    <>
      <p className="eyebrow">
        <Link to={"/g/" + g.id}>{g.name}</Link> ·{" "}
        {e.kind === "expense" ? "Expense" : "Payment"}
      </p>
      <h1>{e.title}</h1>
      <div className="summary">
        <small>
          {dateText(e.createdAt)}
          {e.category && " · " + e.category}
        </small>
        <h2>{money(e.amount, e.currency)}</h2>
        Paid by{" "}
        <Link to={memberPath(g, e.paidBy)}>
          {payer?.name ?? "Group member"}
        </Link>
      </div>
      {!!e.receiptIDs?.length && (
        <section>
          <h2>Receipts</h2>
          {e.receiptIDs.map((id, i) => (
            <Photo key={id} id={id} entry={e.id} index={i} />
          ))}
        </section>
      )}
      {bill && (
        <section>
          <h2>Purchases {bill.closed && <small>Closed</small>}</h2>
          <div className="panel">
            {bill.items.map((i) => (
              <div key={i.id} className="purchase">
                <div className="row">
                  <div>
                    <strong>{i.title}</strong>
                    <small>
                      {i.memberIDs.length
                        ? i.memberIDs.map((id) => memberName(g, id)).join(" + ")
                        : "Open purchase"}
                    </small>
                  </div>
                  <b>{money(i.amount, e.currency)}</b>
                </div>
                {!bill.closed && (
                  <details>
                    <summary>Claim or share {i.title}</summary>
                    <ClaimForm
                      key={i.memberIDs.join(",")}
                      e={e}
                      g={g}
                      item={i}
                    />
                  </details>
                )}
              </div>
            ))}
            {[
              ["Tax", bill.tax],
              ["Tip", bill.tip],
              ["Open total", open],
            ].map(([label, amount]) => (
              <div key={label} className="row">
                <span>{label}</span>
                <b>{money(Number(amount), e.currency)}</b>
              </div>
            ))}
          </div>
          {!bill.closed &&
            (payer?.userID === user || (!payer?.userID && e.editable)) && (
              <details>
                <summary>Close receipt</summary>
                <p>Choose who covers the remaining items.</p>
                <ClaimForm e={e} g={g} />
              </details>
            )}
        </section>
      )}
      <h2>{e.kind === "expense" ? "Split with" : "Paid to"}</h2>
      <div className="panel">
        {e.splits.map((s) => (
          <Link className="row" key={s.memberID} to={memberPath(g, s.memberID)}>
            <strong>{memberName(g, s.memberID)}</strong>
            <b>{money(s.amount, e.currency)} ›</b>
          </Link>
        ))}
      </div>
    </>
  );
}
