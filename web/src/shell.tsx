import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLedger } from "./context";
import { type Group } from "./data";
import { memberBalances, useHomeMoney, useLedgerRates } from "./homeMoney";
import { SplitLogo, Avatar } from "./ui";
import { NavigationMenu } from "./picker";

const accountLinks = [
  { to: "/you", label: "Account & avatar", hint: "Profile, theme, payment handles" },
  { to: "/ai", label: "AI & CLI", hint: "Setup, connections, and tokens" },
  { to: "/import/splitwise", label: "Import from Splitwise", hint: "Bring over a CSV export" },
  { to: "/convert", label: "Currency converter", hint: "Daily and manual rates" },
  { to: "/join", label: "Join with a code", hint: "Accept an invite" },
];

function AccountMenu({ name, avatarURL, onNavigate }: { name: string; avatarURL?: string | null; onNavigate: () => void }) {
  const { pathname } = useLocation();
  return <NavigationMenu key={pathname} label={name + ", settings and tools"} current={pathname}
    links={accountLinks} onNavigate={onNavigate} trigger={
      <>
        <Avatar name={name} avatarURL={avatarURL} size={30} />
        <span className="nav-item-main">
          <span className="nav-item-name">{name}</span>
          <span className="nav-item-sub">Settings & tools</span>
        </span>
      </>
    } />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { data, user, userName, userAvatar, demo, exitDemo, refresh, checking } = useLedger();
  useLedgerRates([...data.entries, ...(data.settlementRequests ?? [])], data.groups.map((group) => group.currency));
  const homeMoney = useHomeMoney();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const invitationCount = data.invitationCount ?? 0;

  const activeGroups = data.groups.filter((g) => !g.archived);
  const trips = activeGroups.filter((g) => g.kind === "trip");
  const longTerm = activeGroups.filter((g) => g.kind !== "trip");
  const archived = data.groups.filter((g) => g.archived);

  const renderGroupLink = (g: Group) => {
    const me = g.members.find((member) => member.userID === user);
    const amounts = me ? memberBalances(data.entries.filter((entry) => entry.groupID === g.id), me.id) : {};
    const net = homeMoney.total(amounts);
    const active = loc.pathname.startsWith("/g/" + g.id);
    const dotClass = net.missing.length || net.amount === 0 ? "nav-dot" : net.amount > 0 ? "nav-dot pos" : "nav-dot neg";
    return (
      <Link
        key={g.id}
        to={"/g/" + g.id}
        className={"nav-item" + (active ? " active" : "")}
        onClick={() => setNavOpen(false)}
      >
        <span className={dotClass} />
        <span className="nav-item-main">
          <span className="nav-item-name">{g.name}</span>
          <span className="nav-item-sub">
            {Object.values(amounts).some(Boolean)
              ? homeMoney.totalText(amounts, true)
              : "Settled"}
          </span>
        </span>
      </Link>
    );
  };

  return (
    <div className="app-shell">
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={"sidebar" + (navOpen ? " open" : "")}>
        <div className="sidebar-head">
          <Link to="/" className="brand-link" onClick={() => setNavOpen(false)}>
            <SplitLogo />
            <span>Split</span>
          </Link>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => void refresh()}
              disabled={checking}
              title="Refresh ledger"
              aria-label="Refresh ledger"
            >
              ↻
            </button>
            <Link
              to="/new"
              className="btn btn-primary btn-icon"
              title="New trip or group"
              aria-label="New trip or group"
              onClick={() => setNavOpen(false)}
            >
              +
            </Link>
          </div>
        </div>

        {demo && (
          <div className="demo-banner">
            <span>Sample workspace</span>
            {exitDemo && <button onClick={exitDemo}>Sign in</button>}
          </div>
        )}

        <Link
          to="/"
          className={"nav-item" + (loc.pathname === "/" ? " active" : "")}
          onClick={() => setNavOpen(false)}
        >
          <span>Overview</span>
        </Link>
        <Link
          to="/invitations"
          className={"nav-item" + (loc.pathname === "/invitations" ? " active" : "")}
          onClick={() => setNavOpen(false)}
          aria-label={invitationCount ? `Invitations, ${invitationCount} pending` : "Invitations"}
        >
          <span className="nav-item-main">Invitations</span>
          {invitationCount > 0 && <span className="nav-badge">{invitationCount}</span>}
        </Link>
        <Link
          to="/friends"
          className={"nav-item" + (loc.pathname === "/friends" ? " active" : "")}
          onClick={() => setNavOpen(false)}
        >
          <span>Friends</span>
        </Link>

        <div className="nav-section">
          <div className="nav-section-title">
            <span>Trips</span>
            <Link to="/new?kind=trip" onClick={() => setNavOpen(false)} style={{ fontSize: 12 }}>
              + New
            </Link>
          </div>
          {trips.length ? (
            trips.map(renderGroupLink)
          ) : (
            <p className="muted" style={{ fontSize: 12, padding: "4px 10px" }}>
              No trips yet
            </p>
          )}
        </div>

        <div className="nav-section">
          <div className="nav-section-title">
            <span>Long-term & Home</span>
            <Link to="/new?kind=home" onClick={() => setNavOpen(false)} style={{ fontSize: 12 }}>
              + New
            </Link>
          </div>
          {longTerm.length ? (
            longTerm.map(renderGroupLink)
          ) : (
            <p className="muted" style={{ fontSize: 12, padding: "4px 10px" }}>
              No ongoing groups
            </p>
          )}
        </div>

        {archived.length > 0 && (
          <div className="nav-section">
            <div className="nav-section-title">
              <span>Archived</span>
            </div>
            {archived.map(renderGroupLink)}
          </div>
        )}

        <div className="sidebar-foot">
          <AccountMenu name={userName} avatarURL={userAvatar} onNavigate={() => setNavOpen(false)} />
        </div>
      </aside>

      <div className="workspace-col">
        <header className="mobile-topbar">
          <button className="btn btn-sm" onClick={() => setNavOpen(true)}
            aria-label={invitationCount ? `Menu, ${invitationCount} pending invitations` : "Menu"}>
            ☰ Menu{invitationCount > 0 && <span className="nav-badge">{invitationCount}</span>}
          </button>
          <Link to="/" className="brand-link" style={{ fontSize: 15 }}>
            <SplitLogo size={22} />
            <span>Split</span>
          </Link>
          <Link to="/new" className="btn btn-primary btn-sm">
            + New
          </Link>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
