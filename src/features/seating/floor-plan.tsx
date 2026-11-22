"use client";

import { Minus, Plus } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { TrayButton } from "@/components/ui/tray";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  clampCentre,
  clampCorner,
  type FloorElement,
  type Size,
} from "@/domain/seating/floor";
import type { TableShape } from "@/domain/seating/plan";
import { chipLayout, type Chip } from "@/domain/seating/seats";
import { moveFloorItem } from "@/server/seating/actions";

export type FloorTableNode = {
  id: string;
  label: string;
  capacity: number;
  shape: TableShape;
  /** Centre, in grid units. */
  x: number;
  y: number;
  size: Size;
  used: number;
  waiting: number;
  captain: string | null;
  /** One chip per seat: initials and whether the seat is filled, waiting or empty. */
  chips: Chip[];
};

type Kind = "table" | "element";
type Pos = { x: number; y: number };
type Live = { kind: Kind; id: string } & Pos;

const ZOOMS = [1, 1.5, 2, 3] as const;
const DRAG_PX = 4;
/** Below this width the plan scrolls sideways instead of shrinking, so tables stay tappable. */
const MIN_PLAN_PX = 720;

const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const key = (kind: Kind, id: string) => `${kind}:${id}`;

/**
 * The room as a sketch: drag a table or room item, or focus it and use the arrow keys (Shift for
 * bigger steps). Activating one opens its tray. Positions are a schematic grid, not a scale drawing.
 * Panels are built on the server and handed in. The seat chips round each table are decoration (initials
 * only, hidden from assistive tech); the table's tray and its text description carry the same facts.
 */
