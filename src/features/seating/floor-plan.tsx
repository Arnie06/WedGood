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
import Link from "next/link";
import { createPortal } from "react-dom";
import { AnchoredCard } from "@/components/ui/anchored-card";
import { TrayButton } from "@/components/ui/tray";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { seatLabel, type SeatCard, type TableCard } from "@/domain/seating/cards";
import {
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  clampCentre,
  clampCorner,
  type FloorElement,
  type Size,
} from "@/domain/seating/floor";
import type { TableShape } from "@/domain/seating/plan";
import { chipLayout } from "@/domain/seating/seats";
import { moveFloorItem } from "@/server/seating/actions";
import { SeatCardBody, TableCardBody } from "./floor-cards";
import { SeatFocusContext } from "./seat-focus";

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

type Target = { kind: "table"; tableId: string } | { kind: "seat"; tableId: string; seat: number };
type OpenCard = { target: Target; anchor: HTMLElement };
type OpenTray = { tableId: string; seat: number | null };
type Tip = { anchor: HTMLElement; text: string };

const sameTarget = (a: Target, b: Target) =>
  a.kind === b.kind &&
  a.tableId === b.tableId &&
  (a.kind === "table" || (b.kind === "seat" && a.seat === b.seat));

/**
 * The room as a sketch: drag a table or room item, or focus it and use the arrow keys (Shift for
 * bigger steps). Tapping a table or one of the seat chips round it opens a small card beside it with the
 * facts that matter; the card's Edit button opens the full tray (for a seat, on that seat). Hovering a
 * seat with a mouse names who is in it. Positions are a schematic grid, not a scale drawing. Panels are
 * built on the server and handed in. Seat chips are small on a crowded plan, so zoom in for comfortable
 * targets; the table card and tray reach every seat without them.
 */
