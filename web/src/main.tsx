import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startAppearance } from "./appearance";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { LedgerContext } from "./context";
import {
  api,
  itemSplit,
  type ActiveInvite,
  type Expense,
  type ExpenseComment,
  type Group,
  type Snapshot,
} from "./data";
import { createDemoState, DEMO_USER } from "./demo";
import { ExpenseForm } from "./expense";
import { ConverterScreen } from "./fxui";
import { GroupWorkspace } from "./groupWorkspace";
import { isAbort, mergeSnapshot, singleFlight } from "./refresh";
import {
  Account,
  HomeOverview,
  Join,
  LocalAIScreen,
  MemberScreen,
  NewGroup,
} from "./screens";
import { AppShell } from "./shell";
import { SplitwiseImport } from "./splitwise";
import "./style.css";

function RoutesBody() {
  const loc = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomeOverview />} />
        <Route path="/new" element={<NewGroup />} />
        <Route path="/join" element={<Join />} />
        <Route path="/invite/:code" element={<Join />} />
        <Route path="/you" element={<Account />} />
        <Route path="/ai" element={<LocalAIScreen />} />
        <Route path="/import/splitwise" element={<SplitwiseImport />} />
        <Route path="/convert" element={<ConverterScreen />} />
        <Route path="/g/:gid" element={<GroupWorkspace />} />
        <Route path="/g/:gid/m/:mid" element={<MemberScreen />} />
        <Route path="/g/:gid/new" element={<ExpenseForm />} />
        <Route path="/g/:gid/e/:eid" element={<GroupWorkspace />} />
        <Route path="/g/:gid/e/:eid/edit" element={<ExpenseForm />} />
        <Route
          path="*"
          element={
            <div className="card card-pad">
              <p>
                Page unavailable. <Link to="/">Return to Overview</Link>
              </p>
            </div>
          }
        />
      </Routes>
    </AppShell>
  );
}

