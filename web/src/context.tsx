import {
  createContext,
  useContext,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Snapshot } from "./data";

export interface LedgerContextValue {
  data: Snapshot;
  user: string;
  userName: string;
  userAvatar?: string | null;
  demo: boolean;
  exitDemo?: () => void;
  request: <T>(path: string, body?: unknown, photo?: boolean) => Promise<T>;
  save: (path: string, body: unknown) => Promise<void>;
  refresh: () => Promise<void>;
  checking: boolean;
}

export const LedgerContext = createContext<LedgerContextValue | null>(null);

export function useLedger() {
  return useContext(LedgerContext)!;
}

export function Form({
  children,
  submit,
  label,
  footer,
  destructive = false,
  cancel,
}: {
  children?: ReactNode;
  submit: (form: FormData) => Promise<void>;
  label: string;
  footer?: ReactNode;
  destructive?: boolean;
  cancel?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const values = new FormData(e.currentTarget);
    try {
      await submit(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="form-stack">
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }} className="form-stack">
        {children}
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        <div className={footer ? "expense-save" : cancel ? "form-actions" : undefined}>
          {footer}
          {cancel && <button className="btn" type="button" onClick={cancel} autoFocus>Cancel</button>}
          <button className={destructive ? "btn btn-danger" : "btn btn-primary"} type="submit">
            {busy ? (destructive ? "Deleting…" : "Saving…") : label}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export const value = (f: FormData, key: string) =>
  String(f.get(key) ?? "").trim();
