import { useId } from "react";

/** Slender 4px gauge: eucalyptus fill on a blush track, value also given as text. */
export function ProgressBar({
  label,
  value,
  max,
  valueText,
}: {
  label: string;
  value: number;
  max: number;
  valueText: string;
}) {
  const id = useId();
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = (clamped / safeMax) * 100;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span id={id} className="text-label-md font-semibold text-ink-muted uppercase">
          {label}
        </span>
        <span className="text-body-sm text-ink">{valueText}</span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={valueText}
        className="h-1 w-full overflow-hidden rounded-full bg-progress-track"
      >
        <div className="h-full rounded-full bg-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
