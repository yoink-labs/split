import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import { balances, groupTransfers, money, settlementEntry, type DirectoryPerson,
  type Invitation, type SentFriendRequest, type Snapshot } from "./data";
import { PaymentOptions } from "./paymentMethods";
import { FormPicker } from "./picker";
import { Avatar } from "./ui";

const kindLabel: Record<string, string> = { trip: "Trip", home: "Home", friend: "Friend tab" };

function friendBalances({ groups, entries }: Snapshot, user: string, friends: DirectoryPerson[]) {
  const totals = new Map(friends.map(({ userID }) => [userID, new Map<string, number>()]));
  const byGroup = new Map<string, Snapshot["entries"]>();
  for (const entry of entries) {
    const groupEntries = byGroup.get(entry.groupID);
    if (groupEntries) groupEntries.push(entry);
    else byGroup.set(entry.groupID, [entry]);
  }
  for (const group of groups) {
    if (group.archived) continue;
    const me = group.members.find((member) => member.userID === user);
    if (!me) continue;
    const roster = new Map(group.members.map((member) => [member.id, member.userID]));
    const groupEntries = byGroup.get(group.id) ?? [];
    for (const currency of new Set(groupEntries.map((entry) => settlementEntry(entry).currency))) {
      for (const { from, to, amount } of groupTransfers(group, balances(groupEntries, currency))) {
        if (from !== me.id && to !== me.id) continue;
        const friend = roster.get(from === me.id ? to : from);
        const total = friend && totals.get(friend);
        if (total) total.set(currency, (total.get(currency) ?? 0) + (to === me.id ? amount : -amount));
      }
    }
  }
  return totals;
}

