import type { Entry } from "../../worker/src/ledger";
export {
  allocate,
  balances,
  currencies,
  simplify,
} from "../../worker/src/ledger";
export { itemSplit, grossItems, breakdown } from "../../worker/src/items";
export { settlementEntry } from "../../worker/src/exchange";
export type Expense = Entry & { editable: boolean };
export interface Person {
  id: string;
  name: string;
  userID: string | null;
}
export interface Group {
  id: string;
  name: string;
  currency: string;
  kind: string;
  members: Person[];
  defaultWeights?: Record<string, number>;
}
export interface Snapshot {
  userID: string;
  groups: Group[];
  entries: Expense[];
}
type Clerk = {
  load(): Promise<void>;
  user: { id: string; fullName?: string } | null;
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
export const dateText = (stamp: string) =>
  new Date(stamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
        (e.paidBy === seat || e.splits.some((s) => s.memberID === seat)),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
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
/** "Nov 17", or "Nov 17, 2025" outside the current year. */
export const shortDate = (stamp: string) => {
  const d = new Date(stamp);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
};