/** Fully interactive in-memory demo workspace so every feature works locally without sign-in. */
function DemoLedger({ onExit }: { onExit: () => void }) {
  const initial = useMemo(() => createDemoState(), []);
  const [data, setData] = useState<Snapshot>(initial.snapshot);
  const commentsRef = useRef<Record<string, ExpenseComment[]>>(initial.comments);
  const invitesRef = useRef<Record<string, ActiveInvite[]>>(initial.invites);
  const photosRef = useRef<Record<string, Blob>>(initial.photos);

  function storePhotos(photos: { id: string; data: string }[] = []) {
    const decoded = photos.map(({ id, data }) => ({
      id,
      image: new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/jpeg" }),
    }));
    for (const { id, image } of decoded) photosRef.current[id] = image;
    return decoded.map(({ id }) => id);
  }

  const request = useCallback(
    async <T,>(path: string, body?: unknown, photo = false): Promise<T> => {
      // Photo download
      const photoMatch = path.match(/^\/v1\/entries\/([\w-]+)\/receipts\/([\w-]+)$/);
      if (photoMatch && photo) {
        const [, entryID, photoID] = photoMatch;
        const blob = data.entries.find((entry) => entry.id === entryID)?.receiptIDs?.includes(photoID)
          ? photosRef.current[photoID]
          : undefined;
        if (!blob) throw new Error("Receipt photo unavailable.");
        return blob as T;
      }

      // Comments GET / POST
      const commentMatch = path.match(/^\/v1\/entries\/([\w-]+)\/comments$/);
      if (commentMatch) {
        const eid = commentMatch[1];
        if (body === undefined) {
          return { comments: commentsRef.current[eid] ?? [] } as T;
        }
        const b = body as { body: string };
        const created: ExpenseComment = {
          id: crypto.randomUUID(),
          entryID: eid,
          authorUserID: DEMO_USER,
          authorName: "Harris",
          body: b.body,
          createdAt: new Date().toISOString(),
          mine: true,
        };
        commentsRef.current[eid] = [...(commentsRef.current[eid] ?? []), created];
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((e) =>
            e.id === eid ? { ...e, commentCount: (e.commentCount ?? 0) + 1 } : e,
          ),
        }));
        return created as T;
      }

      // Invites GET / POST / revoke
      const invMatch = path.match(/^\/v1\/groups\/([\w-]+)\/invites$/);
      if (invMatch) {
        const gid = invMatch[1];
        if (body === undefined) return { invites: invitesRef.current[gid] ?? [] } as T;
        const b = body as { memberID?: string };
        const code = Math.random().toString(36).slice(2, 14).toUpperCase();
        const url = `https://split.yoinklabs.dev/invite/${code}`;
        const g = data.groups.find((x) => x.id === gid);
        const target = b.memberID ? g?.members.find((m) => m.id === b.memberID) : null;
        const inv: ActiveInvite = {
          id: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"),
          kind: target ? "member" : "group",
          memberID: target?.id ?? null,
          memberName: target?.name ?? null,
          expiresAt: Date.now() + 7 * 86400_000,
          url,
          code,
        };
        invitesRef.current[gid] = [
          inv,
          ...(invitesRef.current[gid] ?? []).filter((old) => !target || old.memberID !== target.id),
        ];
        return { url, code } as T;
      }

      const revMatch = path.match(/^\/v1\/groups\/([\w-]+)\/invites\/([^/]+)\/revoke$/);
      if (revMatch) {
        const [, gid, id] = revMatch;
        invitesRef.current[gid] = (invitesRef.current[gid] ?? []).filter((x) => x.id !== id);
        return { ok: true } as T;
      }

      // Like toggle
      const likeMatch = path.match(/^\/v1\/entries\/([\w-]+)\/like$/);
      if (likeMatch) {
        const eid = likeMatch[1];
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((e) => {
            if (e.id !== eid) return e;
            const liked = !e.likedByMe;
            return { ...e, likedByMe: liked, likeCount: Math.max(0, (e.likeCount ?? 0) + (liked ? 1 : -1)) };
          }),
        }));
        return { ok: true } as T;
      }

      // Create group
      if (path === "/v1/groups" && body) {
        const b = body as Group;
        setData((prev) => ({ ...prev, groups: [b, ...prev.groups] }));
        return { ok: true } as T;
      }

      // Update group
      const updGroup = path.match(/^\/v1\/groups\/([\w-]+)\/update$/);
      if (updGroup && body) {
        const gid = updGroup[1];
        const b = body as Partial<Group>;
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((g) => (g.id === gid ? { ...g, ...b } : g)),
        }));
        return { ok: true } as T;
      }

      // Payment profile
      const payMatch = path.match(/^\/v1\/groups\/([\w-]+)\/payment-profile$/);
      if (payMatch && body) {
        const gid = payMatch[1];
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((g) =>
            g.id !== gid
              ? g
              : {
                  ...g,
                  members: g.members.map((m) =>
                    m.userID === DEMO_USER ? { ...m, payment: body as Record<string, string> } : m,
                  ),
                },
          ),
        }));
        return { ok: true } as T;
      }

      // Add member
      if (path === "/v1/people/search" && body) {
        const query = (body as { query: string }).query.trim().toLowerCase();
        const matches = new Map(
          data.groups.flatMap((g) => g.members)
            .filter((m) => m.userID && m.userID !== DEMO_USER && m.name.toLowerCase().includes(query))
            .map((m) => [m.userID, { userID: m.userID, name: m.name }]),
        );
        return [...matches.values()] as T;
      }
      const addMem = path.match(/^\/v1\/groups\/([\w-]+)\/members$/);
      if (addMem && body) {
        const gid = addMem[1];
        const b = body as { id: string; name: string; userID?: string };
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((g) =>
            g.id === gid && !g.members.some((m) => m.id === b.id || (b.userID && m.userID === b.userID))
              ? { ...g, members: [...g.members, { id: b.id, name: b.name, userID: b.userID ?? null }] }
              : g,
          ),
        }));
        return { id: b.id } as T;
      }

      // Remove / Archive / Restore member
      const remMem = path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/remove$/);
      if (remMem && body) {
        const [, gid, mid] = remMem;
        const { mode } = body as { mode: "archive" | "delete" | "restore" };
        if (mode === "delete") {
          const used = data.entries.some(
            (e) =>
              e.groupID === gid &&
              (e.paidBy === mid || e.payers?.some((p) => p.memberID === mid) || e.splits.some((s) => s.memberID === mid)
                || e.bill?.items.some((item) => item.memberIDs.includes(mid))),
          );
          if (used) throw new Error("This person has expenses in the group. Retain them as an archived entity to keep balances accurate.");
          setData((prev) => ({
            ...prev,
            groups: prev.groups.map((g) =>
              g.id === gid ? { ...g, members: g.members.filter((m) => m.id !== mid) } : g,
            ),
          }));
        } else {
          setData((prev) => ({
            ...prev,
            groups: prev.groups.map((g) =>
              g.id === gid
                ? { ...g, members: g.members.map((m) => (m.id === mid ? { ...m, removed: mode === "archive" } : m)) }
                : g,
            ),
          }));
        }
        if (mode !== "restore") invitesRef.current[gid] = (invitesRef.current[gid] ?? []).filter((i) => i.memberID !== mid);
        return { ok: true } as T;
      }

      // Profile avatar
      if (path === "/v1/profile/avatar" && body) {
        const { avatarURL } = body as { avatarURL: string | null };
        setData((prev) => ({
          ...prev,
          avatarURL,
          groups: prev.groups.map((g) => ({
            ...g,
            members: g.members.map((m) => (m.userID === DEMO_USER ? { ...m, avatarURL } : m)),
          })),
        }));
        return { ok: true } as T;
      }

      // Create entry
      if (path === "/v1/entries" && body) {
        const b = body as Expense & { photos?: { id: string; data: string }[] };
        const receiptIDs = storePhotos(b.photos);
        const { photos: _p, ...rest } = b;
        const next: Expense = { ...rest, editable: true, ...(receiptIDs.length ? { receiptIDs } : {}) };
        setData((prev) => ({ ...prev, entries: [next, ...prev.entries] }));
        return { ok: true } as T;
      }

      // Edit / Delete entry
      const editMatch = path.match(/^\/v1\/entries\/([\w-]+)\/(edit|delete)$/);
      if (editMatch && body) {
        const [, eid, action] = editMatch;
        if (action === "delete") {
          setData((prev) => ({ ...prev, entries: prev.entries.filter((e) => e.id !== eid) }));
        } else {
          const { entry, photos } = body as { entry: Expense; photos?: { id: string; data: string }[] };
          const photoIDs = storePhotos(photos);
          setData((prev) => ({
            ...prev,
            entries: prev.entries.map((e) => e.id === eid ? {
              ...entry,
              editable: e.editable,
              recurrence: e.recurrence,
              commentCount: e.commentCount,
              likeCount: e.likeCount,
              likedByMe: e.likedByMe,
              receiptIDs: [...new Set([...(e.receiptIDs ?? []), ...photoIDs])],
            } : e),
          }));
        }
        return { ok: true } as T;
      }

      // Repeat schedule
      const repMatch = path.match(/^\/v1\/groups\/([\w-]+)\/repeat$/);
      if (repMatch && body) {
        const { entryID, cadence } = body as { entryID: string; cadence: string };
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((e) =>
            e.id === entryID ? { ...e, recurrence: cadence === "off" ? null : cadence } : e,
          ),
        }));
        return { ok: true } as T;
      }

      // Fractional claim or close receipt
      const claimMatch = path.match(/^\/v1\/entries\/([\w-]+)\/(claim|close)$/);
      if (claimMatch && body) {
        const [, eid, action] = claimMatch;
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((e) => {
            if (e.id !== eid || !e.bill) return e;
            const bill = structuredClone(e.bill);
            if (action === "close") {
              const { memberIDs } = body as { memberIDs: string[] };
              for (const item of bill.items) {
                if (!item.memberIDs.length) item.memberIDs = memberIDs;
              }
              bill.closed = true;
            } else {
              const { itemID, memberIDs, shares } = body as {
                itemID: string;
                memberIDs: string[];
                shares?: Record<string, number>;
              };
              const item = bill.items.find((i) => i.id === itemID);
              if (item) {
                if (JSON.stringify(item.memberIDs) !== JSON.stringify(memberIDs)) {
                  delete item.roundingSeats;
                  delete item.roundingWeights;
                }
                item.memberIDs = memberIDs;
                const nextShares = Object.fromEntries(
                  Object.entries({ ...item.shares, ...shares }).filter(([mid]) => memberIDs.includes(mid)),
                );
                if (Object.values(nextShares).some((w) => w !== 100)) item.shares = nextShares;
                else delete item.shares;
              }
            }
            return { ...e, bill, splits: itemSplit(bill, e.paidBy) };
          }),
        }));
        return { ok: true } as T;
      }

      throw new Error("This action is unavailable in the demo workspace.");
    },
    [data.groups, data.entries],
  );

  const save = useCallback(async (path: string, body: unknown) => {
    await request(path, body);
  }, [request]);

  const myAvatar = data.avatarURL;

  return (
    <LedgerContext.Provider
      value={{
        data,
        user: DEMO_USER,
        userName: "Harris",
        userAvatar: myAvatar,
        demo: true,
        exitDemo: onExit,
        request,
        save,
        refresh: async () => {},
        checking: false,
      }}
    >
      <RoutesBody />
    </LedgerContext.Provider>
  );
}

