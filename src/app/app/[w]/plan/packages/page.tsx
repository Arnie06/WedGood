import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import { Card } from "@/components/ui/card";
import { presetDef } from "@/domain/packages/catalog";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadPackages, packageFreshness } from "@/server/packages/queries";

export const metadata: Metadata = { title: "Packages" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function PackagesPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const allowed = hasCapability(access, "exports.create");
  const packages = allowed ? await loadPackages(access.wedding.id) : [];
  const freshness = allowed ? await packageFreshness(access.wedding.id, packages) : new Map();
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));

  return (
    <div className="space-y-6">
      <WorkspacePageHeading
        title="Packages"
        description="Dated PDF and CSV copies of your plan for family, vendors and planners."
        actions={
          allowed && <ButtonLink href={`${base}/plan/packages/new`}>Create a package</ButtonLink>
        }
      />
      {!allowed ? (
        <Card>
          <p className="text-body-md">Only the workspace owner or a partner can see packages.</p>
        </Card>
      ) : (
        <>
          {packages.length === 0 ? (
            <Card>
              <p className="text-body-md text-ink-muted">
                No packages yet. Create one to hand a caterer their headcount, or keep a dated copy
                of your budget.
              </p>
            </Card>
          ) : (
            <ul className="record-list">
              {packages.map((p) => {
                const state = freshness.get(p.id) ?? "unknown";
                return (
                  <li key={p.id} className="space-y-1 px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h2 className="min-w-0 text-body-md font-semibold wrap-anywhere">
                        <Link
                          href={`${base}/plan/packages/${p.id}`}
                          className={`${link} inline-flex min-h-11 items-center`}
                        >
                          {p.title}
                        </Link>
                      </h2>
                      {state === "current" ? (
                        <Badge tone="confirmed">Matches your plan</Badge>
                      ) : state === "stale" ? (
                        <Badge tone="pending">Plan has changed</Badge>
                      ) : (
                        <Badge>Not checked</Badge>
                      )}
                    </div>
                    <p className="text-body-md text-ink-muted">
                      {presetDef(p.preset).label}
                      {p.recipient ? ` · for ${p.recipient}` : ""} · made {when(p.createdAt)} UTC ·
                      plan revision {p.revision}
                    </p>
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-md">
                      {p.artifacts.map((a) => (
                        <a
                          key={a.format}
                          href={`${base}/plan/packages/${p.id}/download?format=${a.format}`}
                          className={`${link} inline-flex min-h-11 items-center`}
                        >
                          Download {a.format.toUpperCase()}
                        </a>
                      ))}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
