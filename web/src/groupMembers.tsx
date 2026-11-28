import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { breakdown, memberPath, type ActiveInvite, type DirectoryPerson, type Expense, type Group, type Person } from "./data";
import { SettingsCard } from "./groupSettings";
import { memberBalances, useHomeMoney } from "./homeMoney";
import { Avatar, BalanceBadge } from "./ui";

type ClaimEmail = { memberID: string; email: string };

export function GroupMembers({ group, entries }: { group: Group; entries: Expense[] }) {
  const { request, save, user, demo, data } = useLedger();
  const homeMoney = useHomeMoney();
  const path = `/v1/groups/${group.id}`;
  const canManage = group.members.some((person) => person.userID === user && !person.removed);
  const [directory, setDirectory] = useState<{ claimEmails: ClaimEmail[]; invites: ActiveInvite[] }>();
  const [newLink, setNewLink] = useState<{ id: string; url: string }>();
  const [selectedID, setSelectedID] = useState<string>();
  const selected = group.members.find((person) => person.id === selectedID);
  const [matches, setMatches] = useState<DirectoryPerson[]>();
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const loadVersion = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const [members, invites] = await Promise.all([
        request<{ claimEmails: ClaimEmail[] }>(`${path}/members`),
        request<{ invites: ActiveInvite[] }>(`${path}/invites`),
      ]);
      if (version === loadVersion.current) {
        setDirectory({ ...members, ...invites });
        setNewLink((link) => invites.invites.some((invite) => invite.id === link?.id) ? link : undefined);
      }
    } catch (error) {
      if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : "Could not load invitations.");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [path, request]);

  useEffect(() => {
    if (canManage) void load();
    return () => { loadVersion.current++; };
  }, [canManage, load]);

  function claimEmail(person: Person) {
    return directory?.claimEmails.find((contact) => contact.memberID === person.id)?.email;
  }

  function memberInvites(person: Person) {
    return directory?.invites.filter((invite) => invite.memberID === person.id) ?? [];
  }

  async function act(action: () => Promise<void>) {
    if (working) return;
    setWorking(true);
    setNotice("");
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not finish this action.");
    } finally {
      setWorking(false);
    }
  }

  function openMember(person: Person) {
    setSelectedID(person.id);
    setNotice("");
    setActionError("");
    dialog.current?.showModal();
  }

  const projected = entries.map(homeMoney.project);
  const missingSpend = projected.some((entry, index) => !entry && entries[index].kind === "expense");
  const foreignSpend = entries.some((entry) => entry.kind === "expense" && entry.currency !== homeMoney.home);
  const spending = breakdown(projected.filter((entry): entry is Expense => entry !== null), group.members, homeMoney.home);
  const spendText = (amount: number) => missingSpend ? "Rate unavailable" : homeMoney.format(amount, foreignSpend);

  const feedback = <>
    {notice && <p className="ok-banner" role="status">{notice}</p>}
    {actionError && <p className="error-banner" role="alert">{actionError}</p>}
  </>;

  return (
    <section className="group-settings" aria-labelledby="group-members-title">
      <header className="workspace-section-head">
        <h2 id="group-members-title">Members</h2>
        <p className="muted">Manage the people and invitations in {group.name}.</p>
      </header>
      {canManage && (
        <nav className="settings-links" aria-label="Members sections">
          <a href="#group-roster">Roster</a>
          <a href="#add-person">Add a person</a>
          <a href="#group-invites">Invitations</a>
        </nav>
      )}
      {loadError && <div className="error-banner" role="alert">
        {loadError} <button type="button" className="btn btn-xs" onClick={() => void load()}>Retry</button>
      </div>}
      {selectedID === undefined && feedback}
      <div className="settings-grid">
        <SettingsCard id="group-roster" title={`Roster (${group.members.filter((person) => !person.removed).length} active)`}>
          <div className="settings-members">
            {group.members.map((person) => {
              const stats = spending.members.find((member) => member.id === person.id);
              const amounts = memberBalances(entries, person.id);
              const net = homeMoney.total(amounts);
              const isMe = person.userID === user;
              const email = claimEmail(person);
              const inviteEmails = [...new Set(memberInvites(person).flatMap((invite) => invite.recipientEmail ?? []))];
              return (
                <div key={person.id} className="settings-member">
                  <Link to={memberPath(group, person.id)} className="settings-member-link">
                    <Avatar name={person.name} avatarURL={person.avatarURL} size={36} />
                    <div className="member-identity">
                      <div className="member-name">
                        <strong>{person.name}</strong>
                        {isMe && <span className="tag tag-primary">You</span>}
                        <span className={person.removed ? "tag tag-warn" : "tag"}>
                          {person.removed ? "Archived" : person.userID ? "Joined" : "Placeholder"}
                        </span>
                      </div>
                      {email && <small className="muted">Claim email {email}</small>}
                      {inviteEmails.map((address) => <small className="muted" key={address}>Invited {address}</small>)}
                      <div className="muted num">Paid {spendText(stats?.paid ?? 0)} · Share {spendText(stats?.share ?? 0)}</div>
                    </div>
                  </Link>
                  <div className="settings-member-actions">
                    <BalanceBadge amount={net.amount} currency={homeMoney.home} display={Object.values(amounts).some(Boolean) ? homeMoney.totalText(amounts, true) : undefined} />
                    {canManage && (!demo || !isMe) && (
                      <button className="btn btn-xs" type="button" aria-label={`Manage ${person.name}`} onClick={() => openMember(person)}>Manage</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsCard>
        {canManage && <>
          <SettingsCard id="add-person" title="Add a person" description="Add a placeholder or find someone on Split.">
            <Form label="Add placeholder" submit={async (form) => {
              await save(`${path}/members`, { id: crypto.randomUUID(), name: value(form, "name"), email: value(form, "email") });
              await load();
              setNotice("Placeholder added.");
            }}>
              <label className="field">Name<input type="text" name="name" required maxLength={60} /></label>
              <label className="field">Claim email (optional)<input type="email" name="email" maxLength={254} />
                <small>They can claim their history by signing in with this verified email.</small>
              </label>
            </Form>
            <Form label="Search Split" submit={async (form) => {
              setMatches(undefined);
              setMatches(await request<DirectoryPerson[]>("/v1/people/search", { query: value(form, "query") }));
            }}>
              <label className="field">Find someone on Split<input type="search" name="query" required minLength={3} maxLength={254}
                placeholder="Full email, or the first 3 letters of a name" />
                <small>They get an invitation in Split and can accept or decline it. Only names and avatars are shown.</small>
              </label>
            </Form>
            {matches?.length === 0 && <p className="muted">No matches.</p>}
            {matches?.map((person) => {
              const joined = group.members.some((member) => member.userID === person.userID && !member.removed);
              const invited = directory?.invites.some((invite) => invite.kind === "person" && invite.recipientName === person.name);
              // People you already share a group with can be added directly, as before.
              const known = data.groups.some((other) => other.members.some((member) => member.userID === person.userID));
              return (
                <div className="people-row-main" key={person.userID}>
                  <Avatar name={person.name} avatarURL={person.avatarURL} size={32} />
                  <strong>{person.name}</strong>
                  <div className="people-row-actions">
                    {known && !joined && (
                      <button className="btn btn-sm" type="button" disabled={working} onClick={() => void act(async () => {
                        await save(`${path}/members`, { id: crypto.randomUUID(), userID: person.userID, name: person.name });
                        setMatches(undefined);
                        setNotice(`${person.name} added.`);
                      })}>Add now</button>
                    )}
                    <button className="btn btn-sm btn-primary" type="button" disabled={working || joined} onClick={() => void act(async () => {
                      await request(`${path}/invites/direct`, { userID: person.userID });
                      setMatches(undefined);
                      setNotice(`Invitation sent to ${person.name}.`);
                      await load();
                    })}>{joined ? "In group" : invited ? "Invite again" : "Invite"}</button>
                  </div>
                </div>
              );
            })}
          </SettingsCard>
          <SettingsCard id="group-invites" title="Invitations" description="Share a link or send a personal email from a placeholder’s member row.">
            <Form label="Create invite link" submit={async (form) => {
              const memberID = value(form, "member");
              const link = await request<{ id: string; url: string }>(`${path}/invites`, memberID ? { memberID } : {});
              setNewLink(link);
              await load();
            }}>
              <label className="field">Invite target
                <select name="member">
                  <option value="">Anyone with the group link</option>
                  {group.members.filter((person) => !person.userID && !person.removed).map((person) =>
                    <option key={person.id} value={person.id}>Claim {person.name}’s place</option>)}
                </select>
              </label>
            </Form>
            {newLink && (
              <div className="settings-invite-url">
                <input type="text" readOnly value={newLink.url} className="mono" aria-label="Invite link" />
                <button type="button" className="btn btn-sm" onClick={() => void act(async () => {
                  await navigator.clipboard.writeText(newLink.url);
                  setNotice("Invite link copied.");
                })}>Copy</button>
              </div>
            )}
            {loading && !directory && <p role="status" className="muted">Loading invitations…</p>}
            {directory?.invites.length === 0 && <p className="muted">No active invitations.</p>}
            {directory && directory.invites.length > 0 && (
              <div className="panel">
                {directory.invites.map((invite) => (
                  <div className="settings-member member-invite" key={invite.id}>
                    <div className="member-identity">
                      <strong>{invite.kind === "person" ? `${invite.recipientName} (in-app)` : invite.memberName ? `For ${invite.memberName}` : "General group invite"}</strong>
                      {invite.kind === "person" && invite.memberName && <small>Claims {invite.memberName}’s place</small>}
                      {invite.recipientEmail && <small>{invite.recipientEmail}</small>}
                      <small className="muted">Expires {new Date(invite.expiresAt).toLocaleDateString()}</small>
                    </div>
                    <div className="settings-member-actions">
                      {invite.recipientEmail && (
                        <button className="btn btn-xs" type="button" disabled={working} onClick={() => void act(async () => {
                          await request(`${path}/invites/${invite.id}/resend`, {});
                          setNotice(`Invitation resent to ${invite.recipientEmail}.`);
                          await load();
                        })}>Resend email</button>
                      )}
                      <button className="btn btn-xs btn-danger" type="button" disabled={working} onClick={() => {
                        if (!confirm("Revoke this invitation? Its link and code will stop working.")) return;
                        void act(async () => {
                          await request(`${path}/invites/${invite.id}/revoke`, {});
                          setNotice("Invitation revoked.");
                          await load();
                        });
                      }}>Revoke</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCard>
        </>}
      </div>
      <dialog ref={dialog} className="modal group-delete-dialog" aria-labelledby="manage-member-title" onClose={() => setSelectedID(undefined)}>
        {selected && (
          <div className="form-stack" key={selected.id}>
            <h3 id="manage-member-title">{selected.name}</h3>
            {!selected.userID && !selected.removed && <>
              {directory && <Form label="Save claim email" submit={async (form) => {
                await request(`${path}/members/${selected.id}/email`, { email: value(form, "email") || null });
                setNotice("Claim email updated.");
                await load();
              }}>
                <label className="field">Claim email
                  <input type="email" name="email" defaultValue={claimEmail(selected)} maxLength={254} />
                  <small>This address can claim the placeholder automatically after sign-in. Clear it to remove that access.</small>
                </label>
              </Form>}
              {!demo && <Form label="Send invite email" submit={async (form) => {
                const email = value(form, "email");
                await request(`${path}/members/${selected.id}/invite-email`, { email });
                setNotice(`Invitation sent to ${email}.`);
                await load();
              }}>
                <label className="field">Send an invitation to
                  <input type="email" name="email" required defaultValue={claimEmail(selected)} maxLength={254} />
                  <small>The recipient signs in with this email and opens the link to claim the placeholder.</small>
                </label>
              </Form>}
            </>}
            {!demo && selected.userID && !selected.removed && (
              <button className="btn" type="button" disabled={working} onClick={() => void act(async () => {
                await request(`${path}/members/${selected.id}/sign-in-email`, {});
                setNotice("Sign-in reminder sent.");
              })}>Send sign-in email</button>
            )}
            {selected.userID !== user && (
              <div className="settings-member-actions">
                <button className="btn" type="button" disabled={working} onClick={() => {
                  if (!selected.removed && !confirm(`Archive ${selected.name}? Their past expenses and balances will stay in the group.`)) return;
                  void act(async () => {
                    const member = selected;
                    await save(`${path}/members/${member.id}/remove`, { mode: member.removed ? "restore" : "archive" });
                    await load();
                    dialog.current?.close();
                    setNotice(member.removed ? "Member restored." : "Member archived.");
                  });
                }}>{selected.removed ? "Restore member" : "Archive member"}</button>
                <button className="btn btn-danger" type="button" disabled={working} onClick={() => {
                  if (!confirm(`Permanently delete ${selected.name}? Only members with no expenses can be deleted.`)) return;
                  void act(async () => {
                    await save(`${path}/members/${selected.id}/remove`, { mode: "delete" });
                    await load();
                    dialog.current?.close();
                    setNotice("Member deleted.");
                  });
                }}>Delete member</button>
              </div>
            )}
            {feedback}
            <button className="btn" type="button" onClick={() => dialog.current?.close()}>Done</button>
          </div>
        )}
      </dialog>
    </section>
  );
}