function SignIn({ onDemo }: { onDemo: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  const [clerkLoaded, setClerkLoaded] = useState(false);

  useEffect(() => {
    const el = node.current;
    if (!el || !window.Clerk) return;
    setClerkLoaded(true);
    window.Clerk.mountSignIn(el, {
      routing: "virtual",
      fallbackRedirectUrl: location.pathname,
    });
    return () => window.Clerk.unmountSignIn(el);
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="brand-mark" style={{ width: 32, height: 32, fontSize: 15 }}>S</span>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Split</h1>
            <p className="muted" style={{ fontSize: 12.5 }}>Shared trips, receipts & group finances</p>
          </div>
        </div>
        <button className="btn btn-primary" onClick={onDemo}>
          Explore interactive sample workspace
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--border)" }} />
          <span className="muted" style={{ fontSize: 12 }}>or sign in</span>
          <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--border)" }} />
        </div>
        <div ref={node} />
        {!clerkLoaded && (
          <p className="muted" style={{ fontSize: 12.5, textAlign: "center" }}>
            Clerk sign-in is unavailable offline. Use the interactive sample workspace above.
          </p>
        )}
      </div>
    </div>
  );
}

function Ledger({ user }: { user: string }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);

  const request = useCallback(
    <T,>(path: string, body?: unknown, photo = false) => api<T>(path, user, body, photo),
    [user],
  );

  const refresh = useMemo(
    () =>
      singleFlight(async () => {
        setChecking(true);
        try {
          const next = await request<Snapshot>("/v1/snapshot");
          if (next.userID !== user) throw new Error("Sign in again to refresh this account.");
          if (!alive.current) return;
          setData((previous) => mergeSnapshot(previous, next));
          setError("");
        } catch (e) {
          if (alive.current && !isAbort(e))
            setError(e instanceof Error ? e.message : "Refresh failed.");
        } finally {
          if (alive.current) setChecking(false);
        }
      }),
    [request, user],
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const focus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);

  async function save(path: string, body: unknown) {
    await request(path, body);
    await refresh();
  }

  if (!data) {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          {error ? (
            <>
              <p className="error-banner">{error}</p>
              <button className="btn btn-primary" onClick={() => void refresh()}>
                Retry
              </button>
            </>
          ) : (
            <p className="muted">Loading your workspace…</p>
          )}
        </div>
      </div>
    );
  }

  const meMember = data.groups.flatMap((g) => g.members).find((m) => m.userID === user);
  return (
    <LedgerContext.Provider
      value={{
        data,
        user,
        userName: window.Clerk?.user?.fullName || meMember?.name || "You",
        userAvatar: data.avatarURL ?? window.Clerk?.user?.imageUrl ?? null,
        demo: false,
        request,
        save,
        refresh,
        checking,
      }}
    >
      <RoutesBody />
    </LedgerContext.Provider>
  );
}