export function FloorPlan({
  workspaceId,
  tables,
  elements,
  tablePanels,
  elementPanels,
}: {
  workspaceId: string;
  tables: FloorTableNode[];
  elements: (FloorElement & { version: number })[];
  tablePanels: Record<string, ReactNode>;
  elementPanels: Record<string, ReactNode>;
}) {
  const { toast } = useToast();
  // False while the server HTML is being hydrated, true after: lets tests (and nothing else) know
  // the drag handlers are attached.
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [zoomIndex, setZoomIndex] = useState(0);
  const zoom = ZOOMS[zoomIndex] ?? 1;
  const boxRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);
  const dragged = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const server: Record<string, Pos> = {};
  for (const t of tables) server[key("table", t.id)] = { x: t.x, y: t.y };
  for (const e of elements) server[key("element", e.id)] = { x: e.x, y: e.y };
  const [positions, setOptimistic] = useOptimistic(
    server,
    (state, move: Live): Record<string, Pos> => ({
      ...state,
      [key(move.kind, move.id)]: { x: move.x, y: move.y },
    }),
  );
  const posOf = (kind: Kind, id: string): Pos =>
    live && live.kind === kind && live.id === id
      ? { x: live.x, y: live.y }
      : (positions[key(kind, id)] ?? { x: 0, y: 0 });

  const commit = useCallback(
    (move: Live) => {
      liveRef.current = null;
      setLive(null);
      startTransition(async () => {
        setOptimistic(move);
        const result = await moveFloorItem({ workspaceId, ...move });
        if (!result.ok) toast({ message: result.message, tone: "error" });
      });
    },
    [workspaceId, setOptimistic, toast],
  );

  const flush = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    if (liveRef.current) commit(liveRef.current);
  }, [commit]);
  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  const setLiveNow = (next: Live) => {
    liveRef.current = next;
    setLive(next);
  };

  /** Pointer drag. A press that barely moves is a tap and falls through to the click that opens the tray. */
  function onPointerDown(event: PointerEvent<HTMLElement>, kind: Kind, id: string, size: Size) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const unit = rect.width / FLOOR_WIDTH;
    const start = posOf(kind, id);
    const originX = event.clientX;
    const originY = event.clientY;
    const target = event.currentTarget;
    dragged.current = false;
    target.setPointerCapture(event.pointerId);

    const place = (e: globalThis.PointerEvent): Live => {
      const raw = {
        x: start.x + (e.clientX - originX) / unit,
        y: start.y + (e.clientY - originY) / unit,
      };
      const c =
        kind === "table" ? clampCentre(size, raw.x, raw.y) : clampCorner(size, raw.x, raw.y);
      return { kind, id, ...c };
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!dragged.current && Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_PX)
        return;
      dragged.current = true;
      setLiveNow(place(e));
    };
    const finish = (e: globalThis.PointerEvent, cancelled: boolean) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      if (!dragged.current) return;
      const final = place(e);
      if (cancelled || (final.x === start.x && final.y === start.y)) {
        liveRef.current = null;
        setLive(null);
        return;
      }
      commit(final);
    };
    const up = (e: globalThis.PointerEvent) => finish(e, false);
    const cancel = (e: globalThis.PointerEvent) => finish(e, true);
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
  }

  /** Arrow keys nudge the focused item; the move is saved a moment after the last key. */
  function onKeyDown(
    event: KeyboardEvent<HTMLElement>,
    kind: Kind,
    id: string,
    size: Size,
    label: string,
  ) {
    const step = event.shiftKey ? 5 : 1;
    const delta =
      event.key === "ArrowLeft"
        ? [-step, 0]
        : event.key === "ArrowRight"
          ? [step, 0]
          : event.key === "ArrowUp"
            ? [0, -step]
            : event.key === "ArrowDown"
              ? [0, step]
              : null;
    if (!delta) return;
    event.preventDefault();
    const from =
      liveRef.current && liveRef.current.id === id && liveRef.current.kind === kind
        ? liveRef.current
        : { kind, id, ...posOf(kind, id) };
    const raw = { x: from.x + delta[0]!, y: from.y + delta[1]! };
    const c = kind === "table" ? clampCentre(size, raw.x, raw.y) : clampCorner(size, raw.x, raw.y);
    setLiveNow({ kind, id, ...c });
    setAnnouncement(`${label} at column ${c.x}, row ${c.y}`);
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 600);
  }

  const style = (rect: { x: number; y: number; w: number; h: number }): CSSProperties => ({
    left: pct(rect.x, FLOOR_WIDTH),
    top: pct(rect.y, FLOOR_HEIGHT),
    width: pct(rect.w, FLOOR_WIDTH),
    height: pct(rect.h, FLOOR_HEIGHT),
    touchAction: "none",
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body-sm text-ink-muted">
          Drag a table or item to move it. With a keyboard, focus one and use the arrow keys (Shift
          for bigger steps). Open one to see who is there.
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            aria-label="Zoom out"
            className="inline-flex size-11 items-center justify-center rounded-full border border-border-control disabled:opacity-40"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <span aria-live="polite" className="min-w-12 text-center text-label-lg">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOMS.length - 1}
            aria-label="Zoom in"
            className="inline-flex size-11 items-center justify-center rounded-full border border-border-control disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <div
        role="region"
        aria-label="Floor plan (scrolls sideways when zoomed in)"
        tabIndex={0}
        className="max-h-[75dvh] overflow-auto rounded-card border border-border-hairline bg-surface-sunken"
      >
        <div
          ref={boxRef}
          data-testid="floor-plan"
          data-hydrated={hydrated ? "true" : "false"}
          className="relative"
          style={{
            width: `calc(max(100%, ${MIN_PLAN_PX}px) * ${zoom})`,
            aspectRatio: `${FLOOR_WIDTH} / ${FLOOR_HEIGHT}`,
            backgroundImage:
              "radial-gradient(circle, var(--color-border-hairline) 1.5px, transparent 1.6px)",
            backgroundSize: `${pct(5, FLOOR_WIDTH)} ${pct(5, FLOOR_HEIGHT)}`,
            containerType: "inline-size",
          }}
        >
          {elements.map((e) => {
            const p = posOf("element", e.id);
            const size = { w: e.w, h: e.h };
            return (
              <TrayButton
                key={e.id}
                title={e.label}
                description="Room item"
                trigger={(open) => (
                  <button
                    type="button"
                    data-floor-item="element"
                    onPointerDown={(ev) => onPointerDown(ev, "element", e.id, size)}
                    onKeyDown={(ev) => onKeyDown(ev, "element", e.id, size, e.label)}
                    onBlur={flush}
                    onClick={() => {
                      if (dragged.current) dragged.current = false;
                      else open();
                    }}
                    style={style({ ...p, ...size })}
                    className="absolute flex cursor-grab items-center justify-center overflow-hidden rounded-control border border-dashed border-border-control bg-surface-muted px-1 text-center text-label-md text-ink-muted active:cursor-grabbing"
                  >
                    <span aria-hidden="true" className="truncate">
                      {e.label}
                    </span>
                    <span className="sr-only">{`${e.label}, room item. Opens details. Arrow keys move it.`}</span>
                  </button>
                )}
              >
                {elementPanels[e.id]}
              </TrayButton>
            );
          })}

          {tables.map((t) => {
            const p = posOf("table", t.id);
            const { diameter, spots } = chipLayout(t.shape, t.capacity, t.size);
            return (
              <div key={`chips-${t.id}`} aria-hidden="true" className="pointer-events-none">
                {spots.map((spot, i) => {
                  const chip = t.chips[i];
                  if (!chip) return null;
                  return (
                    <span
                      key={i}
                      data-chip={chip.state}
                      className={cn(
                        "absolute z-[5] flex items-center justify-center rounded-full border font-semibold leading-none",
                        chip.state === "seated" &&
                          "border-action-secondary bg-action-secondary text-on-action-secondary",
                        chip.state === "waiting" &&
                          "border-dashed border-action-secondary bg-status-pending-bg text-status-pending-fg",
                        chip.state === "empty" &&
                          "border-dashed border-border-control bg-surface text-ink-muted",
                      )}
                      style={{
                        left: pct(p.x + spot.dx - diameter / 2, FLOOR_WIDTH),
                        top: pct(p.y + spot.dy - diameter / 2, FLOOR_HEIGHT),
                        width: pct(diameter, FLOOR_WIDTH),
                        height: pct(diameter, FLOOR_HEIGHT),
                        fontSize: `${((diameter * 0.42) / FLOOR_WIDTH) * 100}cqw`,
                      }}
                    >
                      {zoom >= 1.5 ? (chip.initials ?? "+") : null}
                    </span>
                  );
                })}
              </div>
            );
          })}

          {tables.map((t) => {
            const p = posOf("table", t.id);
            const full = t.used >= t.capacity;
            const open = t.capacity - t.used;
            return (
              <TrayButton
                key={t.id}
                title={t.label}
                description={`${t.shape === "round" ? "Round" : "Rectangular"} table`}
                trigger={(openTray) => (
                  <button
                    type="button"
                    data-floor-item="table"
                    data-table-label={t.label}
                    onPointerDown={(ev) => onPointerDown(ev, "table", t.id, t.size)}
                    onKeyDown={(ev) => onKeyDown(ev, "table", t.id, t.size, t.label)}
                    onBlur={flush}
                    onClick={() => {
                      if (dragged.current) dragged.current = false;
                      else openTray();
                    }}
                    style={style({
                      x: p.x - t.size.w / 2,
                      y: p.y - t.size.h / 2,
                      w: t.size.w,
                      h: t.size.h,
                    })}
                    className={cn(
                      "absolute z-10 flex cursor-grab flex-col items-center justify-center overflow-hidden border-2 px-1 text-center shadow-ambient-sm active:cursor-grabbing",
                      t.shape === "round" ? "rounded-full" : "rounded-card",
                      full
                        ? "border-action-secondary bg-status-confirmed-bg text-status-confirmed-fg"
                        : "border-border-control bg-surface text-ink",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="line-clamp-2 max-w-full text-label-md leading-tight font-semibold break-words"
                    >
                      {t.label}
                    </span>
                    <span aria-hidden="true" className="text-label-md">
                      {t.used}/{t.capacity}
                    </span>
                    <span className="sr-only">{`${t.label}, ${t.used} of ${t.capacity} seats${
                      full ? ", full" : `, ${open} open`
                    }${t.waiting > 0 ? `, ${t.waiting} waiting to answer` : ""}${
                      t.captain ? `, captain ${t.captain}` : ""
                    }. Opens details. Arrow keys move it.`}</span>
                  </button>
                )}
              >
                {tablePanels[t.id]}
              </TrayButton>
            );
          })}
        </div>
      </div>

      <p role="status" className="sr-only">
        {announcement}
      </p>
      <p className="text-body-sm text-ink-muted">
        A sketch to plan with. It is not to scale and is not a safety, aisle-width or venue
        clearance check.
      </p>
    </div>
  );
}
