export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Box = Point & Size;
export type Transfer = { from: string; to: string; amount: number };

export const transferID = ({ from, to }: Transfer) => JSON.stringify([from, to]);

const gap = 10;

function place(point: Point, size: Size, occupied: Box[]): Box {
  const overlaps = (a: Box, b: Box) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap - 0.001 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap - 0.001;
  const preferred = { ...point, ...size };
  if (!occupied.some((box) => overlaps(preferred, box))) return preferred;
  const horizontal = [point.x, point.x - size.width - gap, point.x + size.width + gap];
  let best: Box | undefined;
  let distance = Infinity;
  for (const x of horizontal) {
    const center = { ...size, x, y: point.y };
    // Each obstacle blocks a vertical interval in this column. Its boundaries
    // are sufficient to find the closest open position, even in a dense graph.
    const blockers = occupied.filter((box) => overlaps(center, { ...box, y: point.y }));
    const candidates = [point.y, ...blockers.flatMap((box) => {
      const clearance = (box.height + size.height) / 2 + gap;
      return [box.y - clearance, box.y + clearance];
    })];
    for (const y of candidates) {
      const offset = Math.hypot(x - point.x, y - point.y);
      const candidate = { ...center, y };
      if (offset < distance && !blockers.some((box) => overlaps(candidate, box))) {
        best = candidate;
        distance = offset;
      }
    }
  }
  return best ?? { ...size, ...point };
}

function moveFirst<T>(items: T[], key: (item: T) => string, preferred?: string) {
  const first = items.findIndex((item) => key(item) === preferred);
  return first > 0 ? [items[first], ...items.slice(0, first), ...items.slice(first + 1)] : items;
}

function borderPoint(box: Box, toward: Point, padding = 2): Point {
  const dx = toward.x - box.x;
  const dy = toward.y - box.y;
  const ratio = Math.max(Math.abs(dx) / (box.width / 2 + padding), Math.abs(dy) / (box.height / 2 + padding));
  return ratio > 1 ? { x: box.x + dx / ratio, y: box.y + dy / ratio } : toward;
}

export function layoutFlow(
  people: { id: string; point: Point }[],
  transfers: Transfer[],
  sizes: Record<string, Size>,
  positions: Map<string, Point>,
  preferredNode?: string,
  preferredLabel?: string,
) {
  const occupied: Box[] = [];
  const boxes = new Map<string, Box>();
  for (const { id, point } of moveFirst(people, (person) => person.id, preferredNode)) {
    const box = place(positions.get(id) ?? point, sizes[id] ?? { width: 148, height: 62 }, occupied);
    occupied.push(box);
    boxes.set(id, box);
  }

  const arrows = new Map<string, { path: string; anchor: Point; leader: Point }>();
  for (const transfer of moveFirst(transfers, transferID, preferredLabel)) {
    const id = transferID(transfer);
    const from = boxes.get("person:" + transfer.from)!;
    const to = boxes.get("person:" + transfer.to)!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    const control = { x: (from.x + to.x) / 2 - dy / length * 22, y: (from.y + to.y) / 2 + dx / length * 22 };
    const start = borderPoint(from, to);
    const end = borderPoint(to, from, 4);
    const anchor = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 };
    const label = place(positions.get(id) ?? anchor, sizes[id] ?? { width: 104, height: 32 }, occupied);
    occupied.push(label);
    boxes.set(id, label);
    arrows.set(id, {
      path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
      anchor,
      leader: borderPoint(label, anchor, 0),
    });
  }

  return {
    boxes,
    arrows,
    bounds: occupied.reduce((bounds, box) => ({
      left: Math.min(bounds.left, box.x - box.width / 2),
      right: Math.max(bounds.right, box.x + box.width / 2),
      top: Math.min(bounds.top, box.y - box.height / 2),
      bottom: Math.max(bounds.bottom, box.y + box.height / 2),
    }), { left: 0, right: 0, top: 0, bottom: 0 }),
  };
}
