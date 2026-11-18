import { describe, expect, it } from "vitest";
import {
  byNewest,
  isAbort,
  mergeSnapshot,
  singleFlight,
  uniqueByID,
} from "../../web/src/refresh";

const entry = (id: string, createdAt: string, title = id) => ({
  id,
  createdAt,
  title,
});
const snapshot = (
  entries: ReturnType<typeof entry>[],
  groups = [{ id: "g", name: "Buenos Aires Trip" }],
) => ({ userID: "u", groups, entries });

describe("web refresh", () => {
  it("shares one request between overlapping refreshes", async () => {
    let calls = 0;
    let release!: () => void;
    const run = singleFlight(
      () =>
        new Promise<number>((resolve) => {
          calls++;
          release = () => resolve(calls);
        }),
    );
    const a = run(),
      b = run();
    expect(calls).toBe(1);
    release();
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    const c = run();
    expect(calls).toBe(2);
    release();
    await c;
  });

  it("frees the slot after a failure so the next refresh can retry", async () => {
    let fail = true;
    const run = singleFlight(async () => {
      if (fail) throw new Error("offline");
      return "ok";
    });
    await expect(run()).rejects.toThrow("offline");
    fail = false;
    await expect(run()).resolves.toBe("ok");
  });

  it("treats cancellation as silent", () => {
    expect(isAbort(new DOMException("stopped", "AbortError"))).toBe(true);
    expect(isAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbort(new Error("Could not reach Split. Try again."))).toBe(false);
    expect(isAbort(null)).toBe(false);
  });

  it("drops duplicate rows and orders entries stably", () => {
    const day = "2026-11-17T10:00:00Z";
    expect(uniqueByID([{ id: "a" }, { id: "a" }, { id: "b" }]).map((x) => x.id)).toEqual(["a", "b"]);
    const rows = [entry("b", day), entry("a", day), entry("c", "2026-11-18T10:00:00Z")];
    expect([...rows].sort(byNewest).map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect([...rows].reverse().sort(byNewest).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps the same snapshot when a refresh returns identical data", () => {
    const first = mergeSnapshot(null, snapshot([entry("a", "2026-11-17T10:00:00Z"), entry("a", "2026-11-17T10:00:00Z")]));
    expect(first.entries).toHaveLength(1);
    const again = mergeSnapshot(first, JSON.parse(JSON.stringify(first)));
    expect(again).toBe(first);
  });

  it("updates only the rows that changed", () => {
    const first = mergeSnapshot(null, snapshot([entry("a", "2026-11-17T10:00:00Z"), entry("b", "2026-11-16T10:00:00Z")]));
    const next = mergeSnapshot(first, snapshot([entry("b", "2026-11-16T10:00:00Z", "Parrilla dinner"), entry("a", "2026-11-17T10:00:00Z")]));
    expect(next).not.toBe(first);
    expect(next.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(next.entries[0]).toBe(first.entries[0]);
    expect(next.entries[1].title).toBe("Parrilla dinner");
    expect(next.groups[0]).toBe(first.groups[0]);
  });
});
