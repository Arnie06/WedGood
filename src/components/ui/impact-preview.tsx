import { CircleAlert, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ImpactItem = { id: string; tone: "warning" | "info"; text: ReactNode };

/**
 * "Here is what this change would touch", shown before the person saves. Meaning is carried by
 * text and an icon, never colour alone. Announced politely as the list changes.
 */
export function ImpactPreview({
  title = "What this would change",
  items,
  className,
  testId,
  emptyText = "Nothing else is affected.",
  busy = false,
}: {
  title?: string;
  items: readonly ImpactItem[];
  className?: string;
  testId?: string;
  /** Shown when there are no items. */
  emptyText?: string;
  /** While a new list is being worked out; screen readers wait for the finished list. */
  busy?: boolean;
}) {
  return (
    <section
      aria-label={title}
      aria-live="polite"
      aria-busy={busy || undefined}
      data-testid={testId}
      className={cn(
        "space-y-2 rounded-card border border-border-hairline bg-surface-sunken p-4",
        className,
      )}
    >
      <h3 className="text-label-lg font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-body-md text-ink-muted">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2 text-body-md">
              {i.tone === "warning" ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
              ) : (
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
              )}
              <span>
                {i.tone === "warning" && <span className="sr-only">Check: </span>}
                {i.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
