"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Heading for one step of a short guided flow. Shows "Step n of m" with a slim progress row,
 * and moves focus to the heading when it mounts or `focusKey` changes, as long as `focusKey` is
 * above 0. Start the key at 0 so a page load never steals focus; bump it on every step change.
 * Steps without a number (a confirmation) omit `step`.
 */
export function StepHeading({
  title,
  step,
  focusKey,
  className,
}: {
  title: string;
  step?: { number: number; count: number } | undefined;
  focusKey: number;
  className?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);

  return (
    <div className={cn("space-y-3", className)}>
      {step && (
        <div aria-hidden="true" className="space-y-2">
          <p className="text-label-md font-semibold text-ink-muted uppercase">
            Step {step.number} of {step.count}
          </p>
          <ol className="flex gap-1.5">
            {Array.from({ length: step.count }, (_, i) => (
              <li
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  i < step.number ? "bg-progress-fill" : "bg-progress-track",
                )}
              />
            ))}
          </ol>
        </div>
      )}
      <h2 ref={ref} tabIndex={-1} className="font-serif text-headline-sm text-ink">
        {step && <span className="sr-only">{`Step ${step.number} of ${step.count}: `}</span>}
        {title}
      </h2>
    </div>
  );
}
