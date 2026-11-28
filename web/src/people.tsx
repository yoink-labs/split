import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import type { DirectoryPerson, DirectoryProfile, Group, Invitation } from "./data";
import { Avatar } from "./ui";

const kindLabel: Record<string, string> = { trip: "Trip", home: "Home", friend: "Friend tab" };

/** Groups the viewer can invite someone into: active, not archived, and not already joined by them. */
function invitableGroups(groups: Group[], user: string, target: string) {
  return groups.filter((group) => !group.archived && group.kind !== "friend"
    && group.members.some((member) => member.userID === user && !member.removed)
    && !group.members.some((member) => member.userID === target && !member.removed));
}

export function InviteToGroup({ person, onSent }: { person: DirectoryPerson; onSent?: (group: Group) => void }) {
  const { data, user, request } = useLedger();
  const [sent, setSent] = useState("");
  const groups = invitableGroups(data.groups, user, person.userID);
  if (!groups.length) return <p className="muted people-note">No groups to invite {person.name} to yet.</p>;
  return (
    <Form label="Send invitation" submit={async (form) => {
      const group = groups.find((item) => item.id === value(form, "group"));
      if (!group) throw new Error("Choose a group.");
      await request(`/v1/groups/${group.id}/invites/direct`, { userID: person.userID });
      setSent(`Invitation sent. ${person.name} will see it in their inbox for ${group.name}.`);
      onSent?.(group);
    }}>
      <label className="field">Invite {person.name} to
        <select name="group" defaultValue={groups[0].id}>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>
      {sent && <p className="ok-banner" role="status">{sent}</p>}
    </Form>
  );
}

export function PeopleScreen() {
  const { request } = useLedger();
  const [results, setResults] = useState<DirectoryPerson[]>();
  const [inviting, setInviting] = useState<string>();
  return (
    <div className="people-page form-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Find people</h1>
          <p className="page-sub">Look up someone on Split to invite them to a group.</p>
        </div>
      </div>
      <div className="card card-pad form-stack">
        <Form label="Search" submit={async (form) => {
          setResults(undefined);
          setInviting(undefined);
          setResults(await request<DirectoryPerson[]>("/v1/people/search", { query: value(form, "query") }));
        }}>
          <label className="field">Name or email
            <input type="search" name="query" required minLength={3} maxLength={254} autoComplete="off"
              placeholder="First 3 letters of a name, or a full email" />
            <small>Split shows names and avatars only. Email addresses and phone numbers stay private.</small>
          </label>
        </Form>
      </div>
      {results?.length === 0 && (
        <div className="card card-pad"><p className="muted">No one matched. Try a full email address, or ask them to turn on “Let people find me” in Account.</p></div>
      )}
      {results && results.length > 0 && (
        <div className="card people-results" aria-label="Search results">
          {results.map((person) => (
            <div className="people-row" key={person.userID}>
              <div className="people-row-main">
                <Avatar name={person.name} avatarURL={person.avatarURL} size={40} />
                <strong>{person.name}</strong>
                <div className="people-row-actions">
                  <Link className="btn btn-sm" to={`/people/${encodeURIComponent(person.userID)}`}>Profile</Link>
                  <button className="btn btn-sm btn-primary" type="button" aria-expanded={inviting === person.userID}
                    onClick={() => setInviting(inviting === person.userID ? undefined : person.userID)}>Invite</button>
                </div>
              </div>
              {inviting === person.userID && <InviteToGroup person={person} />}
            </div>
          ))}
        </div>
      )}
      <p className="muted people-note">Results are limited to 10 people. You can run 60 searches an hour.</p>
    </div>
  );
}

export function PersonScreen() {
  const { uid = "" } = useParams();
  const { request } = useLedger();
  const [profile, setProfile] = useState<DirectoryProfile>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request<DirectoryProfile>(`/v1/people/${encodeURIComponent(uid)}`)
      .then((next) => { if (live) setProfile(next); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not load this person."); });
    return () => { live = false; };
  }, [request, uid]);
  if (error) return <div className="people-page"><p className="error-banner" role="alert">{error}</p></div>;
  if (!profile) return <div className="people-page"><p className="muted" role="status">Loading…</p></div>;
  return (
    <div className="people-page form-stack">
      <Link to="/people" className="muted">‹ Find people</Link>
      <div className="card card-pad people-profile">
        <Avatar name={profile.name} avatarURL={profile.avatarURL} size={72} />
        <div>
          <h1 className="page-title">{profile.name}</h1>
          <p className="muted">{profile.sharedGroups.length
            ? `In ${profile.sharedGroups.length} of your groups`
            : "You don’t share any groups yet"}</p>
        </div>
      </div>
      {profile.sharedGroups.length > 0 && (
        <div className="card">
          {profile.sharedGroups.map((group) => (
            <Link className="row" key={group.id} to={`/g/${group.id}`}><span>{group.name}</span><span className="muted">›</span></Link>
          ))}
        </div>
      )}
      <div className="card card-pad form-stack">
        <h3>Invite to a group</h3>
        <InviteToGroup person={profile} />
      </div>
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
      if (action === "accept") navigate(`/g/${invite.groupID}`);
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
          <p className="page-sub">Groups you’ve been invited to. Accepting adds you and keeps any history recorded for you.</p>
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
            <article className="card card-pad inbox-card" key={invite.id} aria-label={`Invitation to ${invite.groupName}`}>
              <div className="inbox-card-head">
                <div>
                  <span className="tag">{kindLabel[invite.groupKind] ?? "Group"}</span>
                  <h3>{invite.groupName}</h3>
                  <p className="muted">{describe(invite)} · {invite.memberCount} {invite.memberCount === 1 ? "member" : "members"}</p>
                </div>
              </div>
              {invite.memberName && (
                <p className="inbox-claim">You’ll take over <strong>{invite.memberName}</strong>’s place, with their expenses and balances.</p>
              )}
              <div className="inbox-actions">
                <small className="muted">Expires {new Date(invite.expiresAt).toLocaleDateString()}</small>
                <button className="btn btn-sm" type="button" disabled={busy !== undefined}
                  onClick={() => void answer(invite, "decline")}>Decline</button>
                <button className="btn btn-sm btn-primary" type="button" disabled={busy !== undefined}
                  onClick={() => void answer(invite, "accept")}>{busy === invite.id ? "Joining…" : "Accept"}</button>
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
          <small className="muted">{demo ? "Sample setting. " : ""}When on, people can find you by your full email address or the start of your name, and see only your name and avatar. When off, only people who already share a group with you can see your profile.</small>
        </span>
      </label>
      {error && <p className="error-banner" role="alert">{error}</p>}
    </div>
  );
}
