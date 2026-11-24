import type { Metadata } from "next";
import Link from "next/link";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadComparisons } from "@/server/comparisons/queries";

export const metadata: Metadata = { title: "Compare quotes" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function ComparePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canManage = hasCapability(access, "vendors.manage");
  const comparisons = await loadComparisons(access.wedding.id);
  return (
    <div className="space-y-6">
      <WorkspacePageHeading
        title="Compare quotes"
        description="Compare two to four quotes using the same guest count."
        actions={
          canManage && <ButtonLink href={`${base}/discover/compare/new`}>New comparison</ButtonLink>
        }
      />
      {comparisons.length === 0 ? (
        <Card>
          <p className="text-body-md text-ink-muted">
            No comparisons yet. Add quotes to at least two venues or vendors first, then compare
            them here.{" "}
            <Link href={`${base}/discover`} className={link}>
              Go to venues &amp; vendors
            </Link>
          </p>
        </Card>
      ) : (
        <ul className="record-list">
          {comparisons.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-x-4 px-4 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 text-body-md font-semibold wrap-anywhere">
                  <Link
                    href={`${base}/discover/compare/${c.id}`}
                    className={`${link} inline-flex min-h-11 items-center`}
                  >
                    {c.title}
                  </Link>
                </h2>
                {c.decided && <Badge tone="confirmed">Decided</Badge>}
              </div>
              <p className="text-body-sm text-ink-muted">
                {c.optionCount} quotes · priced for {c.guestCount} guests
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
