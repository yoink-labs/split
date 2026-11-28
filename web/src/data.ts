import type { PaymentMethod } from '../../worker/src/paymentTypes';
export type { PaymentMethod } from '../../worker/src/paymentTypes';
import type { Entry } from "../../worker/src/ledger";
import { entryPayers, simplify } from "../../worker/src/ledger";
import { settlementEntry } from "../../worker/src/exchange";

export {
  allocate,
  balances,
  currencies,
  entryPayers,
  simplify,
} from "../../worker/src/ledger";
export { itemSplit, itemPortions, grossItems, breakdown } from "../../worker/src/items";
export { settlementEntry } from "../../worker/src/exchange";

export type Expense = Entry & {
  editable: boolean;
  recurrence?: string | null;
  commentCount?: number;
  likeCount?: number;
  likedByMe?: boolean;
};

export interface PaymentProfile {
  venmo?: string;
  paypal?: string;
  mercado?: string;
  alias?: string;
}

export interface Person {
  id: string;
  name: string;
  userID: string | null;
  removed?: boolean;
  avatarURL?: string | null;
  payment?: PaymentProfile;
  paymentMethods?: PaymentMethod[];
  paymentOverride?: PaymentMethod[];
}

export interface Group {
  id: string;
  name: string;
  currency: string;
  kind: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  simplify?: boolean;
  archived?: boolean;
  canDelete?: boolean;
  members: Person[];
  defaultWeights?: Record<string, number>;
  tripRates?: Record<string, number>;
}

export interface Snapshot {
  userID: string;
  avatarURL?: string | null;
  groups: Group[];
  entries: Expense[];
  settlementRequests?: Expense[];
  paymentMethods?: PaymentMethod[];
}

export interface ExpenseComment {
  id: string;
  entryID: string;
  authorUserID: string;
  authorName: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

export interface ActiveInvite {
  id: string;
  kind: "group" | "member";
  memberID: string | null;
  memberName: string | null;
  recipientEmail?: string;
  expiresAt: number;
  url?: string;
  code?: string;
}

type Clerk = {
  load(): Promise<void>;
  user: { id: string; fullName?: string; imageUrl?: string } | null;
  session: { getToken(): Promise<string | null> } | null;
  addListener(cb: () => void): () => void;
  mountSignIn(el: HTMLElement, options: object): void;
  unmountSignIn(el: HTMLElement): void;
  signOut(): Promise<void>;
};

declare global {
  interface Window {
    Clerk: Clerk;
  }
}

export async function api<T>(
  path: string,
  user: string,
  body?: unknown,
  photo = false,
): Promise<T> {
  const token = await window.Clerk.session?.getToken();
  if (!token || user !== window.Clerk.user?.id)
    throw new Error("Sign in to continue.");
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      (await res.json().catch(() => ({}))).error ??
        "Could not reach Split. Try again.",
    );
  if (user !== window.Clerk.user?.id) throw new Error("Your account changed.");
  return photo ? ((await res.blob()) as T) : res.json();
}

