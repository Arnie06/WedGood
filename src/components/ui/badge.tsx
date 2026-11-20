import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "confirmed" | "pending" | "ceremony" | "neutral";

const tones: Record<BadgeTone, string> = {
  confirmed: "bg-status-confirmed-bg text-status-confirmed-fg",
  pending: "bg-status-pending-bg text-status-pending-fg",
  ceremony: "bg-status-ceremony-bg text-status-ceremony-fg",
  neutral: "bg-status-neutral-bg text-status-neutral-fg",
};

/** Ribbon-like status pill. Meaning is always carried by the text, not colour alone. */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-label-md font-semibold whitespace-nowrap uppercase",
        tones[tone],
        className,
      )}
    >
      {tone === "ceremony" && (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent-gold" />
      )}
      {children}
    </span>
  );
}
