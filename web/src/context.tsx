import {
  createContext,
  useContext,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Snapshot } from "./data";
export const LedgerContext = createContext<{
  data: Snapshot;
  user: string;
  request: <T>(path: string, body?: unknown, photo?: boolean) => Promise<T>;
  save: (path: string, body: unknown) => Promise<void>;
  refresh: () => Promise<void>;
} | null>(null);
export function useLedger() {
  return useContext(LedgerContext)!;
}
export function Form({
  children,
  submit,
  label,
}: {
  children: ReactNode;
  submit: (form: FormData) => Promise<void>;
  label: string;
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
    <form onSubmit={send}>
      <fieldset disabled={busy}>
        {children}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" type="submit">
          {busy ? "Saving…" : label}
        </button>
      </fieldset>
    </form>
  );
}
export const value = (f: FormData, key: string) =>
  String(f.get(key) ?? "").trim();
