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
  workspaceSubtitle,
  badge,
  notice,
  sidebarFooter,
  children,
}: {
  basePath: string;
  workspaceName: string;
  workspaceSubtitle?: string | undefined;
  badge?: ReactNode;
  notice?: ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border-hairline bg-canvas px-5 py-6 lg:flex">
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
                {workspaceSubtitle && (
                  <p className="truncate text-body-sm text-ink-muted">{workspaceSubtitle}</p>
                )}
              </div>
            </div>
            {badge}
          </div>
        </header>

        {notice}

        <main
          id="main"
          tabIndex={-1}
          className="flex-1 px-margin-mobile pt-8 pb-32 md:px-8 lg:px-12 lg:pb-16"
        >
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      <BottomNav basePath={basePath} />
    </div>
  );
}