export function FloorPlan({
  workspaceId,
  tables,
  elements,
  tablePanels,
  elementPanels,
  tableCards,
  seatCards,
  waitingForSeat,
  guestHrefBase,
}: {
  workspaceId: string;
  tables: FloorTableNode[];
  elements: (FloorElement & { version: number })[];
  tablePanels: Record<string, ReactNode>;
  elementPanels: Record<string, ReactNode>;
  tableCards: Record<string, TableCard>;
  /** One card per seat, in seat order, for each table. */
  seatCards: Record<string, SeatCard[]>;
  /** Guests who could be seated now but have no seat yet. */
  waitingForSeat: number;
  /** Where a guest's own page lives, without the trailing id (for example `/app/<id>/guests`). */
  guestHrefBase: string;
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
  const [card, setCard] = useState<OpenCard | null>(null);
  const [tray, setTray] = useState<OpenTray | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  /** Tap the same thing again to put its card away. */
  const toggleCard = (target: Target, anchor: HTMLElement) => {
    setTip(null);
    setCard((current) =>
      current && sameTarget(current.target, target) ? null : { target, anchor },
    );
  };
  const closeCard = ({ refocus }: { refocus: boolean }) => {
    if (refocus) card?.anchor.focus({ preventScroll: true });
    setCard(null);
  };
  const editFromCard = (next: OpenTray) => {
    setCard(null);
    setTray(next);
  };
  /** After the tray closes, focus goes back to what opened the card (the card itself is gone). */
  const trayClosed = (tableId: string, seat: number | null) => {
    setTray(null);
    const selector =
      seat === null
        ? `[data-floor-item="table"][data-table-id="${tableId}"]`
        : `[data-floor-seat="${seat}"][data-table-id="${tableId}"]`;
    boxRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  };

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
      if (!dragged.current) {
        setCard(null);
        setTip(null);
      }
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

  const activeCard = (() => {
    if (!card) return null;
    const { target } = card;
    if (target.kind === "table") {
      const data = tableCards[target.tableId];
      if (!data) return null;
      return (
        <AnchoredCard
          key={`table-${target.tableId}`}
          anchor={card.anchor}
          title={data.label}
          description={`${data.shape === "round" ? "Round" : "Rectangular"} table`}
          onClose={closeCard}
        >
          <TableCardBody
            card={data}
            onEdit={() => editFromCard({ tableId: target.tableId, seat: null })}
          />
        </AnchoredCard>
      );
    }
    const data = seatCards[target.tableId]?.find((x) => x.seat === target.seat);
    if (!data) return null;
    return (
      <AnchoredCard
        key={`seat-${target.tableId}-${target.seat}`}
        anchor={card.anchor}
        title={
          data.guest ? (
            <Link
              href={`${guestHrefBase}/${data.guest.id}`}
              className="-my-2.5 inline-block py-2.5 text-action-emphasis underline decoration-1 underline-offset-4 hover:decoration-2"
            >
              {data.guest.name}
              <span className="sr-only">, open guest details</span>
            </Link>
          ) : (
            `Seat ${data.seat}`
          )
        }
        description={`${data.tableLabel}, ${data.guest ? `seat ${data.seat}` : "empty seat"}`}
        onClose={closeCard}
      >
        <SeatCardBody
          card={data}
          waitingForSeat={waitingForSeat}
          onEdit={() => editFromCard({ tableId: target.tableId, seat: target.seat })}
        />
      </AnchoredCard>
    );
  })();

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
          Tap a table or a seat to see who is there. Drag a table or item to move it; with a
          keyboard, focus one and use the arrow keys (Shift for bigger steps).
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
            const seats = seatCards[t.id] ?? [];
            return spots.map((spot, i) => {
              const seat = seats[i];
              if (!seat) return null;
              const target: Target = { kind: "seat", tableId: t.id, seat: seat.seat };
              const isOpen = card ? sameTarget(card.target, target) : false;
              const name = seat.guest ? seat.guest.name : `Seat ${seat.seat}, empty`;
              return (
                <button
                  key={`${t.id}-${seat.seat}`}
                  type="button"
                  // Seats are reached by keyboard through the table's card and tray, so they stay out of the
                  // tab order (a plan can have dozens); a mouse, touch or screen reader can still activate them.
                  tabIndex={-1}
                  data-chip={seat.state}
                  data-floor-seat={seat.seat}
                  data-table-id={t.id}
                  aria-label={seatLabel(seat)}
                  aria-haspopup="dialog"
                  aria-expanded={isOpen}
                  onClick={(ev) => toggleCard(target, ev.currentTarget)}
                  onPointerEnter={(ev) => {
                    if (ev.pointerType === "mouse" && !isOpen)
                      setTip({ anchor: ev.currentTarget, text: name });
                  }}
                  onPointerLeave={() => setTip(null)}
                  onFocus={(ev) => {
                    if (ev.currentTarget.matches(":focus-visible"))
                      setTip({ anchor: ev.currentTarget, text: name });
                  }}
                  onBlur={() => setTip(null)}
                  className={cn(
                    "absolute z-[11] flex cursor-pointer items-center justify-center rounded-full border font-semibold leading-none transition-transform duration-100 hover:scale-125",
                    seat.state === "seated" &&
                      "border-action-secondary bg-action-secondary text-on-action-secondary",
                    seat.state === "waiting" &&
                      "border-dashed border-action-secondary bg-status-pending-bg text-status-pending-fg",
                    seat.state === "empty" &&
                      "border-dashed border-border-control bg-surface text-ink-muted",
                    isOpen && "outline-2 outline-offset-2 outline-focus",
                  )}
                  style={{
                    left: pct(p.x + spot.dx - diameter / 2, FLOOR_WIDTH),
                    top: pct(p.y + spot.dy - diameter / 2, FLOOR_HEIGHT),
                    width: pct(diameter, FLOOR_WIDTH),
                    height: pct(diameter, FLOOR_HEIGHT),
                    fontSize: `${((diameter * 0.42) / FLOOR_WIDTH) * 100}cqw`,
                  }}
                >
                  <span aria-hidden="true">
                    {zoom >= 1.5 ? (seat.guest?.initials ?? "+") : null}
                  </span>
                </button>
              );
            });
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
                isOpen={tray?.tableId === t.id}
                onClosed={() => trayClosed(t.id, tray?.seat ?? null)}
                {...(tray?.tableId === t.id && tray.seat !== null
                  ? { initialFocus: "[data-seat-panel] select:not(:disabled)" }
                  : {})}
                trigger={() => (
                  <button
                    type="button"
                    data-floor-item="table"
                    data-table-id={t.id}
                    data-table-label={t.label}
                    aria-haspopup="dialog"
                    aria-expanded={
                      card ? sameTarget(card.target, { kind: "table", tableId: t.id }) : false
                    }
                    onPointerDown={(ev) => onPointerDown(ev, "table", t.id, t.size)}
                    onKeyDown={(ev) => onKeyDown(ev, "table", t.id, t.size, t.label)}
                    onBlur={flush}
                    onClick={(ev) => {
                      if (dragged.current) dragged.current = false;
                      else toggleCard({ kind: "table", tableId: t.id }, ev.currentTarget);
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
                    }. Opens a summary card. Arrow keys move it.`}</span>
                  </button>
                )}
              >
                <SeatFocusContext.Provider value={tray?.tableId === t.id ? tray.seat : null}>
                  {tablePanels[t.id]}
                </SeatFocusContext.Provider>
              </TrayButton>
            );
          })}
        </div>
      </div>

      {activeCard}
      {tip && <SeatTip tip={tip} />}

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

/**
 * The name label that appears over a seat under a mouse pointer. Purely visual: the seat button already
 * carries the same words as its accessible name. Fixed to the viewport so the plan's scroll box cannot
 * clip it, and flipped below the seat when there is no room above.
 */
function SeatTip({ tip }: { tip: Tip }) {
  const r = tip.anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const above = r.top > 44;
  return createPortal(
    <span
      aria-hidden="true"
      data-testid="seat-tip"
      className="pointer-events-none fixed z-50 max-w-40 rounded-control bg-ink px-2.5 py-1 text-center text-label-md leading-snug font-semibold text-surface shadow-ambient-md"
      style={{
        left: Math.min(Math.max(r.left + r.width / 2, 88), vw - 88),
        top: above ? r.top - 6 : r.bottom + 6,
        transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
    >
      {tip.text}
    </span>,
    document.body,
  );
}