export function FriendsScreen() {
  const { data, user, request, refresh } = useLedger();
  const [people, setPeople] = useState<{ friends: DirectoryPerson[]; shared: DirectoryPerson[];
    received: Invitation[]; sent: SentFriendRequest[] }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [showInvite, setShowInvite] = useState(false);
  const loadNumber = useRef(0);
  const load = useCallback(async () => {
    const run = ++loadNumber.current;
    try {
      const [friends, shared, { invitations }, sent] = await Promise.all([
        request<DirectoryPerson[]>("/v1/friends"),
        request<DirectoryPerson[]>("/v1/people/shared"),
        request<{ invitations: Invitation[] }>("/v1/invitations"),
        request<SentFriendRequest[]>("/v1/friends/requests"),
      ]);
      if (run !== loadNumber.current) return;
      setPeople({ friends, shared, received: invitations.filter(({ kind }) => kind === "friend"), sent });
      setError("");
    } catch (e) {
      if (run === loadNumber.current) setError(e instanceof Error ? e.message : "Could not load friends.");
    }
  }, [request]);
  useEffect(() => {
    void load();
    return () => { loadNumber.current++; };
  }, [load]);
  async function send(target: { email: string } | { userID: string }) {
    await request("/v1/friends/requests", target);
    setShowInvite(false);
    await load();
    setNotice("If this person can receive your request, it will appear in their Invitations.");
  }
  async function act(path: string, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(path, {});
      setRemoving(undefined);
      await load();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  const totals = useMemo(() => friendBalances(data, user, people?.friends ?? []), [data, user, people]);
  const candidates = people?.shared.filter((person) => !people.friends.some((friend) => friend.userID === person.userID)) ?? [];
  return (
    <div className="friends-page form-stack">
      <header className="page-head friends-head">
        <div><h1 className="page-title">Friends</h1><p className="page-sub">See what you owe each other across active groups.</p></div>
        <button className="btn btn-primary" type="button" aria-expanded={showInvite}
          aria-controls="add-friend" onClick={() => setShowInvite(!showInvite)}>{showInvite ? "Close" : "Add friend"}</button>
      </header>
      {notice && <p className="ok-banner" role="status">{notice}</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!people && !error && <p className="muted" role="status">Loading friends…</p>}
      <section id="add-friend" className="card card-pad friends-invite" hidden={!showInvite}>
        {showInvite && <>
          <Form label="Send by email" submit={(form) => send({ email: value(form, "email") })}>
            <label className="field">Friend’s email<input type="email" name="email" required maxLength={254} autoComplete="off" /></label>
          </Form>
          {candidates.length > 0 && <Form label="Send to group member" submit={(form) => send({ userID: value(form, "user") })}>
            <div className="field">From shared groups
              <FormPicker label="From shared groups" name="user" defaultValue="" required search
                options={[{ value: "", label: "Choose a person" }, ...candidates.map(({ userID, name }) => ({ value: userID, label: name }))]} />
            </div>
          </Form>}
        </>}
      </section>

      {people && <div className="friends-layout">
        <section aria-labelledby="friends-list">
          <h2 id="friends-list">Your friends <span>{people.friends.length}</span></h2>
          <div className="card">
            {people.friends.length === 0 && <p className="card-pad muted">Accepted requests appear here. Add a friend using their email address.</p>}
            {people.friends.map((friend) => {
              const amounts = [...(totals.get(friend.userID) ?? [])].filter(([, amount]) => amount).sort();
              return <article className="friend-card" key={friend.userID}>
                <div className="friend-row">
                  <Avatar name={friend.name} avatarURL={friend.avatarURL} size={44} />
                  <h3>{friend.name}</h3>
                  <div className="friend-balance">{amounts.length ? amounts.map(([currency, amount]) => (
                    <div key={currency} className={amount > 0 ? "friend-owed" : "friend-owes"}>
                      <small>{amount > 0 ? "Owes you" : "You owe"}</small>
                      <strong>{money(Math.abs(amount), currency)}</strong>
                    </div>
                  )) : <small className="muted">Settled up</small>}</div>
                  {removing !== friend.userID && <button type="button" className="btn btn-xs friend-remove"
                    aria-label={`Remove ${friend.name}`} onClick={() => setRemoving(friend.userID)}>Remove</button>}
                </div>
                {!!friend.paymentMethods?.length && <details className="friend-payments">
                  <summary>Payment methods</summary>
                  <PaymentOptions methods={friend.paymentMethods} />
                </details>}
                {removing === friend.userID && (
                  <div className="friend-actions friend-confirm">
                    <span>Remove {friend.name}?</span>
                    <button type="button" className="btn btn-xs" onClick={() => setRemoving(undefined)} autoFocus>Keep friend</button>
                    <button type="button" className="btn btn-xs btn-danger" disabled={busy}
                      onClick={() => void act(`/v1/friends/${encodeURIComponent(friend.userID)}/remove`, "Friend removed.")}>Remove</button>
                  </div>
                )}
              </article>;
            })}
          </div>
        </section>
        <section aria-labelledby="friend-requests">
          <h2 id="friend-requests">Requests <span>{people.received.length + people.sent.length}</span></h2>
          <div className="card card-pad friend-requests">
            <h3>Received</h3>
            {people.received.length === 0 && <p className="muted">No incoming requests.</p>}
            {people.received.map((invite) => <div key={invite.id} className="friend-request-item">
              <strong>{invite.inviterName ?? "Split member"}</strong>
              <div className="friend-actions">
                <button className="btn btn-sm btn-primary" type="button" disabled={busy}
                  onClick={() => void act(`/v1/invitations/${invite.id}/accept`, "Friend request accepted.")}>Accept</button>
                <button className="btn btn-sm" type="button" disabled={busy}
                  onClick={() => void act(`/v1/invitations/${invite.id}/decline`, "Friend request declined.")}>Decline</button>
              </div>
            </div>)}
            <h3>Sent</h3>
            {people.sent.length === 0 && <p className="muted">No sent requests.</p>}
            {people.sent.map((item) => <div key={item.id} className="friend-request-item">
              <strong>{item.label}</strong>
              <button className="btn btn-sm" type="button" disabled={busy} aria-label={`Cancel request to ${item.label}`}
                onClick={() => void act(`/v1/friends/requests/${item.id}/cancel`, "Friend request canceled.")}>Cancel request</button>
            </div>)}
          </div>
        </section>
      </div>}
    </div>
  );
}

function describe(invite: Invitation) {
  if (invite.kind === "email") return "Sent to your verified email";
  return invite.inviterName ? `${invite.inviterName} invited you` : "You were invited";
}

export function InvitationsScreen() {
  const { request, refresh } = useLedger();
  const navigate = useNavigate();
  const [items, setItems] = useState<Invitation[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    try {
      setItems((await request<{ invitations: Invitation[] }>("/v1/invitations")).invitations);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load invitations.");
    }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  async function answer(invite: Invitation, action: "accept" | "decline") {
    setBusy(invite.id);
    setError("");
    try {
      await request(`/v1/invitations/${invite.id}/${action}`, {});
      await refresh();
      if (action === "accept" && invite.groupID && invite.kind !== "linked") navigate(`/g/${invite.groupID}`);
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="people-page form-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Invitations</h1>
          <p className="page-sub">Group invitations, friend requests, and updates when someone links you to a placeholder.</p>
        </div>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!items && !error && <p className="muted" role="status">Loading invitations…</p>}
      {items?.length === 0 && (
        <div className="card card-pad inbox-empty">
          <strong>You’re all caught up</strong>
          <p className="muted">New invitations show up here when someone invites you from Split or emails an invite to your sign-in address.</p>
          <Link to="/join" className="btn btn-sm">Join with a code</Link>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="inbox-list">
          {items.map((invite) => (
            <article className="card card-pad inbox-card" key={invite.id} aria-label={invite.kind === "friend" ? "Friend request" : invite.groupName}>
              <div className="inbox-card-head">
                <div>
                  <span className="tag">{invite.kind === "friend" ? "Friend request" : invite.kind === "linked" ? "Placeholder linked" : kindLabel[invite.groupKind] ?? "Group"}</span>
                  <h3>{invite.kind === "friend" ? invite.inviterName : invite.groupName}</h3>
                  {invite.kind === "linked" ? <p className="muted">{invite.inviterName ?? "A group member"} linked you to {invite.memberName}. Their expense history is now yours.</p>
                    : invite.kind !== "friend" && <p className="muted">{describe(invite)} · {invite.memberCount} {invite.memberCount === 1 ? "member" : "members"}</p>}
                </div>
              </div>
              {invite.memberName && invite.kind !== "linked" && (
                <p className="inbox-claim">You’ll take over <strong>{invite.memberName}</strong>’s place, with their expenses and balances.</p>
              )}
              <div className="inbox-actions">
                {invite.kind !== "linked" && <small className="muted">Expires {new Date(invite.expiresAt).toLocaleDateString()}</small>}
                <button className="btn btn-sm" type="button" disabled={busy !== undefined}
                  onClick={() => void answer(invite, "decline")}>{invite.kind === "linked" ? "Dismiss" : "Decline"}</button>
                {invite.kind === "linked" ? <Link className="btn btn-sm btn-primary" to={`/g/${invite.groupID}`}>Open group</Link> : <button className="btn btn-sm btn-primary" type="button" disabled={busy !== undefined}
                  onClick={() => void answer(invite, "accept")}>Accept</button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiscoverySetting() {
  const { data, demo, save } = useLedger();
  const discoverable = data.discoverable !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="card card-pad form-stack">
      <h3>Privacy</h3>
      <label className="check-row">
        <input type="checkbox" checked={discoverable} disabled={busy} onChange={async (e) => {
          const next = e.currentTarget.checked;
          setBusy(true);
          setError("");
          try { await save("/v1/profile/discoverable", { discoverable: next }); }
          catch (err) { setError(err instanceof Error ? err.message : "Try again."); }
          finally { setBusy(false); }
        }} />
        <span>
          <strong>Let people find me</strong>
          <small className="muted">{demo ? "Sample setting. " : ""}Allow friend requests addressed to your full sign-in email. People in your shared groups can still send requests.</small>
        </span>
      </label>
      {error && <p className="error-banner" role="alert">{error}</p>}
    </div>
  );
}
