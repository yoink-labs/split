import { Picker } from "./picker";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useLedger, value } from "./context";

export interface Connection {
  id: string;
  name: string;
  created_at: number;
  last_used: number | null;
  scope: "cli" | "finance";
  is_remote: 0 | 1;
}

interface NewToken {
  connection: Connection;
  token: string;
}

type AccessAction = "pair" | "create";
type Page = "setup" | "access";
type Client = "terminal" | "claude-desktop" | "claude-code" | "cursor" | "codex" | "remote";
type RemoteClient = "http" | "cursor" | "codex";

const pages = [
  { id: "setup", label: "Setup" },
  { id: "access", label: "Manage access" },
] as const;

const clients = [
  { id: "terminal", label: "Terminal" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "remote", label: "Remote MCP" },
] as const;

const mcpURL = "https://split-api.yoinklabs.dev/mcp";
const splitPath = "/path/to/split";
const jsonConfig = (server: object) => JSON.stringify({ mcpServers: { split: server } }, null, 2);
const localJSON = jsonConfig({ command: splitPath, args: ["mcp"] });

const localCommands = {
  "claude-desktop": { file: "claude_desktop_config.json", code: localJSON, language: "JSON" },
  "claude-code": {
    file: "Terminal", code: 'claude mcp add split -- "$(command -v split)" mcp', language: "Shell",
  },
  cursor: { file: "~/.cursor/mcp.json", code: localJSON, language: "JSON" },
  codex: {
    file: "~/.codex/config.toml",
    code: `[mcp_servers.split]\ncommand = "${splitPath}"\nargs = ["mcp"]`,
    language: "TOML",
  },
};

const remoteCommands = {
  http: { file: "Streamable HTTP", code: `${mcpURL}\nAuthorization: Bearer <SPLIT_TOKEN>`, language: "HTTP" },
  cursor: {
    file: "~/.cursor/mcp.json",
    code: jsonConfig({ url: mcpURL, headers: { Authorization: "Bearer ${env:SPLIT_TOKEN}" } }),
    language: "JSON",
  },
  codex: {
    file: "~/.codex/config.toml",
    code: `[mcp_servers.split]\nurl = "${mcpURL}"\nbearer_token_env_var = "SPLIT_TOKEN"`,
    language: "TOML",
  },
};

