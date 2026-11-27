import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { balances, memberName, money, rawTransfers, type Expense, type Group } from "./data";
import { useHomeMoney } from "./homeMoney";
import { layoutFlow, transferID, type Box, type Point, type Size, type Transfer } from "./moneyFlowLayout";

type Camera = Point & { scale: number };
type Drag = { id?: string; start: Point; origin: Point; camera: Camera; moved: boolean };
type Pinch = { center: Point; distance: number; camera: Camera };
const minZoom = 0.2;
const maxZoom = 3;
const clampZoom = (scale: number, minimum: number) => Math.max(minimum, Math.min(maxZoom, scale));

function zoomAt(camera: Camera, scale: number, anchor: Point, target = anchor): Camera {
  const ratio = scale / camera.scale;
  return { x: target.x - (anchor.x - camera.x) * ratio, y: target.y - (anchor.y - camera.y) * ratio, scale };
}

export function MoneyFlowGraph({ g, entries, currency, suggested, focus }: {
  g: Group;
  entries: Expense[];
  currency: string;
  suggested: Transfer[];
  focus?: { id: string };
}) {
  const homeMoney = useHomeMoney();
  const titleID = useId();
  const helpID = useId();
  const markerID = useId();
  const selectedMarkerID = useId();
  const [mode, setMode] = useState<"suggested" | "direct">("suggested");
  const [selected, setSelected] = useState<string>();
  const net = useMemo(() => balances(entries, currency), [entries, currency]);
  const direct = useMemo(() => rawTransfers(entries, currency), [entries, currency]);
  const edges = mode === "suggested" ? suggested : direct;
  const people = useMemo(() => {
    const senders = new Set(edges.map((edge) => edge.from));
    const recipients = new Set(edges.map((edge) => edge.to));
    const ids = new Set([...senders, ...recipients]);
    const columns: string[][] = [[], [], []];
    for (const id of ids) {
      columns[senders.has(id) ? (recipients.has(id) ? 1 : 0) : 2].push(id);
    }
    return columns.flatMap((column, index) => column.map((id, row) => ({
      id: "person:" + id,
      name: memberName(g, id),
      balance: net[id] ?? 0,
      point: { x: (index - 1) * 166, y: (row - (column.length - 1) / 2) * 94 + (index === 2 && column.length > 1 ? 20 : 0) },
    })));
  }, [edges, g, net]);

  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const handledFocus = useRef<typeof focus>(undefined);
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const blockClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [windowSize, setWindowSize] = useState<Size>({ width: 0, height: 0 });
  const [manualCamera, setCamera] = useState<Camera>();
  const [positions, setPositions] = useState(new Map<string, Point>());
  const [preferredNode, setPreferredNode] = useState<string>();
  const [preferredLabel, setPreferredLabel] = useState<string>();

  const { boxes, arrows, bounds } = useMemo(
    () => layoutFlow(people, edges, sizes, positions, preferredNode, preferredLabel),
    [people, edges, sizes, positions, preferredNode, preferredLabel],
  );
  const center = { x: windowSize.width / 2, y: windowSize.height / 2 };
  const scale = Math.min(1, (windowSize.width - 28) / (bounds.right - bounds.left || 1), (windowSize.height - 28) / (bounds.bottom - bounds.top || 1));
  const fit = {
    scale: scale > 0 ? scale : 1,
    x: center.x - (bounds.left + bounds.right) / 2 * scale,
    y: center.y - (bounds.top + bounds.bottom) / 2 * scale,
  };
  const camera = manualCamera ?? fit;
  const minimumZoom = Math.min(minZoom, fit.scale);
  const hasEdges = edges.length > 0;

  useLayoutEffect(() => {
    if (!viewport.current || !world.current) return;
    const pane = viewport.current;
    const labels = [...world.current.querySelectorAll<HTMLElement>("[data-flow-id]")];
    const measureViewport = () => setWindowSize({ width: pane.clientWidth, height: pane.clientHeight });
    const measureLabels = () => setSizes(Object.fromEntries(labels.map((label) => [
      label.dataset.flowId!, { width: label.offsetWidth, height: label.offsetHeight },
    ])));
    measureViewport();
    measureLabels();
    const paneObserver = new ResizeObserver(measureViewport);
    const labelObserver = new ResizeObserver(measureLabels);
    paneObserver.observe(pane);
    labels.forEach((label) => labelObserver.observe(label));
    return () => { paneObserver.disconnect(); labelObserver.disconnect(); };
  }, [people, edges]);

  useEffect(() => {
    const pane = viewport.current;
    if (!pane) return;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = pane!.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = event.deltaMode === 1 ? 0.05 : 0.003;
      setCamera((current = camera) => zoomAt(current, clampZoom(current.scale * Math.exp(-event.deltaY * factor), minimumZoom), anchor));
    }
    pane.addEventListener("wheel", wheel, { passive: false });
    return () => pane.removeEventListener("wheel", wheel);
  }, [camera.scale, camera.x, camera.y, minimumZoom, hasEdges]);

  function reveal(box: Box, forceCenter = false) {
    const x = camera.x + box.x * camera.scale;
    const y = camera.y + box.y * camera.scale;
    if (!forceCenter && camera.scale >= 0.9 &&
        x - box.width * camera.scale / 2 >= 8 && x + box.width * camera.scale / 2 <= windowSize.width - 8 &&
        y - box.height * camera.scale / 2 >= 8 && y + box.height * camera.scale / 2 <= windowSize.height - 8) return;
    // Keep the entire focused label readable on narrow canvases.
    const nextScale = Math.min(Math.max(1, camera.scale), (windowSize.width - 20) / box.width, (windowSize.height - 20) / box.height);
    setCamera({ scale: nextScale, x: center.x - box.x * nextScale, y: center.y - box.y * nextScale });
  }

  useLayoutEffect(() => {
    if (!focus || handledFocus.current === focus) return;
    if (mode !== "suggested") {
      setMode("suggested");
      return;
    }
    const box = boxes.get(focus.id);
    const label = [...(world.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.dataset.flowId === focus.id);
    if (!box || !label || !windowSize.width) return;
    handledFocus.current = focus;
    setSelected(focus.id);
    reveal(box, true);
    label.focus({ preventScroll: true });
    viewport.current?.closest(".flow-card")?.scrollIntoView({ block: "start" });
  });

  function moveItem(id: string, point: Point) {
    setPositions((current) => new Map(current).set(id, point));
    if (id.startsWith("person:")) setPreferredNode(id);
    else setPreferredLabel(id);
  }

  function localPoint(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pinchGeometry() {
    const [a, b] = pointers.current.values();
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  function startPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || pointers.current.size >= 2) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const target = (event.target as Element).closest<HTMLElement>("button[data-flow-id]");
    (target ?? event.currentTarget).setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      drag.current = null;
      pinch.current = { ...pinchGeometry(), camera };
      blockClick.current = true;
      setPanning(true);
      return;
    }
    const id = target?.dataset.flowId;
    blockClick.current = false;
    drag.current = { id, start: point, origin: (id && boxes.get(id)) || camera, camera, moved: false };
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pinch.current) {
      const initial = pinch.current;
      const next = pinchGeometry();
      setCamera(zoomAt(initial.camera, clampZoom(initial.camera.scale * next.distance / initial.distance, minimumZoom), initial.center, next.center));
      return;
    }
    const active = drag.current;
    if (!active) return;
    const dx = point.x - active.start.x;
    const dy = point.y - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < 5) return;
    active.moved = true;
    blockClick.current = true;
    if (active.id) {
      setCamera(active.camera);
      moveItem(active.id, { x: active.origin.x + dx / active.camera.scale, y: active.origin.y + dy / active.camera.scale });
    } else {
      setPanning(true);
      setCamera({ ...active.camera, x: active.origin.x + dx, y: active.origin.y + dy });
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pinch.current && pointers.current.size === 1) {
      drag.current = { start: [...pointers.current.values()][0], origin: camera, camera, moved: true };
    } else {
      drag.current = null;
      setPanning(false);
    }
    pinch.current = null;
  }

  function zoomBy(factor: number) {
    setCamera(zoomAt(camera, clampZoom(camera.scale * factor, minimumZoom), center));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const [dx, dy] = direction;
      const id = (event.target as HTMLElement).dataset.flowId;
      const box = id && boxes.get(id);
      if (box) {
        const step = 24 / camera.scale;
        moveItem(id, { x: box.x + dx * step, y: box.y + dy * step });
        setCamera({ ...camera, x: camera.x - dx * 24, y: camera.y - dy * 24 });
      } else {
        setCamera({ ...camera, x: camera.x + dx * 48, y: camera.y + dy * 48 });
      }
    } else if (["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") setCamera(undefined);
      else zoomBy(event.key === "-" ? 0.8 : 1.25);
    }
  }

  const selectedEdge = edges.find((edge) => transferID(edge) === selected);
  const selectedPerson = people.find((person) => person.id === selected);
  const selectedAmount = selectedEdge?.amount ?? Math.abs(selectedPerson?.balance ?? 0);
  const balanceText = (balance: number) => balance === 0 ? "Settled" :
    `${balance > 0 ? "To receive" : "To pay"} ${money(Math.abs(balance), currency)}`;
  const transferText = (edge: Transfer) => `${memberName(g, edge.from)} pays ${memberName(g, edge.to)} ${money(edge.amount, currency)}`;

  function itemProps(id: string) {
    const box = boxes.get(id)!;
    return {
      "data-flow-id": id,
      "aria-pressed": selected === id,
      style: { left: box.x, top: box.y },
      onClick: () => { setSelected(id); reveal(box); },
      onFocus: (event: FocusEvent<HTMLButtonElement>) => {
        if (event.currentTarget.matches(":focus-visible")) reveal(box);
      },
    };
  }

  return (
    <section className="card card-pad flow-card" aria-labelledby={titleID}>
      <div className="flow-heading">
        <h3 id={titleID}>Money flow · {currency}</h3>
        <div className="seg" role="group" aria-label="Flow mode">
          <button type="button" aria-pressed={mode === "suggested"} onClick={() => { setMode("suggested"); setSelected(undefined); setCamera(undefined); }}>
            Simplified ({suggested.length})
          </button>
          <button type="button" aria-pressed={mode === "direct"} onClick={() => { setMode("direct"); setSelected(undefined); setCamera(undefined); }}>
            Direct ({direct.length})
          </button>
        </div>
      </div>
      {!hasEdges ? (
        <p className="flow-empty">All settled in {currency}.</p>
      ) : (
        <>
          <div className="flow-controls" role="group" aria-label="Canvas controls">
            <button type="button" className="btn btn-sm" aria-label="Zoom out" disabled={camera.scale <= minimumZoom} onClick={() => zoomBy(0.8)}>−</button>
            <button type="button" className="btn btn-sm" aria-label="Zoom in" disabled={camera.scale >= maxZoom} onClick={() => zoomBy(1.25)}>+</button>
            <button type="button" className="btn btn-sm" onClick={() => setCamera(undefined)}>Fit view</button>
            <button type="button" className="btn btn-sm" onClick={() => {
              setPositions(new Map()); setPreferredNode(undefined); setPreferredLabel(undefined); setCamera(undefined);
            }}>Reset layout</button>
          </div>
          <p className="flow-help muted" id={helpID}>Drag the background to pan, or drag people and amounts to move them. Pinch or use + and − to zoom. Arrow keys move the focused item or canvas.</p>
          <div
            ref={viewport} className={`flow-viewport${panning ? " is-panning" : ""}`} role="group" tabIndex={0}
            aria-label={`Money flow canvas for ${currency}`} aria-describedby={helpID}
            onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer}
            onPointerCancel={endPointer} onLostPointerCapture={endPointer} onKeyDown={onKeyDown}
            onClickCapture={(event) => {
              if (blockClick.current && event.detail > 0) { event.stopPropagation(); blockClick.current = false; }
            }}
          >
            <div ref={world} className="flow-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
              <svg className="flow-lines" aria-hidden="true" width="1" height="1">
                <defs>
                  {[markerID, selectedMarkerID].map((id, index) => (
                    <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={index ? "var(--primary)" : "var(--muted)"} />
                    </marker>
                  ))}
                </defs>
                {edges.map((edge) => {
                  const id = transferID(edge);
                  const { path, anchor, leader } = arrows.get(id)!;
                  const active = selected === id || selected === "person:" + edge.from || selected === "person:" + edge.to;
                  const color = active ? "var(--primary)" : "var(--muted)";
                  return (
                    <g key={id}>
                      <path d={path} fill="none" stroke={color} strokeWidth={active ? 2.8 : 1.6} markerEnd={`url(#${active ? selectedMarkerID : markerID})`} />
                      <line x1={anchor.x} y1={anchor.y} x2={leader.x} y2={leader.y} stroke={color} strokeDasharray="3 3" />
                    </g>
                  );
                })}
              </svg>
              {people.map(({ id, name, balance }) => (
                <button key={id} type="button" className="flow-item flow-person" {...itemProps(id)}>
                  <strong>{name}</strong>
                  <span className={balance > 0 ? "pos" : balance < 0 ? "neg" : "muted"}>{balanceText(balance)}</span>
                </button>
              ))}
              {edges.map((edge) => {
                const id = transferID(edge);
                return <button key={id} type="button" className="flow-item flow-amount num" aria-label={transferText(edge)} {...itemProps(id)}>
                  {money(edge.amount, currency)}
                </button>;
              })}
            </div>
          </div>
          <div className="flow-detail" aria-live="polite">
            {selectedEdge ? transferText(selectedEdge) : selectedPerson ? `${selectedPerson.name} · ${balanceText(selectedPerson.balance)}` : "Select a person or amount to see details."}
            {currency !== homeMoney.home && selectedAmount > 0 && (
              <div className="muted">{homeMoney.totalText({ [currency]: selectedAmount })} in {homeMoney.home}</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
