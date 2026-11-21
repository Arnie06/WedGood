"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

export type QuickAddItem = { label: string; href: string };

/**
 * "Add" in the header: jump to a new task, guest, venue or vendor from any page. Links only,
 * so it works like any other navigation; the destination opens its own form. Only the items
 * the member may use are passed in (the destination re-checks on the server).
 */
export function QuickAdd({ items }: { items: readonly QuickAddItem[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-action-primary px-3 text-label-lg font-semibold text-on-action-primary hover:bg-action-primary-hover"
      >
        <Plus aria-hidden="true" className="size-5" />
        Add
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute right-0 z-30 mt-2 w-60 rounded-card border border-border-hairline bg-surface p-1 shadow-ambient-sm"
        >
          <ul>
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center rounded-control px-3 text-body-md hover:bg-surface-muted"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
