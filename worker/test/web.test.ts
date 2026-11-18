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
    groups: [],
    entries: [],
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
