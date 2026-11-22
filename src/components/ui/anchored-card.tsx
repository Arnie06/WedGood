"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeCard, type CardSide } from "@/lib/anchored-position";
import { cn } from "@/lib/cn";

type Pos = { left: number; top: number; side: CardSide };

/**
 * A small card that opens right next to the thing that was tapped (a table, a seat) and follows it
 * while the page or plan scrolls, zooms or resizes. It is not modal: the plan behind stays usable, and
 * tapping anywhere else, pressing Escape, or scrolling its target out of view closes it. Focus moves
 * into the card; Escape and Tab off either end hand focus back to the target.
 *
 * Rendered in a portal so the plan's scroll box cannot clip it. Position is measured every frame while
 * open, which is cheap (one rect read) and covers scroll, zoom, resize and a table being nudged.
 */
export function AnchoredCard({
  anchor,
  title,
  description,
  onClose,
  children,
  className,
}: {
  /** The element the card points at; clicks on it are the opener's business, not "outside". */
  anchor: HTMLElement;
  title: ReactNode;
  description?: string | undefined;
  /** `refocus` is true when focus should go back to the anchor (Escape, Tab off the end). */
  onClose: (options: { refocus: boolean }) => void;
  children: ReactNode;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<Pos | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // Follow the anchor.
  useEffect(() => {
    let frame = 0;
    let last = "";
    const tick = () => {
      const card = ref.current;
      if (card) {
        const a = anchor.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const gone = a.bottom < 0 || a.top > vh || a.right < 0 || a.left > vw;
        if (gone) {
          closeRef.current({ refocus: false });
          return;
        }
        const next = placeCard(
          { left: a.left, top: a.top, width: a.width, height: a.height },
          { width: card.offsetWidth, height: card.offsetHeight },
          { width: vw, height: vh },
        );
        const sig = `${Math.round(next.left)}|${Math.round(next.top)}|${next.side}`;
        if (sig !== last) {
          last = sig;
          setPos({ left: Math.round(next.left), top: Math.round(next.top), side: next.side });
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  // Focus goes into the card; tapping elsewhere or pressing Escape closes it.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      closeRef.current({ refocus: false });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current({ refocus: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor]);

  /** The card sits at the end of the document, so Tab off either end returns to the plan. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const card = ref.current;
    if (!card) return;
    const items = [
      ...card.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex='0']"),
    ];
    const first = items[0];
    const last = items[items.length - 1];
    const leavingBack =
      event.shiftKey && (document.activeElement === card || event.target === first);
    const leavingForward = !event.shiftKey && event.target === last;
    if (leavingBack || leavingForward) {
      event.preventDefault();
      closeRef.current({ refocus: true });
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-side={pos?.side}
      onKeyDown={onKeyDown}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
      className={cn(
        "fixed z-40 w-72 max-w-[calc(100vw-1rem)] space-y-3 rounded-card border border-border-hairline bg-surface p-4 text-ink shadow-ambient-lg outline-none",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h2 id={titleId} className="font-serif text-headline-sm break-words">
            {title}
          </h2>
          {description && <p className="text-body-sm text-ink-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={() => closeRef.current({ refocus: true })}
          aria-label="Close"
          className="-mt-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      {children}
    </div>,
    document.body,
  );
}
