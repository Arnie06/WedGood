import { FlaskConical } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { Badge } from "@/components/ui/badge";
import { SAMPLE_DATA_LABEL, sampleWorkspace } from "@/features/preview/sample-workspace";

export const metadata: Metadata = {
  title: { default: "Workspace preview", template: "%s · Preview · Wedding Workspace" },
  robots: { index: false, follow: false },
};

export default function PreviewLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceShell
      basePath="/preview"
      workspaceName={sampleWorkspace.name}
      badge={<Badge tone="pending">{SAMPLE_DATA_LABEL}</Badge>}
      notice={
        <div
          role="note"
          aria-label="About this preview"
          className="border-b border-border-hairline bg-surface-muted"
        >
          <p className="mx-auto flex max-w-6xl items-start gap-2 px-margin-mobile py-3 text-body-sm text-ink md:px-8 lg:px-12">
            <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
            <span>
              <strong className="font-semibold">
                This is a preview with fictional sample data.
              </strong>{" "}
              Alex &amp; Morgan aren&apos;t real, and nothing here is saved, sent or shared.
            </span>
          </p>
        </div>
      }
      sidebarFooter={
        <p className="text-body-sm text-ink-muted">Preview only. Accounts aren&apos;t open yet.</p>
      }
    >
      {children}
    </WorkspaceShell>
  );
}
