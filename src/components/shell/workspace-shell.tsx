import type { ReactNode } from "react";
import { Hallmark } from "./hallmark";
import { BottomNav, SidebarNav } from "./workspace-nav";

/**
 * Authenticated-workspace chrome: masthead, desktop sidebar (≥1024px) and
 * mobile/tablet bottom navigation. `notice` renders above page content (used
 * for the sample-data label in the preview).
 */
export function WorkspaceShell({
  basePath,
  workspaceName,
  badge,
  headerAction,
  notice,
  sidebarFooter,
  density = "comfortable",
  children,
}: {
  basePath: string;
  workspaceName: string;
  badge?: ReactNode;
  headerAction?: ReactNode;
  notice?: ReactNode;
  sidebarFooter?: ReactNode;
  /** List spacing for everything inside the workspace (UX-18). */
  density?: "comfortable" | "compact";
  children: ReactNode;
}) {
  return (
    <div
      data-density={density}
      className="min-h-dvh lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border-hairline bg-surface px-4 py-6 xl:px-5 lg:flex">
        <Hallmark />
        <SidebarNav basePath={basePath} />
        {sidebarFooter && <div className="mt-auto">{sidebarFooter}</div>}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="glass sticky top-0 z-20 border-b border-border-hairline">
          <div className="flex min-h-16 items-center justify-between gap-3 px-margin-mobile md:px-8 lg:px-12">
            <div className="flex min-w-0 items-center gap-3">
              <span className="shrink-0 lg:hidden">
                <Hallmark compact />
              </span>
              <div className="min-w-0">
                <p className="truncate font-serif text-headline-sm text-ink">{workspaceName}</p>
                {badge && <div className="sm:hidden">{badge}</div>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerAction}
              {badge && <div className="hidden sm:block">{badge}</div>}
            </div>
          </div>
        </header>

        {notice}

        <main
          id="main"
          tabIndex={-1}
          className="flex-1 px-margin-mobile pt-6 pb-32 md:px-8 lg:px-12 lg:pb-16"
        >
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      <BottomNav basePath={basePath} />
    </div>
  );
}
