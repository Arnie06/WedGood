import type { ReactNode } from "react";
import { CalendarDays, ChevronRight, MapPin, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Ornament } from "@/components/ui/ornament";

export function DashboardHero({
  name,
  date,
  location,
  days,
  settings,
}: {
  name: string;
  date: string | null;
  location?: string | null;
  days: number | null;
  settings?: { href: string; label: string };
}) {
  return (
    <header className="relative isolate flex flex-wrap items-center justify-between gap-x-6 gap-y-4 overflow-hidden rounded-panel border border-border-hairline bg-surface-sunken px-5 py-5 sm:px-8 sm:py-7">
      <div className="min-w-0 flex-1 basis-52">
        <Ornament className="mb-1 max-w-25" />
        <h1 className="font-serif text-headline-mobile wrap-anywhere sm:text-display-mobile lg:text-display-lg">
          {name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-body-sm text-ink-muted">
          <p className="flex min-w-0 items-start gap-1.5">
            <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {date ?? "Date to be decided"}
          </p>
          {location && (
            <p className="flex min-w-0 items-start gap-1.5 wrap-anywhere">
              <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {location}
            </p>
          )}
        </div>
        {settings && (
          <Link href={settings.href} className="tool-link mt-1 text-action-emphasis">
            {settings.label}
          </Link>
        )}
      </div>
      {days !== null && (
        <div className="relative min-w-0 shrink-0 rounded-full bg-nav-selected-bg px-3 py-1 text-action-emphasis sm:w-36 sm:rounded-card sm:border sm:border-border-hairline sm:bg-surface sm:px-4 sm:py-4 sm:text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-12 -inset-y-12 -z-10 hidden rounded-t-[50%] border border-border-hairline sm:block"
          />
          {days === 0 ? (
            <p className="font-serif text-headline-sm sm:text-headline-md">Wedding day</p>
          ) : (
            <p className="flex items-baseline gap-2 sm:block">
              <span className="font-serif text-headline-sm tabular-nums sm:block sm:text-display-mobile">
                {Math.abs(days)}
              </span>{" "}
              <span className="text-body-sm font-semibold">
                {Math.abs(days) === 1 ? "day" : "days"} {days > 0 ? "to go" : "ago"}
              </span>
            </p>
          )}
        </div>
      )}
    </header>
  );
}

export function DashboardMetrics({ children }: { children: ReactNode }) {
  return (
    <ul
      aria-label="Planning overview"
      className="record-list grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      {children}
    </ul>
  );
}

export function DashboardMetric({
  icon: Icon,
  label,
  value,
  note,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  note?: string | undefined;
  href?: string;
}) {
  const content = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-control bg-surface-sunken text-action-secondary sm:size-9">
        <Icon aria-hidden="true" className="size-4" strokeWidth={1.7} />
      </span>
      <span className="min-w-0 grow">
        <span className="block text-body-sm font-semibold text-ink-muted">{label}</span>
        <span className="block font-serif text-headline-sm wrap-anywhere tabular-nums sm:text-headline-md">
          {value}
        </span>
        {note && <span className="block text-body-sm text-ink-muted">{note}</span>}
      </span>
    </>
  );
  const layout = "flex h-full items-start gap-3 rounded-control p-3 sm:px-4 sm:py-4";
  return (
    <li className="min-w-0">
      {href ? (
        <Link href={href} className={`${layout} hover:bg-surface-sunken`}>
          {content}
          <ChevronRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-action-emphasis" />
        </Link>
      ) : (
        <div className={layout}>{content}</div>
      )}
    </li>
  );
}
