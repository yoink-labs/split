import { describe, expect, it } from "vitest";
import { analyze, autoGranularity, bucketKey, bucketRange, drillRows, percents } from "../../web/src/analytics";
import type { Expense } from "../../web/src/data";

const expense = (id: string, day: string, amount: number, splits: [string, number][], extra: Partial<Expense> = {}): Expense => ({
  id, groupID: "g", title: id, amount, currency: "USD", paidBy: splits[0][0],
  splits: splits.map(([memberID, value]) => ({ memberID, amount: value })),
  kind: "expense", splitMode: "exact", createdAt: day + "T12:00:00Z", editable: true, ...extra,
});

// A fixed 1 EUR = 1.10 USD conversion, allocated in whole cents like projectHomeEntry.
const project = (entry: Expense): Expense | null => {
  if (entry.currency === "USD") return entry;
  if (entry.currency !== "EUR") return null;
  const amount = Math.round(entry.amount * 1.1);
  const shares = entry.splits.map((s) => Math.floor((s.amount * amount) / entry.amount));
  shares[0] += amount - shares.reduce((a, b) => a + b, 0);
  return { ...entry, amount, currency: "USD", splits: entry.splits.map((s, i) => ({ ...s, amount: shares[i] })) };
};

const entries = [
  expense("dinner", "2026-03-02", 9001, [["a", 3001], ["b", 3000], ["c", 3000]], { category: "Dining" }),
  expense("rent", "2026-03-01", 300000, [["b", 150000], ["c", 150000]], { category: "Rent & Utilities" }),
  expense("hotel", "2026-04-15", 20000, [["a", 10000], ["c", 10000]], { category: "Lodging", currency: "EUR" }),
  expense("taxi", "2026-04-16", 5000, [["a", 2500], ["b", 2500]], { category: "Transport", currency: "ARS" }),
  { ...expense("payback", "2026-04-20", 4000, [["b", 4000]]), kind: "settlement" as const },
];

describe("web analytics", () => {
  it("rounds percentages to whole numbers that add up to exactly 100", () => {
    expect(percents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percents([9001, 300000, 22000]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(percents([0, 0])).toEqual([0, 0]);
  });

  it("buckets days, Monday weeks and months, and fills gaps", () => {
    expect(bucketKey("2026-04-16", "week")).toBe("2026-04-13");
    expect(bucketKey("2026-04-13", "week")).toBe("2026-04-13");
    expect(bucketKey("2026-04-16", "month")).toBe("2026-04");
    expect(bucketRange("2025-11-20", "2026-02-03", "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(bucketRange("2026-04-01", "2026-04-03", "day")).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
    expect(autoGranularity("2026-04-01", "2026-04-30")).toBe("day");
    expect(autoGranularity("2026-01-01", "2026-04-30")).toBe("week");
    expect(autoGranularity("2025-01-01", "2026-04-30")).toBe("month");
  });

  it("totals home-currency spend in integer cents and leaves unpriced expenses out of home charts", () => {
    const result = analyze(entries, project, "USD", {}, ["a", "b", "c"]);
    expect(result.rows).toHaveLength(4); // the settlement is not spending
    expect(result.excluded).toBe(1); // ARS has no rate
    expect(result.total).toBe(9001 + 300000 + 22000);
    expect(Number.isInteger(result.total)).toBe(true);
    expect(result.buckets.reduce((sum, b) => sum + b.amount, 0)).toBe(result.total);
    expect(result.categories.map((c) => c.id)).toEqual(["Rent & Utilities", "Lodging", "Dining"]);
    expect(result.categories.reduce((sum, c) => sum + c.percent, 0)).toBe(100);
    const people = Object.fromEntries(result.people.map((p) => [p.memberID, p]));
    expect(people.a).toMatchObject({ paid: 9001 + 22000, share: 3001 + 11000 });
    expect(people.b).toMatchObject({ paid: 300000, share: 3000 + 150000 });
    expect(result.people.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    const currencies = Object.fromEntries(result.currencies.map((c) => [c.currency, c]));
    expect(currencies.EUR).toMatchObject({ original: 20000, home: 22000, count: 1 });
    expect(currencies.ARS).toMatchObject({ original: 5000, home: null, count: 1 });
  });

  it("filters by date range and measures a member by their share", () => {
    const april = analyze(entries, project, "USD", { from: "2026-04-01", to: "2026-04-30" }, ["a", "b", "c"]);
    expect(april.rows.map((r) => r.entry.id)).toEqual(["hotel", "taxi"]);
    expect(april.granularity).toBe("day");
    expect(april.buckets).toHaveLength(30);

    const b = analyze(entries, project, "USD", { memberID: "b" }, ["a", "b", "c"]);
    expect(b.rows.map((r) => r.entry.id).sort()).toEqual(["dinner", "rent", "taxi"]);
    expect(b.total).toBe(3000 + 150000);
  });

  it("drills from a chart segment to exactly the matching expenses", () => {
    const result = analyze(entries, project, "USD", {}, ["a", "b", "c"], "month");
    expect(drillRows(result, { kind: "bucket", key: "2026-03" }).map((r) => r.entry.id).sort()).toEqual(["dinner", "rent"]);
    expect(drillRows(result, { kind: "category", id: "Lodging" }).map((r) => r.entry.id)).toEqual(["hotel"]);
    expect(drillRows(result, { kind: "currency", currency: "ARS" }).map((r) => r.entry.id)).toEqual(["taxi"]);
    expect(drillRows(result, { kind: "person", memberID: "a" }).map((r) => r.entry.id).sort()).toEqual(["dinner", "hotel"]);
    expect(drillRows(result, null)).toHaveLength(4);
  });
});
