import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { avatarStyleFor, categoryMeta } from "./categories";
import { moneyCompact, type Person } from "./data";

export function SplitLogo({ size = 26 }: { size?: number }) {
  return <img className="brand-mark" src="/icon.png" alt="" width={size} height={size} />;
}

export function Avatar({
  name,
  avatarURL,
  size = 32,
}: {
  name: string;
  avatarURL?: string | null;
  size?: number;
}) {
  const style = avatarStyleFor(name, avatarURL);
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className="avatar"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.37)),
        background: style.bg,
        color: style.fg,
      }}
    >
      {style.image ? <img src={style.image} alt={name} /> : initials}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 5,
  size = 26,
}: {
  people: Pick<Person, "id" | "name" | "avatarURL">[];
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className="avatar-stack">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} avatarURL={p.avatarURL} size={size} />
      ))}
      {extra > 0 && (
        <span
          className="avatar"
          style={{
            width: size,
            height: size,
            fontSize: 10.5,
            background: "var(--surface-2)",
            color: "var(--ink-2)",
          }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

export function CategoryIcon({
  category,
  settlement = false,
}: {
  category?: string | null;
  settlement?: boolean;
}) {
  if (settlement) {
    return (
      <span
        className="cat-icon"
        style={{ background: "var(--pos-soft)", color: "var(--pos)" }}
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 8l4 4-4 4M3 12h18M7 16l-4-4 4-4" />
        </svg>
      </span>
    );
  }
  const meta = categoryMeta(category);
  const paths: Record<string, ReactNode> = {
    utensils: <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />,
    bed: <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />,
    plane: <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />,
    car: <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2M7 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" />,
    cart: <path d="M2 3h2l3.6 10.6a2 2 0 0 0 1.9 1.4h8.4a2 2 0 0 0 1.9-1.4L22 7H6M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
    cup: <path d="M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8Zm3-6v3m4-3v3m4-3v3" />,
    ticket: <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />,
    home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
    bag: <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4ZM3 6h18M16 10a4 4 0 0 1-8 0" />,
    tag: <path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8L12 2ZM7 7h.01" />,
  };
  return (
    <span
      className="cat-icon"
      style={{ background: meta.bg, color: meta.color }}
      title={meta.label}
      aria-hidden="true"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {paths[meta.glyph] ?? paths.tag}
      </svg>
    </span>
  );
}

export function BalanceBadge({
  amount,
  currency,
  display,
  positive = "owed",
  negative = "owes",
}: {
  amount: number;
  currency: string;
  display?: string;
  positive?: string;
  negative?: string;
}) {
  if (display && (amount === 0 || display === "Rate unavailable")) return <span className="tag">{display}</span>;
  if (amount === 0) return <span className="tag">Settled</span>;
  return (
    <span className={amount > 0 ? "tag tag-pos num" : "tag tag-neg num"}>
      {display ?? (amount > 0 ? "+" : "−") + moneyCompact(Math.abs(amount), currency)} {amount > 0 ? positive : negative}
    </span>
  );
}

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
    <section className="card card-pad" style={{ textAlign: "center", padding: "48px 24px" }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{title}</h2>
      <p className="muted" style={{ maxWidth: 420, margin: "0 auto 18px" }}>
        {message}
      </p>
      {action && (
        <Link className="btn btn-primary" to={action.to}>
          {action.label}
        </Link>
      )}
    </section>
  );
}

export const TIP_URL = "https://yoinklabs.dev/tip";

export function TipTheDevs() {
  return (
    <a className="tip-pill" href={TIP_URL} target="_blank" rel="noreferrer">
      <span>♥</span>
      <span>Tip the devs</span>
    </a>
  );
}