function Tabs<T extends string>({ id, label, options, selected, select }: {
  id: string;
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  selected: T;
  select: (id: T) => void;
}) {
  return (
    <div className="ai-tabs" role="tablist" aria-label={label}>
      {options.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          id={`${id}-${tab.id}`}
          role="tab"
          aria-controls={`${id}-panel`}
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => select(tab.id)}
          onKeyDown={(event) => {
            const last = options.length - 1;
            let next: number;
            switch (event.key) {
              case "ArrowLeft": next = index === 0 ? last : index - 1; break;
              case "ArrowRight": next = index === last ? 0 : index + 1; break;
              case "Home": next = 0; break;
              case "End": next = last; break;
              default: return;
            }
            event.preventDefault();
            const nextID = options[next].id;
            select(nextID);
            document.getElementById(`${id}-${nextID}`)?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function CodeBlock({ code, label, language, copyLabel = "Copy" }: {
  code: string;
  label: string;
  language?: string;
  copyLabel?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <strong>{label}</strong>
        <div className="ai-actions">
          {language && <span className="muted">{language}</span>}
          <button className="btn btn-xs" type="button" onClick={copy}>
            {copyState === "copied" ? "Copied" : copyLabel}
          </button>
        </div>
      </div>
      <pre className="mono" tabIndex={0} aria-label={label}><code>{code}</code></pre>
      <span role="status" className={copyState === "error" ? "ai-copy-error" : "ai-sr-only"}>
        {copyState === "error" ? "Couldn’t copy. Select the text to copy it manually." : copyState === "copied" ? "Copied to clipboard." : ""}
      </span>
    </div>
  );
}

function Setup({ openAccess }: { openAccess: (action: AccessAction) => void }) {
  const [client, setClient] = useState<Client>("terminal");
  const [remote, setRemote] = useState<RemoteClient>("http");
  const id = useId();

  return (
    <section className="card ai-setup">
      <Tabs<Client> id={id} label="Client setup" options={clients} selected={client} select={setClient} />
      <div className="ai-setup-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${client}`}>
        {client === "terminal" ? (
          <>
            <p>Run these commands on macOS or Linux with Homebrew.</p>
            <CodeBlock label="Terminal" language="Shell" code={"brew install yoink-labs/tap/split\nsplit login"} />
            <p>Use the code from your terminal to{" "}
              <button className="ai-link" type="button" onClick={() => openAccess("pair")}>pair your computer</button>.
            </p>
          </>
        ) : client === "remote" ? (
          <>
            <div className="ai-access-head">
              <p><button className="ai-link" type="button" onClick={() => openAccess("create")}>Create a token</button>{" "}
                for a client that accepts a bearer token.</p>
              <div className="ai-format">
                Config format
                <Picker label="Config format" value={remote} onChange={(selected) => setRemote(selected as RemoteClient)} options={[{ value: "http", label: "URL and header" }, { value: "cursor", label: "Cursor JSON" }, { value: "codex", label: "Codex TOML" }]} />
              </div>
            </div>
            <CodeBlock key={remote} label={remoteCommands[remote].file} {...remoteCommands[remote]} />
            <p className="muted">{remote === "http"
              ? <>Use the URL and replace <code className="mono">&lt;SPLIT_TOKEN&gt;</code> with your token.</>
              : <>Set <code className="mono">SPLIT_TOKEN</code> in the environment that launches {remote === "cursor" ? "Cursor" : "Codex"}, then add the entry to your config.</>}</p>
          </>
        ) : (
          <>
            <p>First <button className="ai-link" type="button" onClick={() => {
              setClient("terminal");
              document.getElementById(`${id}-terminal`)?.focus();
            }}>install and sign in to Split</button> on this computer.</p>
            <CodeBlock key={client} label={localCommands[client].file} {...localCommands[client]} />
            {client === "claude-code" ? (
              <p className="muted">Run the command in your project, then open <code className="mono">/mcp</code> in Claude Code.</p>
            ) : (
              <p className="muted">
                Add the entry to {client === "claude-desktop" ? "the config under Settings → Developer → Edit Config" : "your config"}.
                Replace <code className="mono">{splitPath}</code> with the output of <code className="mono">command -v split</code>, then restart the app.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const formatDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Access({ initialAction }: { initialAction: AccessAction | null }) {
  const { request, demo } = useLedger();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [action, setAction] = useState<AccessAction | null>(initialAction);
  const [review, setReview] = useState<{ name: string; scope?: "finance"; code: string } | null>(null);
  const [revoke, setRevoke] = useState<Connection | null>(null);
  const [issued, setIssued] = useState<NewToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [status, setStatus] = useState("");
  const [code, setCode] = useState("");
  const [approvedAt, setApprovedAt] = useState(0);
  const normalizedCode = code.replace(/[- ]/g, "").toUpperCase();
  const refreshID = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshID.current;
    setListError("");
    try {
      const next = await request<Connection[]>("/v1/device/tokens");
      if (refreshID.current === id) setConnections(next);
    } catch (err) {
      if (refreshID.current === id) setListError(err instanceof Error ? err.message : "Couldn’t load connections.");
    }
  }, [request]);

  useEffect(() => {
    void refresh();
    return () => { refreshID.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!approvedAt) return;
    // The paired client exchanges its approved code on its next poll.
    const timer = window.setTimeout(refresh, 5500);
    return () => window.clearTimeout(timer);
  }, [approvedAt, refresh]);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function showAction(next: AccessAction | null) {
    setAction(next);
    setReview(null);
    setCode("");
    setRevoke(null);
    setError("");
    setStatus("");
  }

  function submitPair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalizedCode.length !== 8) return;
    void run(async () => {
      const result = await request<{ name: string; scope?: "finance" }>("/v1/device/review", { code: normalizedCode });
      setReview({ ...result, code: normalizedCode });
    });
  }

  function approve() {
    if (!review) return;
    void run(async () => {
      await request("/v1/device/approve", { code: review.code });
      showAction(null);
      setStatus("Approved. Return to the app that gave you the code.");
      setApprovedAt(Date.now());
      await refresh();
    });
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = value(new FormData(event.currentTarget), "name");
    void run(async () => {
      const result = await request<NewToken>("/v1/device/tokens", { name });
      showAction(null);
      setIssued(result);
      setConnections((previous) => [result.connection, ...(previous ?? [])]);
      await refresh();
    });
  }

  function revokeAccess(connection: Connection) {
    void run(async () => {
      await request("/v1/device/revoke", { id: connection.id });
      setRevoke(null);
      setConnections((previous) => previous?.filter((item) => item.id !== connection.id) ?? null);
      setStatus(`Access revoked for ${connection.name}.`);
      await refresh();
    });
  }

  return (
    <section className="card card-pad ai-access">
      <div className="ai-access-head">
        <h2>Connections</h2>
        <div className="ai-actions">
          <button className="btn btn-sm" type="button" disabled={busy || !!issued}
            onClick={() => showAction("pair")}>Pair a computer</button>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy || !!issued}
            onClick={() => showAction("create")}>Create token</button>
        </div>
      </div>
      {action === "pair" && (
        <div className="ai-access-box">
          {review ? (
            <>
              <p>{review.scope === "finance"
                ? <>Allow <strong>{review.name}</strong> to view your shares, payments, and receipts?</>
                : <>Allow <strong>{review.name}</strong> to read and change your Split groups and expenses?</>}</p>
              <div className="ai-actions">
                <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={approve}>Approve</button>
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => showAction(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <form onSubmit={submitPair} className="ai-access-form">
              <label className="field">
                Pairing code
                <input className="input mono" name="code" placeholder="ABCD-EFGH" autoComplete="off"
                  value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} disabled={busy} autoFocus />
              </label>
              <div className="ai-actions">
                <button className="btn btn-primary btn-sm" disabled={busy || normalizedCode.length !== 8}>Review</button>
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => showAction(null)}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
      {action === "create" && (
        <div className="ai-access-box">
          <p>Remote MCP tokens let a client read and change your Split groups and expenses.</p>
          <form onSubmit={create} className="ai-access-form">
            <label className="field">
              Token name
              <input className="input" name="name" placeholder="e.g. Codex on my laptop" maxLength={80}
                required autoComplete="off" disabled={busy} autoFocus />
            </label>
            <div className="ai-actions">
              <button className="btn btn-primary btn-sm" disabled={busy}>Create</button>
              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => showAction(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
      {issued && (
        <div className="ai-access-box">
          <p>{demo ? "This demo token is for preview only." : "Save this token now. It’s only shown once."}</p>
          <CodeBlock code={issued.token} label={issued.connection.name} copyLabel="Copy token" />
          <button className="btn btn-sm ai-done" type="button" onClick={() => setIssued(null)}>Done</button>
        </div>
      )}
      {error && <p role="alert" className="error-banner">{error}</p>}
      {status && <p role="status" className="muted">{status}</p>}
      {listError && <p role="alert" className="error-banner">{listError}</p>}
      {connections?.length ? (
        <ul className="ai-connection-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <div className="ai-connection-row">
                <div>
                  <strong>{connection.name}</strong>
                  <p className="muted">{connection.scope === "finance" ? "Finance (read-only)" : connection.is_remote ? "Remote MCP token" : "CLI & local MCP"}</p>
                  <p className="muted">Created {formatDate(connection.created_at)} · {connection.last_used ? `Last used ${formatDate(connection.last_used)}` : "Never used"}</p>
                </div>
                {revoke?.id !== connection.id && (
                  <button className="btn btn-sm" type="button" aria-label={`Revoke ${connection.name}`} disabled={busy || !!issued}
                    onClick={() => { showAction(null); setRevoke(connection); }}>Revoke</button>
                )}
              </div>
              {revoke?.id === connection.id && (
                <div className="ai-access-box">
                  <p>Revoke access for <strong>{connection.name}</strong>?</p>
                  <div className="ai-actions">
                    <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => revokeAccess(connection)}>Revoke access</button>
                    <button className="btn btn-sm" type="button" disabled={busy} onClick={() => showAction(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : !listError && <p className="muted">{connections ? "No active connections." : "Loading connections…"}</p>}
      <button className="ai-link ai-done" type="button" disabled={busy} onClick={() => void run(refresh)}>
        {listError ? "Retry" : "Refresh connections"}
      </button>
    </section>
  );
}

export function LocalAIScreen() {
  const id = useId();
  const [search, setSearch] = useSearchParams();
  const page: Page = search.get("tab") === "access" ? "access" : "setup";
  const action = search.get("action");
  const initialAction = action === "pair" || action === "create" ? action : null;

  function select(page: Page, next?: AccessAction) {
    const params = new URLSearchParams(search);
    if (page === "access") params.set("tab", page);
    else params.delete("tab");
    if (next) params.set("action", next);
    else params.delete("action");
    setSearch(params, { replace: true });
  }

  return (
    <div className="ai-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">AI &amp; CLI</h1>
          <p className="page-sub">Connect Split to your AI app or terminal.</p>
        </div>
      </header>
      <Tabs<Page> id={id} label="AI and CLI" options={pages} selected={page} select={select} />
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${page}`}>
        <div hidden={page !== "setup"}><Setup openAccess={(next) => select("access", next)} /></div>
        {page === "access" && <Access initialAction={initialAction} />}
      </div>
    </div>
  );
}