export const money = (amount: number, currency: string) =>
  currency +
  " " +
  (amount / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const moneyCompact = (amount: number, currency: string) => {
  const sym: Record<string, string> = {
    USD: "$",
    CAD: "CA$",
    AUD: "A$",
    EUR: "€",
    GBP: "£",
    MXN: "MX$",
    BRL: "R$",
    ARS: "ARS ",
  };
  const prefix = sym[currency] ?? currency + " ";
  return (
    prefix +
    (amount / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
};

export const dateText = (stamp: string) =>
  new Date(stamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export const dayHeading = (isoDay: string) => {
  const [y, m, d] = isoDay.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
};

export const monthHeading = (isoMonth: string) => {
  const [y, m] = isoMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
};

export const tripRangeText = (start?: string | null, end?: string | null) => {
  if (!start && !end) return "";
  if (start && !end) return "From " + dayHeading(start);
  if (!start && end) return "Until " + dayHeading(end);
  const s = start!.split("-").map(Number);
  const e = end!.split("-").map(Number);
  const sd = new Date(s[0], s[1] - 1, s[2]);
  const ed = new Date(e[0], e[1] - 1, e[2]);
  const sameYear = s[0] === e[0];
  const sameMonth = sameYear && s[1] === e[1];
  const left = sd.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  if (sameMonth) return `${left} – ${e[2]}, ${e[0]}`;
  const right = ed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${left} – ${right}`;
};

export const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const memberName = (g: Group, id: string) =>
  g.members.find((p) => p.id === id)?.name ?? "Group member";

export const memberPath = (g: Group, id: string) => "/g/" + g.id + "/m/" + id;
export const entryPath = (e: Expense) => "/g/" + e.groupID + "/e/" + e.id;

export function minor(input: string) {
  if (!/^\d{1,10}(?:[.,]\d{0,2})?$/.test(input.trim()))
    throw new Error("Enter an amount with up to two decimal places.");
  const [int, fraction = ""] = input.trim().replace(",", ".").split(".");
  const value = Number(int) * 100 + Number(fraction.padEnd(2, "0"));
  if (value > 100_000_000_000) throw new Error("Amount exceeds the limit.");
  return value;
}

export function membersGroups(groups: Group[], group: Group, member: Person) {
  return groups.flatMap((g) => {
    const p = member.userID
      ? g.members.find((s) => s.userID === member.userID)
      : g.id === group.id
        ? g.members.find((s) => s.id === member.id)
        : undefined;
    return p ? [{ group: g, person: p }] : [];
  });
}

export function memberEntries(
  entries: Expense[],
  groupID: string,
  seat: string,
) {
  return entries
    .filter(
      (e) =>
        e.groupID === groupID &&
        (entryPayers(e).some((p) => p.memberID === seat) ||
          e.splits.some((s) => s.memberID === seat)),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}

/** Pairwise unsimplified debts for a currency, useful for comparing raw vs simplified flows. */
export function rawTransfers(entries: Expense[], currency: string) {
  const pair = new Map<string, number>();
  const add = (from: string, to: string, amount: number) => {
    if (from === to || amount <= 0) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = a + "|" + b;
    const signed = from < to ? amount : -amount;
    pair.set(key, (pair.get(key) ?? 0) + signed);
  };
  for (const raw of entries) {
    if (raw.handled) continue;
    const e = settlementEntry(raw);
    if (e.currency !== currency) continue;
    const payers = entryPayers(e);
    const total = e.amount;
    if (total <= 0) continue;
    if (payers.length === 1) {
      const payer = payers[0].memberID;
      for (const s of e.splits) add(s.memberID, payer, s.amount);
    } else {
      // Proportional allocation of each split across payers
      const net: Record<string, number> = {};
      for (const p of payers) net[p.memberID] = (net[p.memberID] ?? 0) + p.amount;
      for (const s of e.splits) net[s.memberID] = (net[s.memberID] ?? 0) - s.amount;
      for (const t of simplify(net)) add(t.from, t.to, t.amount);
    }
  }
  const out: { from: string; to: string; amount: number }[] = [];
  for (const [key, val] of pair) {
    if (!val) continue;
    const [a, b] = key.split("|");
    out.push(val > 0 ? { from: a, to: b, amount: val } : { from: b, to: a, amount: -val });
  }
  return out.sort((x, y) => y.amount - x.amount);
}

/** Generate a clean RFC-4180 CSV export for a group's full ledger. */
export function buildGroupCSV(g: Group, entries: Expense[]): string {
  const esc = (v: string | number | undefined | null) => {
    const text = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
    const s = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text) && typeof v === "string" ? "'" + text : text;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = [
    "Date",
    "Type",
    "Title",
    "Category",
    "Notes",
    "Original Currency",
    "Original Amount",
    "FX Rate",
    "Settlement Currency",
    "Settlement Amount",
    "Paid By",
    "Split With",
    "Expense Status",
    ...g.members.map((m) => m.name),
  ];
  const rows = entries
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e) => {
      const se = settlementEntry(e);
      const payers = entryPayers(se);
      const payerText = payers
        .map((p) => `${memberName(g, p.memberID)} (${(p.amount / 100).toFixed(2)})`)
        .join("; ");
      const memberNets = g.members.map((m) => {
        const paid = payers.filter((p) => p.memberID === m.id).reduce((s, p) => s + p.amount, 0);
        const share = se.splits.find((s) => s.memberID === m.id)?.amount ?? 0;
        const net = e.handled ? 0 : paid - share;
        return net / 100;
      });
      return [
        e.createdAt.slice(0, 10),
        e.kind,
        e.title,
        e.category ?? "",
        e.notes ?? "",
        e.currency,
        (e.amount / 100).toFixed(2),
        e.exchange ? (e.exchange.rateE8 / 1e8).toFixed(6) : "",
        se.currency,
        (se.amount / 100).toFixed(2),
        payerText,
        se.splits.map((split) => `${memberName(g, split.memberID)} (${(split.amount / 100).toFixed(2)})`).join("; "),
        e.handled ? "Handled" : "",
        ...memberNets,
      ];
    });
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export async function receiptPhoto(file: File) {
  if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024)
    throw new Error("Choose an image under 25 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    for (const size of [1600, 1200, 900, 640]) {
      const ratio = Math.min(1, size / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * ratio));
      canvas.height = Math.max(1, Math.round(img.height * ratio));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.83, 0.65, 0.45]) {
        const data = canvas.toDataURL("image/jpeg", quality).split(",")[1];
        if (data && data.length <= 327680)
          return { id: crypto.randomUUID(), data };
      }
    }
    throw new Error("Choose a smaller photo.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const shortDate = (stamp: string) => {
  const d = new Date(stamp);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
};

/**
 * Transfers for a group with "simplify debts" off, matching the iOS `Ledger.directPlan`:
 * debtors and creditors in id order are paired greedily, without the fewest-transfers search.
 */
export function directPlan(balance: Record<string, number>) {
  const remaining = { ...balance };
  const ids = Object.keys(remaining).filter((id) => remaining[id]).sort();
  const debtors = ids.filter((id) => remaining[id] < 0);
  const creditors = ids.filter((id) => remaining[id] > 0);
  const out: { from: string; to: string; amount: number }[] = [];
  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    const from = debtors[d], to = creditors[c];
    const amount = Math.min(-remaining[from], remaining[to]);
    if (amount > 0) {
      out.push({ from, to, amount });
      remaining[from] += amount;
      remaining[to] -= amount;
    }
    if (remaining[from] === 0) d++;
    if (remaining[to] === 0) c++;
  }
  return out;
}

/** Suggested transfers for one currency, honoring the group's "simplify debts" setting. */
export const groupTransfers = (g: Group, balance: Record<string, number>) =>
  g.simplify === false ? directPlan(balance) : simplify(balance);
