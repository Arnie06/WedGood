"use client";

import { CalendarHeart, Compass, Ellipsis, House, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { navGroups, navHref, type NavGroupKey } from "./nav-groups";

const icons: Record<NavGroupKey, LucideIcon> = {
  home: House,
  discover: Compass,
  plan: CalendarHeart,
  guests: Users,
  more: Ellipsis,
};

function useActiveKey(basePath: string): NavGroupKey | null {
  const pathname = usePathname();
  for (const group of navGroups) {
    const href = navHref(basePath, group);
    const active = group.segment
      ? pathname === href || pathname.startsWith(`${href}/`)
      : pathname === href;
    if (active) return group.key;
  }
  return null;
}

/** Desktop sidebar navigation (≥1024px). */
export function SidebarNav({ basePath }: { basePath: string }) {
  const activeKey = useActiveKey(basePath);
  return (
    <nav aria-label="Workspace" className="mt-10">
      <ul className="space-y-1">
        {navGroups.map((group) => {
          const Icon = icons[group.key];
          const active = group.key === activeKey;
          return (
            <li key={group.key}>
              <Link
                href={navHref(basePath, group)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-control px-3 text-label-lg font-semibold transition-colors",
                  active
                    ? "bg-nav-selected-bg text-nav-selected"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.5} />
                {group.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Mobile and tablet bottom navigation (<1024px). */
export function BottomNav({ basePath }: { basePath: string }) {
  const activeKey = useActiveKey(basePath);
  return (
    <nav
      aria-label="Workspace"
      className="glass fixed inset-x-0 bottom-0 z-30 border-t border-border-hairline pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto grid max-w-xl grid-cols-5">
        {navGroups.map((group) => {
          const Icon = icons[group.key];
          const active = group.key === activeKey;
          return (
            <li key={group.key}>
              <Link
                href={navHref(basePath, group)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-label-md font-semibold tracking-normal",
                  active ? "text-nav-selected" : "text-ink-muted hover:text-ink",
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-nav-selected"
                  />
                )}
                <span
                  className={cn(
                    "flex h-7 w-12 items-center justify-center rounded-full",
                    active && "bg-nav-selected-bg",
                  )}
                >
                  <Icon aria-hidden="true" className="size-5" strokeWidth={1.5} />
                </span>
                {group.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
