import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api, type Snapshot } from "./data";
import { LedgerContext } from "./context";
import {
  Groups,
  GroupScreen,
  MemberScreen,
  ExpenseScreen,
  Join,
  NewGroup,
  Account,
} from "./screens";
import { ExpenseForm } from "./expense";
import "./style.css";

function SignIn() {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = node.current!;
    window.Clerk.mountSignIn(el, {
      routing: "virtual",
      fallbackRedirectUrl: location.pathname,
    });
    return () => window.Clerk.unmountSignIn(el);
  }, []);
  return (
    <main className="auth">
      <div ref={node} />
    </main>
  );
}
function Ledger({ user }: { user: string }) {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const revision = useRef(0);
  const request = useCallback(
    <T,>(path: string, body?: unknown, photo = false) =>
      api<T>(path, user, body, photo),
    [user],
  );
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setChecking(true);
    try {
      const next = await request<Snapshot>("/v1/snapshot");
      if (next.userID !== user)
        throw new Error("Sign in again to refresh this account.");
      if (current === revision.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (current === revision.current)
        setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      if (current === revision.current) setChecking(false);
    }
  }, [request, user]);
  useEffect(() => {
    void refresh();
    const focus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      revision.current++;
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);
  const loc = useLocation(),
    nav = useNavigate();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  async function save(path: string, body: unknown) {
    await request(path, body);
    await refresh();
  }
  return (
    <>
      <header>
        <Link className="brand" to="/">
          <img src="/icon.png" alt="" />
          Split
        </Link>
        <nav>
          <Link to="/">Groups</Link>
          <Link to="/you">You</Link>
          <button
            onClick={() => void refresh()}
            disabled={checking}
            aria-label="Refresh ledger"
          >
            ↻
          </button>
        </nav>
      </header>
      <main>
        {loc.pathname !== "/" && (
          <button
            className="back"
            onClick={() => (window.history.state?.idx > 0 ? nav(-1) : nav("/"))}
          >
            ‹ Back
          </button>
        )}
        {error && (
          <p className="error" role="alert">
            {error} <button onClick={() => void refresh()}>Retry</button>
          </p>
        )}
        {data ? (
          <LedgerContext.Provider
            value={{ data, user, request, save, refresh }}
          >
            <Routes>
              <Route path="/" element={<Groups />} />
              <Route path="/new" element={<NewGroup />} />
              <Route path="/join" element={<Join />} />
              <Route path="/invite/:code" element={<Join />} />
              <Route path="/you" element={<Account />} />
              <Route path="/g/:gid" element={<GroupScreen />} />
              <Route path="/g/:gid/m/:mid" element={<MemberScreen />} />
              <Route path="/g/:gid/e/:eid" element={<ExpenseScreen />} />
              <Route path="/g/:gid/new" element={<ExpenseForm />} />
              <Route
                path="*"
                element={
                  <p>
                    Page unavailable. <Link to="/">Open groups</Link>
                  </p>
                }
              />
            </Routes>
          </LedgerContext.Provider>
        ) : (
          !error && <p role="status">Loading your groups…</p>
        )}
      </main>
    </>
  );
}
function App() {
  const [ready, setReady] = useState(false),
    [user, setUser] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let stop: (() => void) | undefined,
      active = true;
    async function boot() {
      try {
        if (!window.Clerk)
          await new Promise<void>((resolve, reject) => {
            const tag = document.querySelector(
              "script[data-clerk-publishable-key]",
            )!;
            const timeout = setTimeout(
              () => reject(new Error("Sign-in could not load.")),
              15000,
            );
            tag.addEventListener(
              "load",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            tag.addEventListener(
              "error",
              () => {
                clearTimeout(timeout);
                reject(new Error("Sign-in could not load."));
              },
              { once: true },
            );
          });
        await window.Clerk.load();
        if (!active) return;
        const sync = () => setUser(window.Clerk.user?.id ?? "");
        sync();
        stop = window.Clerk.addListener(sync);
        setReady(true);
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Sign-in unavailable.");
      }
    }
    void boot();
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  if (!ready)
    return (
      <main>
        <h1>Split</h1>
        <p>{error || "Loading sign-in…"}</p>
        {error && <button onClick={() => location.reload()}>Retry</button>}
      </main>
    );
  return user ? <Ledger key={user} user={user} /> : <SignIn />;
}
document.documentElement.dataset.theme =
  localStorage.getItem("split-theme") ?? "system";
if (location.hostname === "split-api.yoinklabs.dev") {
  location.replace(
    "https://split.yoinklabs.dev" +
      location.pathname +
      location.search +
      location.hash,
  );
} else
  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
