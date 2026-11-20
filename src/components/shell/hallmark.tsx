import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Serif wordmark. "Wedding Workspace" is a provisional name, not final
 * branding. `compact` shows only the monogram; the name stays available to
 * assistive technology.
 */
export function Hallmark({
  href = "/",
  compact = false,
  className,
}: {
  href?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center gap-2 font-serif text-headline-sm whitespace-nowrap text-ink",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-gold font-serif text-body-md text-nav-selected italic"
      >
        W
      </span>
      <span className={cn(compact && "sr-only")}>Wedding Workspace</span>
    </Link>
  );
}
