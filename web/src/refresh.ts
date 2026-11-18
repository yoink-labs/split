// Refresh helpers shared by the web client. They keep what is on screen
// stable while a new snapshot loads: one request at a time, cancellations
// stay silent, and an unchanged snapshot keeps its identity so React does
// not redraw (or reorder) any rows.

type Identified = { id: string };
type Dated = Identified & { createdAt: string };
type Shape<G extends Identified, E extends Dated> = {
  groups: G[];
  entries: E[];
};

/** Calls made while a run is in flight share it instead of racing it. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () =>
    (current ??= run().finally(() => {
      current = null;
    }));
}

/** A cancelled request (navigation, an unloading tab) is not a failure. */
export function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

export function uniqueByID<T extends Identified>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}

/** Newest first; the id breaks ties so equal timestamps never swap. */
export function byNewest<T extends Dated>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

function reuse<T extends Identified>(previous: T[] | undefined, next: T[]) {
  const old = new Map(previous?.map((item) => [item.id, item]));
  return next.map((item) => {
    const prior = old.get(item.id);
    return prior && same(prior, item) ? prior : item;
  });
}

/**
 * Applies a fresh snapshot: duplicates are dropped, entries are ordered, and
 * unchanged groups and entries keep their previous objects. When nothing
 * changed the previous snapshot itself is returned.
 */
export function mergeSnapshot<
  S extends Shape<G, E>,
  G extends Identified,
  E extends Dated,
>(previous: S | null, next: S): S {
  const groups = reuse(previous?.groups, uniqueByID(next.groups));
  const entries = reuse(
    previous?.entries,
    uniqueByID(next.entries).sort(byNewest),
  );
  const merged = { ...next, groups, entries };
  if (
    previous &&
    groups.length === previous.groups.length &&
    entries.length === previous.entries.length &&
    groups.every((g, i) => g === previous.groups[i]) &&
    entries.every((e, i) => e === previous.entries[i]) &&
    same({ ...previous, groups: 0, entries: 0 }, { ...merged, groups: 0, entries: 0 })
  )
    return previous;
  return merged;
}
