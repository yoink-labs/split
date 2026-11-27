import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { breakdown, memberPath, type ActiveInvite, type Expense, type Group, type Person } from "./data";
import { rateE8, rateInput, rateText } from "./fx";
import { CurrencySelect } from "./fxui";
import { memberBalances, useHomeMoney } from "./homeMoney";
import { PaymentEditor } from "./paymentMethods";
import { Avatar, BalanceBadge } from "./ui";

function SettingsCard({ id, title, description, children }: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="card settings-card" id={id} aria-labelledby={id + "-title"}>
      <header>
        <h3 id={id + "-title"}>{title}</h3>
        {description && <p className="muted">{description}</p>}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function TripRates({ group, canEdit }: { group: Group; canEdit: boolean }) {
  const { save } = useLedger();
  const [currency, setCurrency] = useState(() => Object.keys(group.tripRates ?? {})[0] ?? (group.currency === "USD" ? "EUR" : "USD"));
  const rates = Object.entries(group.tripRates ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const current = group.tripRates?.[currency];

  return (
    <SettingsCard
      id="exchange-rates" title="Exchange rates"
      description={`Set default rates into ${group.currency} for new expenses. Saved expenses keep the rate they used.`}
    >
      {canEdit && (
        <Form
          key={currency + "|" + (current ?? "")}
          label="Save trip rate"
          submit={async (form) => {
            const input = value(form, "rate");
            const rate = rateE8(input);
            if (input && !rate) throw new Error("Enter a positive exchange rate.");
            await save(`/v1/groups/${group.id}/trip-rate`, { currency, target: group.currency, rateE8: rate });
          }}
        >
          <div className="settings-rate-fields">
            <CurrencySelect label="Expense currency" value={currency} onChange={setCurrency} exclude={group.currency} />
            <label className="field">
              {group.currency} per 1 {currency}
              <input type="text" name="rate" inputMode="decimal"
                defaultValue={current ? rateInput(current) : ""} />
              <small>Clear the rate and save to use published rates again.</small>
            </label>
          </div>
        </Form>
      )}
      {rates.length === 0 ? <p className="muted">No custom rates saved.</p> : (
        <ul className="trip-rate-list">
          {rates.map(([code, rate]) => (
            <li key={code} className="num">
              {canEdit ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCurrency(code)} aria-label={`Edit ${code} trip rate`}>
                1 {code} = {rateText(rate)} {group.currency}
              </button> : <>1 {code} = {rateText(rate)} {group.currency}</>}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

export function GroupSettings({ g, entries, showRates }: { g: Group; entries: Expense[]; showRates: boolean }) {
  const { data, user, request, save } = useLedger();
  const navigate = useNavigate();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const homeMoney = useHomeMoney();
  const me = g.members.find((m) => m.userID === user);
  const projected = entries.map(homeMoney.project);
  const missingSpend = projected.some((e, index) => !e && entries[index].kind === "expense");
  const foreignSpend = entries.some((e) => e.kind === "expense" && e.currency !== homeMoney.home);
  const spending = breakdown(projected.filter((e): e is Expense => e !== null), g.members, homeMoney.home);
  const spendText = (amount: number) => missingSpend ? "Rate unavailable" : homeMoney.format(amount, foreignSpend);

  const [invites, setInvites] = useState<ActiveInvite[]>([]);
  const [newInviteURL, setNewInviteURL] = useState("");
  const [memberModal, setMemberModal] = useState<Person | null>(null);
  const [memberErr, setMemberErr] = useState("");
  const [matches, setMatches] = useState<{ userID: string; name: string }[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    request<{ invites: ActiveInvite[] }>(`/v1/groups/${g.id}/invites`)
      .then((res) => {
        if (alive) setInvites(res.invites ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [g.id, request]);

  useEffect(() => {
    if (showRates) document.getElementById("exchange-rates")?.scrollIntoView();
  }, [showRates]);

  return (
    <section className="group-settings" aria-labelledby="group-settings-title">
      <header className="workspace-section-head">
        <h2 id="group-settings-title">Settings</h2>
        <p className="muted">Manage this group and how you settle up.</p>
      </header>
      <nav className="settings-links" aria-label="Settings sections">
        <a href="#group-details">Group details</a>
        {g.kind === "trip" && <a href="#exchange-rates">Exchange rates</a>}
        <a href="#group-members">Members</a>
        <a href="#add-person">Add a person</a>
        <a href="#group-invites">Invites</a>
        {me && !me.removed && <a href="#payment-handles">Payment methods</a>}
        {g.canDelete && <a href="#delete-group">Delete group</a>}
      </nav>
      <div className="settings-grid">
        <SettingsCard id="group-details" title="Group details" description="Edit the name, description, and dates.">
          <Form
            label="Save group details"
            submit={async (f) => {
              await save(`/v1/groups/${g.id}/update`, {
                name: value(f, "name"),
                description: value(f, "description"),
                startDate: value(f, "startDate") || null,
                endDate: value(f, "endDate") || null,
              });
              setSettingsSaved(true);
              setTimeout(() => setSettingsSaved(false), 2000);
            }}
          >
            <label className="field">
              Name
              <input type="text" name="name" defaultValue={g.name} required maxLength={80} />
            </label>
            <label className="field">
              Description
              <textarea name="description" defaultValue={g.description ?? ""} maxLength={400} placeholder="Notes about this trip or household…" />
            </label>
            <div className="form-row">
              <label className="field">
                Start date
                <input type="date" name="startDate" defaultValue={g.startDate ?? ""} />
              </label>
              <label className="field">
                End date
                <input type="date" name="endDate" defaultValue={g.endDate ?? ""} />
              </label>
            </div>
            {settingsSaved && <p className="ok-banner">Saved group details</p>}
          </Form>
        </SettingsCard>
        {g.kind === "trip" && <TripRates group={g} canEdit={!!me && !me.removed} />}
        <SettingsCard id="group-members" title={`Members (${g.members.filter((m) => !m.removed).length} active)`} description="Select a member to see their full breakdown.">
          <div className="settings-members">
            {g.members.map((m) => {
              const st = spending.members.find((x) => x.id === m.id);
              const amounts = memberBalances(entries, m.id);
              const net = homeMoney.total(amounts);
              const isMe = m.userID === user;
              return (
                <div className="settings-member" key={m.id}>
                  <Link
                    to={memberPath(g, m.id)}
                    className="settings-member-link"
                  >
                    <Avatar name={m.name} avatarURL={m.avatarURL} size={36} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong>{m.name}</strong>
                        {isMe && <span className="tag tag-primary">You</span>}
                        {!m.userID && <span className="tag">Placeholder</span>}
                        {m.removed && <span className="tag tag-warn">Archived entity</span>}
                      </div>
                      <div className="muted num" style={{ fontSize: 12 }}>
                        Paid {spendText(st?.paid ?? 0)} · Share {spendText(st?.share ?? 0)}
                      </div>
                    </div>
                  </Link>
                  <div className="settings-member-actions">
                    <BalanceBadge amount={net.amount} currency={homeMoney.home} display={Object.values(amounts).some(Boolean) ? homeMoney.totalText(amounts, true) : undefined} />
                    {!isMe && (
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => {
                          setMemberErr("");
                          setMemberModal(m);
                        }}
                      >
                        {m.removed ? "Restore" : "Remove"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsCard>
        <SettingsCard id="add-person" title="Add a person" description="Add a placeholder or find someone on Split.">
          <Form
            label="Add placeholder"
            submit={async (f) => {
              await save(`/v1/groups/${g.id}/members`, {
                id: crypto.randomUUID(),
                name: value(f, "person"),
                email: value(f, "email"),
              });
            }}
          >
            <label className="field">
              Name
              <input type="text" name="person" required maxLength={60} placeholder="Name" />
            </label>
            <label className="field">
              Email (optional)
              <input type="email" name="email" placeholder="name@example.com" />
            </label>
          </Form>
          <Form
            label="Search Split"
            submit={async (f) => {
              setSearchError("");
              setMatches(await request<{ userID: string; name: string }[]>("/v1/people/search", { query: value(f, "query") }));
            }}
          >
            <label className="field">
              Exact email, username, or shared contact
              <input name="query" required maxLength={254} />
            </label>
          </Form>
          {matches?.length === 0 && <p className="muted">No matches.</p>}
          {searchError && <p className="error-banner" role="alert">{searchError}</p>}
          {matches?.map((person) => (
            <button
              className="btn"
              type="button"
              key={person.userID}
              disabled={g.members.some((m) => m.userID === person.userID)}
              onClick={async () => {
                setSearchError("");
                try {
                  await save(`/v1/groups/${g.id}/members`, { id: crypto.randomUUID(), ...person });
                  setMatches(null);
                } catch (error) {
                  setSearchError(error instanceof Error ? error.message : "Could not add this person.");
                }
              }}
            >
              Add {person.name}
            </button>
          ))}
        </SettingsCard>
        <SettingsCard id="group-invites" title={`Invites (${invites.length} active)`} description="Create a link for the group or for a specific placeholder.">
          <Form
            label="Create invite link"
            submit={async (f) => {
              const memberID = value(f, "member");
              const res = await request<{ url: string; code: string }>(`/v1/groups/${g.id}/invites`, memberID ? { memberID } : {});
              setNewInviteURL(res.url);
              const refreshed = await request<{ invites: ActiveInvite[] }>(`/v1/groups/${g.id}/invites`);
              setInvites(refreshed.invites ?? []);
            }}
          >
            <label className="field">
              Invite target
              <select name="member">
                <option value="">General group link (anyone)</option>
                {g.members.filter((m) => !m.userID && !m.removed).map((m) => (
                  <option key={m.id} value={m.id}>
                    Claim placeholder: {m.name}
                  </option>
                ))}
              </select>
            </label>
          </Form>

          {newInviteURL && (
            <div className="settings-invite-url">
              <input type="text" readOnly value={newInviteURL} className="mono" aria-label="Invite link" />
              <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(newInviteURL)}>
                Copy
              </button>
            </div>
          )}

          {invites.length > 0 && (
            <div className="panel" style={{ marginTop: 14 }}>
              {invites.map((inv) => (
                <div className="row" key={inv.id} style={{ padding: "8px 12px" }}>
                  <div>
                    <strong style={{ fontSize: 12.5 }}>
                      {inv.kind === "member" ? `For ${inv.memberName}` : "General group invite"}
                    </strong>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    onClick={async () => {
                      await request(`/v1/groups/${g.id}/invites/${inv.id}/revoke`, {});
                      setInvites((list) => list.filter((x) => x.id !== inv.id));
                    }}
                  >
                    Delete invite
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
        {me && !me.removed && (
          <SettingsCard id="payment-handles" title="Your payment methods">
            <PaymentEditor initial={me.paymentOverride} defaults={data.paymentMethods ?? []}
              save={(methods) => save(`/v1/groups/${g.id}/payment-profile`, { methods })} />
          </SettingsCard>
        )}
        {g.canDelete && (
          <SettingsCard id="delete-group" title="Delete group"
            description="Permanently remove the group, its expenses, receipts, and payments for everyone.">
            <div>
              <button className="btn btn-danger" type="button" onClick={() => deleteDialog.current?.showModal()}>
                Delete group
              </button>
            </div>
            <dialog ref={deleteDialog} className="modal group-delete-dialog" aria-labelledby="delete-group-confirmation">
              <Form label="Delete group" destructive cancel={() => deleteDialog.current?.close()} submit={async () => {
                await save(`/v1/groups/${g.id}/delete`, {});
                navigate("/", { replace: true });
              }}>
                <h2 id="delete-group-confirmation">Delete {g.name}?</h2>
                <p>This permanently removes the group, its expenses, receipts, and payments for everyone.</p>
              </Form>
            </dialog>
          </SettingsCard>
        )}
      </div>

      {/* Member Remove / Retain as Entity Modal */}
      {memberModal && (
        <div className="modal-backdrop" onClick={() => setMemberModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
              {memberModal.removed ? `Restore ${memberModal.name}` : `Remove ${memberModal.name}`}
            </h3>
            {memberModal.removed ? (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
                  {memberModal.name} is currently retained as a historical entity. Restoring them adds them back to new expense defaults.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => setMemberModal(null)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "restore" });
                      setMemberModal(null);
                    }}
                  >
                    Restore member
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
                  Choose whether to <strong>retain {memberModal.name} as an archived entity</strong> (keeps past charges and balances intact, hides them from new splits) or <strong>permanently delete</strong> them (if they cancelled before any expenses).
                </p>
                {memberErr && <p className="error-banner" style={{ marginBottom: 12 }}>{memberErr}</p>}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "archive" });
                      setMemberModal(null);
                    }}
                  >
                    Retain as archived entity (keep history)
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      try {
                        setMemberErr("");
                        await save(`/v1/groups/${g.id}/members/${memberModal.id}/remove`, { mode: "delete" });
                        setMemberModal(null);
                      } catch (e) {
                        setMemberErr(e instanceof Error ? e.message : "Could not delete member.");
                      }
                    }}
                  >
                    Delete permanently (only if 0 expenses)
                  </button>
                  <button className="btn btn-ghost" onClick={() => setMemberModal(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </section>
  );
}
