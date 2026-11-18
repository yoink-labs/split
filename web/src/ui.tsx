// Shared building blocks so every web screen lines up with the iOS app:
// one header card, one row, one empty state and one "+" menu.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { money } from "./data";

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials =
    name
      .split(" ")
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.36) }}
    >
      {initials}
    </span>
  );
}

/** A signed balance with its direction spelled out, never colour alone. */
export function Balance({
  amount,
  currency,
  positive = "gets back",
  negative = "owes",
}: {
  amount: number;
  currency: string;
  positive?: string;
  negative?: string;
}) {
  return (
    <span className="balance">
      <b className={amount > 0 ? "pos" : amount < 0 ? "neg" : undefined}>
        {money(Math.abs(amount), currency)}
      </b>
      <small>{amount === 0 ? "settled" : amount > 0 ? positive : negative}</small>
    </span>
  );
}

/** The standard ledger row: badge, title and detail, value and caption. */
export function Row({
  to,
  badge,
  title,
  detail,
  value,
  caption,
  tone,
}: {
  to: string;
  badge: ReactNode;
  title: string;
  detail: string;
  value: string;
  caption?: string;
  tone?: "pos" | "neg" | "muted";
}) {
  return (
    <Link className="row ledger-row" to={to}>
      {badge}
      <span className="ledger-main">
        <span className="ledger-line">
          <strong>{title}</strong>
          <b className={tone}>{value}</b>
        </span>
        <span className="ledger-line">
          <small>{detail}</small>
          {caption && <small className="caption">{caption}</small>}
        </span>
      </span>
      <span className="chevron" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

export function Badge({ label }: { label: string }) {
  return (
    <span className="badge" aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Centred empty state with at most one primary action. */
export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; to: string };
}) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{message}</p>
      {action && (
        <Link className="primary" to={action.to}>
          {action.label}
        </Link>
      )}
    </section>
  );
}

/** The ink header card used for a group, a person or a statement. */
export function Hero({
  leading,
  title,
  subtitle,
  children,
}: {
  leading: ReactNode;
  title: string;
  subtitle: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="hero">
      <div className="hero-head">
        {leading}
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** A toolbar "+" that opens a short menu of create actions. */
export function AddMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; to: string }[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !root.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button
        className="icon add"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">+</span>
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <Link
              key={item.to}
              role="menuitem"
              to={item.to}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
