import { SplitLogo } from "./ui";
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
import { LocalAIScreen, type Connection } from "./ai";
import {
  api,
  itemSplit,
  type ActiveInvite,
  type Expense,
  type ExpenseComment,
  type Group,
  type Snapshot,
  type PaymentMethod,
} from "./data";
import { createDemoState, DEMO_USER } from "./demo";
import { ExpenseForm } from "./expense";
import { ConverterScreen } from "./fxui";
import { GroupSummary } from "./groupSummary";
import { GroupWorkspace } from "./groupWorkspace";
import { adjustedEntry, confirmed } from "../../worker/src/refundMath";
import { isAbort, mergeSnapshot, singleFlight } from "./refresh";
import {
  Account,
  HomeOverview,
  Join,
  MemberScreen,
  NewGroup,
} from "./screens";
import { AppShell } from "./shell";
import { SplitwiseImport } from "./splitwise";
import { importGroupID, type ImportRow } from "../../worker/src/splitwiseCsv";
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
        <Route path="/g/:gid/summary" element={<GroupSummary />} />
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
  const latestImportData = useRef(data);
  useEffect(() => { latestImportData.current = data; }, [data]);
  const commentsRef = useRef<Record<string, ExpenseComment[]>>(initial.comments);
  const claimEmails = useRef<Record<string, Record<string, string>>>({});
  const invitesRef = useRef<Record<string, ActiveInvite[]>>(initial.invites);
  const photosRef = useRef<Record<string, Blob>>(initial.photos);
  const connections = useRef<Connection[]>([{
    id: "demo-computer", name: "Sample laptop", created_at: Date.now() - 3 * 86_400_000,
    last_used: Date.now() - 600_000, scope: "cli", is_remote: 0,
  }]);

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
      if (path === "/v1/device/tokens" && body === undefined) return connections.current as T;
      if (path === "/v1/device/tokens" || path === "/v1/device/approve") {
        const isRemote = path === "/v1/device/tokens";
        const name = isRemote ? (body as { name: string }).name : "Sample computer";
        if (!name) throw new Error("Enter a token name.");
        const connection: Connection = {
          id: crypto.randomUUID(), name, created_at: Date.now(), last_used: null,
          scope: "cli", is_remote: isRemote ? 1 : 0,
        };
        connections.current = [connection, ...connections.current];
        return (isRemote ? { connection, token: `demo-${connection.id}` } : { name }) as T;
      }
      if (path === "/v1/device/review") return { name: "Sample computer" } as T;
      if (path === "/v1/device/revoke") {
        const { id } = body as { id: string };
        connections.current = connections.current.filter((connection) => connection.id !== id);
        return { revoked: true } as T;
      }

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
        return { url, code, id: inv.id } as T;
      }

      const revMatch = path.match(/^\/v1\/groups\/([\w-]+)\/invites\/([^/]+)\/revoke$/);
      if (revMatch) {
        const [, gid, id] = revMatch;
        invitesRef.current[gid] = (invitesRef.current[gid] ?? []).filter((x) => x.id !== id);
        return { ok: true } as T;
      }

      if (path === "/v1/import/splitwise" && body) {
        const { group, groupID, people, rows } = body as {
          group?: Omit<Group, "members">;
          groupID?: string;
          people: { name: string; displayName?: string; memberID?: string; userID?: string; me?: boolean }[];
          rows: ImportRow[];
        };
        const current = latestImportData.current;
        const id = group?.id ?? groupID ?? "";
        const existing = current.groups.find((g) => g.id === id);
        const target = existing ?? (group && { ...group, members: [] });
        if (!target) throw new Error("Group unavailable.");
        const members = [...target.members];
        const resolved = await Promise.all(people.map(async (person) => {
          const userID = person.me ? DEMO_USER : person.userID;
          const memberID = person.memberID ?? await importGroupID(person.me ? "me" : person.name.toLowerCase(), id);
          return { ...person, userID, memberID };
        }));
        const imported = resolved.map((person) => {
          const { userID, memberID } = person;
          const match = members.findIndex((member) => member.id === memberID || (userID && member.userID === userID));
          if (match === -1) {
            const account = userID && current.groups.flatMap((g) => g.members).find((member) => member.userID === userID);
            members.push({ id: memberID, userID: userID ?? null, name: person.displayName ?? (account ? account.name : person.name) });
          } else if (!members[match].userID) {
            members[match] = { ...members[match], name: person.displayName ?? members[match].name, userID: userID ?? null };
          }
          return { name: person.name, memberID: match < 0 ? memberID : members[match].id };
        });
        const memberIDs = new Map(imported.map((person) => [person.name, person.memberID]));
        const existingEntries = new Set(current.entries.map((entry) => entry.id));
        const copies = new Map<string, number>();
        const entries = await Promise.all(rows.map(async (row): Promise<Expense> => {
          const fingerprint = JSON.stringify({ ...row, exchange: undefined });
          const ordinal = copies.get(fingerprint) ?? 0;
          copies.set(fingerprint, ordinal + 1);
          const entryID = await importGroupID(JSON.stringify([fingerprint, ordinal]), id);
          const shares = (parts: ImportRow["splits"]) => parts.map((part) => ({ memberID: memberIDs.get(part.name)!, amount: part.amount }));
          return {
            id: entryID, groupID: target.id, title: row.title, kind: row.payment ? "settlement" : "expense",
            paidBy: memberIDs.get(row.payer)!, amount: row.amount, currency: row.currency, category: row.category,
            createdAt: row.day + "T12:00:00Z", splitMode: "exact", editable: true, splits: shares(row.splits),
            ...(row.payers ? { payers: shares(row.payers) } : {}),
            ...(row.exchange ? { exchange: row.exchange } : {}),
          };
        }));
        const inserted = entries.filter((entry) => !existingEntries.has(entry.id));
        const next = {
          ...current,
          groups: [{ ...target, members }, ...current.groups.filter((g) => g.id !== id)],
          entries: [...inserted, ...current.entries],
        };
        latestImportData.current = next;
        setData(next);
        return { groupID: target.id, created: !existing, inserted: inserted.length, duplicates: rows.length - inserted.length, people: imported } as T;
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
        setData((prev) => ({ ...prev, groups: [{ ...b, canDelete: true, members: b.members.map((m) => m.userID === DEMO_USER ? { ...m, paymentMethods: prev.paymentMethods } : m) }, ...prev.groups] }));
        return { ok: true } as T;
      }

      // Update group
      const updGroup = path.match(/^\/v1\/groups\/([\w-]+)\/update$/);
      if (updGroup && body) {
        const gid = updGroup[1];
        const b = body as Partial<Group>;
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((g) => g.id === gid
            ? { ...g, ...b, tripRates: b.currency && b.currency !== g.currency ? undefined : g.tripRates }
            : g),
        }));
        return { ok: true } as T;
      }

      const tripRate = path.match(/^\/v1\/groups\/([\w-]+)\/trip-rate$/);
      if (tripRate && body) {
        const { currency, rateE8 } = body as { currency: string; rateE8: number | null };
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((group) => {
            if (group.id !== tripRate[1]) return group;
            const tripRates = { ...group.tripRates };
            if (rateE8 === null) delete tripRates[currency];
            else tripRates[currency] = rateE8;
            return { ...group, tripRates };
          }),
        }));
        return { ok: true } as T;
      }

      const deleteGroup = path.match(/^\/v1\/groups\/([\w-]+)\/delete$/);
      if (deleteGroup && body) {
        const id = deleteGroup[1];
        if (!data.groups.find((group) => group.id === id)?.canDelete) throw new Error("Only the group creator can delete this group.");
        setData((prev) => ({
          ...prev,
          groups: prev.groups.filter((group) => group.id !== id),
          entries: prev.entries.filter((entry) => entry.groupID !== id),
          settlementRequests: prev.settlementRequests?.filter((entry) => entry.groupID !== id),
        }));
        delete invitesRef.current[id];
        return { ok: true } as T;
      }

      const payMatch = path.match(/^\/v1\/groups\/([\w-]+)\/payment-profile$/);
      if ((payMatch || path === "/v1/profile/payment-methods") && body) {
        const { methods } = body as { methods: PaymentMethod[] | null };
        setData((prev) => {
          const paymentMethods = payMatch ? prev.paymentMethods : methods ?? [];
          return {
            ...prev,
            paymentMethods,
            groups: prev.groups.map((group) => payMatch && group.id !== payMatch[1] ? group : {
              ...group,
              members: group.members.map((person) => {
                if (person.userID !== DEMO_USER) return person;
                const paymentOverride = payMatch ? methods ?? undefined : person.paymentOverride;
                return { ...person, paymentOverride, paymentMethods: paymentOverride ?? paymentMethods ?? [] };
              }),
            }),
          };
        });
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
      if (addMem && body === undefined) {
        const group = data.groups.find((item) => item.id === addMem[1]);
        return { claimEmails: group?.members.flatMap((member) => {
          const email = claimEmails.current[addMem[1]]?.[member.id];
          return email && !member.removed && !member.userID ? [{ memberID: member.id, email }] : [];
        }) ?? [] } as T;
      }
      const editEmail = path.match(/^\/v1\/groups\/([\w-]+)\/members\/([\w-]+)\/email$/);
      if (editEmail && body) {
        const [, gid, mid] = editEmail;
        const { email } = body as { email: string | null };
        const emails = claimEmails.current[gid] ??= {};
        const normalized = email?.toLowerCase();
        if (emails[mid] !== normalized) {
          if (normalized) emails[mid] = normalized;
          else delete emails[mid];
          invitesRef.current[gid] = (invitesRef.current[gid] ?? []).filter((invite) => invite.memberID !== mid);
        }
        return { id: mid, email } as T;
      }
      if (addMem && body) {
        const gid = addMem[1];
        const b = body as { id: string; name: string; userID?: string; email?: string };
        if (b.email) (claimEmails.current[gid] ??= {})[b.id] = b.email.toLowerCase();
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
      const paymentResponse = path.match(/^\/v1\/settlements\/([\w-]+)\/(approve|decline|cancel)$/);
      if (paymentResponse) {
        const [, id, action] = paymentResponse;
        const entry = data.settlementRequests?.find((payment) => payment.id === id);
        const group = data.groups.find((item) => item.id === entry?.groupID);
        const me = group?.members.find((member) => member.userID === DEMO_USER);
        if (!entry || !me || (action === "cancel" ? entry.paidBy !== me.id : entry.splits[0]?.memberID !== me.id)) {
          throw new Error("This payment request is unavailable.");
        }
        setData((prev) => ({
          ...prev,
          settlementRequests: prev.settlementRequests?.filter((payment) => payment.id !== id),
          entries: action === "approve" ? [entry, ...prev.entries] : prev.entries,
        }));
        return { ok: true } as T;
      }

      if (path === "/v1/settlements" && body) {
        const payment = body as Expense;
        setData((prev) => ({
          ...prev,
          settlementRequests: [payment, ...(prev.settlementRequests ?? []).filter((entry) => entry.id !== payment.id)],
        }));
        return { ok: true, status: "pending" } as T;
      }
      if (path === "/v1/entries" && body) {
        const b = body as Expense & { photos?: { id: string; data: string }[] };
        const receiptIDs = storePhotos(b.photos);
        const { photos: _p, ...rest } = b;
        const next: Expense = { ...rest, editable: true, ...(receiptIDs.length ? { receiptIDs } : {}) };
        setData((prev) => ({ ...prev, entries: [next, ...prev.entries] }));
        return { ok: true } as T;
      }

      const handled = path.match(/^\/v1\/entries\/([\w-]+)\/handled$/);
      if (handled && body) {
        const setting = (body as { handled: boolean }).handled;
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((entry) => entry.id === handled[1] ? { ...entry, handled: setting || undefined } : entry),
        }));
        return { ok: true } as T;
      }

      // Pending entries: mark, confirm, adjust, or confirm with a refund
      const pendingMatch = path.match(/^\/v1\/entries\/([\w-]+)\/(pending|resolve)$/);
      if (pendingMatch && body) {
        const [, eid, action] = pendingMatch;
        const b = body as { pending?: boolean; note?: string; action?: string; amount?: number; refund?: Expense };
        const current = data.entries.find((entry) => entry.id === eid);
        if (!current) throw new Error("Expense unavailable.");
        const next = action === "pending"
          ? (b.pending ? { ...current, pending: true, ...(b.note ? { pendingNote: b.note } : {}) } : confirmed(current))
          : b.action === "adjust" ? adjustedEntry(current, b.amount!) : confirmed(current);
        if (!b.pending) delete next.pendingNote;
        setData((prev) => ({
          ...prev,
          entries: [
            ...(action === "resolve" && b.action === "refund" && b.refund ? [{ ...b.refund, editable: true }] : []),
            ...prev.entries.map((entry) => entry.id === eid ? next : entry),
          ],
        }));
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
    [data.groups, data.entries, data.settlementRequests],
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
    const search = new URLSearchParams(location.search);
    if (search.get("demo") === "1") search.delete("demo");
    window.Clerk.mountSignIn(el, {
      routing: "virtual",
      fallbackRedirectUrl: location.pathname + (location.pathname === "/ai" && search.size ? `?${search}` : ""),
    });
    return () => window.Clerk.unmountSignIn(el);
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SplitLogo size={32} />
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Split</h1>
            <p className="muted" style={{ fontSize: 12.5 }}>Split expenses</p>
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

function WorkspaceLoading() {
  const { pathname } = useLocation();
  const composing = /\/(new|edit)$/.test(pathname);
  return (
    <div className="workspace-loading" role="status" aria-label="Loading your workspace">
      <div className="loading-sidebar" aria-hidden="true">
        <SplitLogo size={28} />
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="loading-block" />)}
      </div>
      <div className="main-content" aria-hidden="true">
        <div className="loading-title loading-block" />
        <div className="loading-nav loading-block" />
        <div className={composing ? "loading-content expense-layout" : "loading-content"}>
          {Array.from({ length: composing ? 2 : 5 }, (_, index) => (
            <div className="card" key={index}>
              <div className="loading-block" /><div className="loading-block" /><div className="loading-block" />
            </div>
          ))}
        </div>
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
    return error ? (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <p className="error-banner" role="alert">{error}</p>
          <button className="btn btn-primary" disabled={checking} onClick={() => void refresh()}>
            {checking ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    ) : <WorkspaceLoading />;
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
