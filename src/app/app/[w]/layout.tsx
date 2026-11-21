import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { FormErrorFocus } from "@/components/ui/form-error-focus";
import { ToastProvider } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/domain/permissions";
import { signOut } from "@/server/auth/actions";
import { daysBetween, parseDateOnly, todayInZone } from "@/domain/dates/date-only";
import { requireWorkspace } from "@/server/auth/workspace-guard";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ w: string }>;
}) {
  const { w } = await params;
  // Guards every page beneath this layout; pages and actions re-check on their own.
  const access = await requireWorkspace(w);
  const days = access.wedding.date
    ? daysBetween(todayInZone(access.wedding.timezone), parseDateOnly(access.wedding.date))
    : null;
  const subtitle =
    days === null || days < 0
      ? undefined
      : days === 0
        ? "Today"
        : `${days} ${days === 1 ? "day" : "days"} to go`;
  return (
    <WorkspaceShell
      basePath={`/app/${access.wedding.id}`}
      workspaceName={access.wedding.name}
      workspaceSubtitle={subtitle}
      badge={<Badge tone="neutral">{ROLE_LABELS[access.membership.role]}</Badge>}
      sidebarFooter={
        <form action={signOut} className="space-y-2">
          <p className="truncate text-body-sm text-ink-muted">{access.user.email}</p>
          <Button type="submit" variant="outline" size="sm" className="w-full">
            Sign out
          </Button>
        </form>
      }
    >
      <ToastProvider>
        <FormErrorFocus />
        {children}
      </ToastProvider>
    </WorkspaceShell>
  );
}