function App() {
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const wantsDemo = new URLSearchParams(location.search).get("demo") === "1" || (isLocal && new URLSearchParams(location.search).get("demo") !== "0");
  const [demo, setDemo] = useState(wantsDemo);
  const [ready, setReady] = useState(wantsDemo);
  const [user, setUser] = useState("");

  useEffect(() => {
    if (demo) return;
    let stop: (() => void) | undefined;
    let active = true;
    async function boot() {
      try {
        if (!window.Clerk) {
          await new Promise<void>((resolve, reject) => {
            const tag = document.querySelector("script[data-clerk-publishable-key]");
            if (!tag) return reject(new Error("Sign-in unavailable."));
            const timeout = setTimeout(() => reject(new Error("Timed out")), 6000);
            tag.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
            tag.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Failed")); }, { once: true });
          });
        }
        await window.Clerk.load();
        if (!active) return;
        const sync = () => setUser(window.Clerk.user?.id ?? "");
        sync();
        stop = window.Clerk.addListener(sync);
      } catch {
        // Fall through to SignIn which offers sample workspace
      } finally {
        if (active) setReady(true);
      }
    }
    void boot();
    return () => {
      active = false;
      stop?.();
    };
  }, [demo]);

  if (demo) return <DemoLedger onExit={() => { setDemo(false); setReady(false); }} />;
  if (!ready) {
    return (
      <div className="auth-page">
        <p className="muted">Loading Split…</p>
      </div>
    );
  }
  return user ? <Ledger key={user} user={user} /> : <SignIn onDemo={() => setDemo(true)} />;
}

startAppearance();
if (location.hostname === "split-api.yoinklabs.dev") {
  location.replace("https://split.yoinklabs.dev" + location.pathname + location.search + location.hash);
} else {
  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}
