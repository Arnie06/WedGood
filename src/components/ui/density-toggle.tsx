import { DENSITIES, DENSITY_LABELS, type Density } from "@/domain/display/density";
import { setDensity } from "@/server/display/actions";
import { cn } from "@/lib/cn";

/**
 * Comfortable/compact list spacing (UX-18). A plain form, so it works before scripts load. The
 * choice applies to every list in this workspace, in this browser.
 */
export function DensityToggle({
  workspaceId,
  density,
  className,
}: {
  workspaceId: string;
  density: Density;
  className?: string;
}) {
  return (
    <form action={setDensity} className={cn("flex flex-wrap items-center gap-2", className)}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <span id={`density-${workspaceId}`} className="text-label-md text-ink-muted">
        Spacing
      </span>
      <div
        role="group"
        aria-labelledby={`density-${workspaceId}`}
        className="inline-flex rounded-control border border-border-control"
      >
        {DENSITIES.map((d) => {
          const on = d === density;
          return (
            <button
              key={d}
              type="submit"
              name="density"
              value={d}
              aria-pressed={on}
              className={cn(
                "inline-flex min-h-11 items-center px-3 text-label-lg font-semibold first:rounded-l-control last:rounded-r-control",
                on
                  ? "bg-action-secondary text-on-action-secondary"
                  : "text-action-secondary hover:bg-action-secondary-subtle",
              )}
            >
              {DENSITY_LABELS[d]}
            </button>
          );
        })}
      </div>
    </form>
  );
}
