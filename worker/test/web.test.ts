import { projectHomeEntry } from "../../web/src/homeMoney";
import { FxCache } from "../src/fx";
import { parseReceiptText } from "../../web/src/receiptText";
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { validParty, handle } from "../src/index";
import {
  membersGroups,
  memberEntries,
  minor,
  type Expense,
} from "../../web/src/data";

it("accepts only the configured Split web origin and existing native parties", () => {
  const origin = "https://split.yoinklabs.dev";
  for (const p of [undefined, "com.yoinklabs.split", origin])
    expect(validParty(p, origin)).toBe(true);
  for (const p of [
    origin + ".example.com",
    origin + "/",
    "https://unrelated.yoinklabs.dev",
    null,
  ])
    expect(validParty(p, origin)).toBe(false);
});
it("binds a browser snapshot to the caller", async () => {
  const res = await handle(
    new Request("https://split.yoinklabs.dev/v1/snapshot"),
    env,
    "qa-viewer",
  );
  expect(await res.json()).toEqual({
    userID: "qa-viewer",
    paymentMethods: [],
    sharePaymentWithFriends: false,
    groups: [],
    entries: [],
    settlementRequests: [],
    invitationCount: 0,
    discoverable: true,
  });
});
it("scopes placeholder statements by seat and links signed-in seats across shared groups", () => {
  const members = [
    { id: "a", name: "Sam", userID: "user-sam" },
    { id: "b", name: "Sam", userID: null },
  ];
  const group = {
    id: "one",
    name: "Trip",
    currency: "USD",
    kind: "trip",
    members,
  };
  const second = {
    ...group,
    id: "two",
    members: members.map((p) => ({ ...p, id: p.id + "2" })),
  };
  expect(
    membersGroups([group, second], group, members[0]).map((s) => s.person.id),
  ).toEqual(["a", "a2"]);
  expect(
    membersGroups([group, second], group, members[1]).map((s) => s.person.id),
  ).toEqual(["b"]);
  const e: Expense = {
    id: "e",
    groupID: "one",
    paidBy: "b",
    amount: 100,
    currency: "USD",
    title: "Fare",
    splits: [{ memberID: "a", amount: 100 }],
    createdAt: "2026-01-01",
    kind: "expense",
    splitMode: "exact",
    editable: false,
  };
  expect(memberEntries([e, { ...e, groupID: "two" }], "one", "b")).toEqual([e]);
  expect(minor("10,01")).toBe(1001);
});

it("reads receipt prices as minor units without counting summaries twice", () => {
  const result = parseReceiptText([
    "Pizza   $24.00", "Ensalada   1.234,50", "Tax   2.60", "Propina   5,00",
    "SUBTOTAL 1258.50", "TOTAL 1266.10", "Discount -1.00", "Visa card 1266.10"
  ].join("\n"));
  expect(result).toEqual({
    items: [{title:"Pizza",amount:2400},{title:"Ensalada",amount:123450}],
    tax:260, tip:500
  });
});

it("prefers original and frozen home amounts, and caches published historic rates for legacy expenses", async () => {
  const saved = new Map<string, string>();
  const storage = { get: (key: string) => saved.get(key) ?? null, set: (key: string, value: string) => { saved.set(key, value); } };
  let requests = 0;
  const cache = new FxCache(storage, () => 0, async () => {
    requests++;
    return { ok: true, json: async () => ({ base: "EUR", quote: "USD", date: "2026-11-13", rate: 1.1 }) };
  });
  const entry: Expense = {
    id: "dinner01", groupID: "friends01", title: "Dinner", amount: 101, currency: "EUR", paidBy: "person1",
    kind: "expense", splitMode: "equal", createdAt: "2026-11-15T12:00:00Z", editable: true,
    splits: [{ memberID: "person1", amount: 50 }, { memberID: "person2", amount: 51 }],
  };
  cache.setManual("EUR", "USD", 900_000_000);
  expect(projectHomeEntry(entry, "USD", cache)?.amount).toBe(909);
  await Promise.all([cache.historical("EUR", "USD", "2026-11-15"), cache.historical("EUR", "USD", "2026-11-15")]);
  const reloaded = new FxCache(storage, () => 0, async () => { throw new Error("offline"); });
  expect((await reloaded.historical("EUR", "USD", "2026-11-15"))?.rateE8).toBe(110_000_000);
  expect(requests).toBe(1);
  const projected = projectHomeEntry(entry, "USD", reloaded);
  expect(projected?.amount).toBe(111);
  expect(projected?.splits.map((split) => split.amount)).toEqual([55, 56]);
  const frozen = { ...entry, exchange: { target: "USD", rateE8: 200_000_000, date: "2026-11-15", source: "Manual" } };
  expect(projectHomeEntry(frozen, "USD", reloaded)?.amount).toBe(202);
  expect(projectHomeEntry(frozen, "EUR", reloaded)).toMatchObject({ amount: 101, currency: "EUR", exchange: undefined });
  expect(frozen.exchange.rateE8).toBe(200_000_000);
});
