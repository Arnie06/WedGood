import type { Metadata } from "next";
import Link from "next/link";
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
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Compare quotes</h1>
        <p className="text-body-lg text-ink-muted">
          Line up two to four quotes for the same number of guests. Costs you don&apos;t know yet
          stay visible, and nothing is booked when you choose.
        </p>
      </header>
      {canManage && <ButtonLink href={`${base}/discover/compare/new`}>New comparison</ButtonLink>}
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
        <ul className="space-y-3">
          {comparisons.map((c) => (
            <Card as="li" key={c.id} className="space-y-1 p-4 sm:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-serif text-headline-sm break-words">
                  <Link
                    href={`${base}/discover/compare/${c.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {c.title}
                  </Link>
                </h2>
                {c.decided && <Badge tone="confirmed">Decided</Badge>}
              </div>
              <p className="text-body-sm text-ink-muted">
                {c.optionCount} quotes · priced for {c.guestCount} guests
              </p>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}
