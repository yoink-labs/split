import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import type { DirectoryPerson, Invitation } from "./data";
import { Avatar } from "./ui";

const kindLabel: Record<string, string> = { trip: "Trip", home: "Home", friend: "Friend tab" };

export function FriendsScreen() {
  const { request } = useLedger();
  const [friends, setFriends] = useState<DirectoryPerson[]>([]);
  const [shared, setShared] = useState<DirectoryPerson[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const [friends, shared] = await Promise.all([
        request<DirectoryPerson[]>("/v1/friends"),
        request<DirectoryPerson[]>("/v1/people/shared"),
      ]);
      setFriends(friends);
      setShared(shared);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load friends."); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  async function send(target: { email: string } | { userID: string }) {
    await request("/v1/friends/requests", target);
    setNotice("If this person can receive your request, it will appear in their invitation inbox.");
  }
  const candidates = shared.filter((person) => !friends.some((friend) => friend.userID === person.userID));
  return (
    <div className="people-page form-stack">
      <div className="page-head"><h1 className="page-title">Friends</h1></div>
      {notice && <p className="ok-banner" role="status">{notice}</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      <section className="card card-pad form-stack">
        <h2>Send a friend request</h2>
        <Form label="Send by email" submit={async (form) => send({ email: value(form, "email") })}>
          <label className="field">Full email address<input type="email" name="email" required maxLength={254} /></label>
        </Form>
        {candidates.length > 0 && <Form label="Send to group member" submit={async (form) => send({ userID: value(form, "user") })}>
          <label className="field">From shared groups<select name="user" required>
            <option value="">Choose a person</option>
            {candidates.map((person) => <option key={person.userID} value={person.userID}>{person.name}</option>)}
          </select></label>
        </Form>}
      </section>
      <section className="card card-pad form-stack">
        <h2>Your friends</h2>
        {friends.length === 0 && <p className="muted">Accepted requests appear here.</p>}
        {friends.map((friend) => <div className="people-row-main" key={friend.userID}>
          <Avatar name={friend.name} avatarURL={friend.avatarURL} size={36} />
          <strong>{friend.name}</strong>
          <div className="people-row-actions"><Form label="Remove" submit={async () => {
            await request(`/v1/friends/${encodeURIComponent(friend.userID)}/remove`, {});
            await load();
          }} /></div>
        </div>)}
      </section>
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
