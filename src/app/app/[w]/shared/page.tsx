import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { KIND_LABELS, subjectPath } from "@/domain/comments/comment";
import { ROLE_LABELS, can } from "@/domain/permissions";
import { formatCommentDate } from "@/features/comments/comments-section";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { loadRecentComments } from "@/server/comments/queries";

export const metadata: Metadata = { title: "Shared with you" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function SharedPage({ params }: { params: Promise<{ w: string }> }) {
  const { w } = await params;
  const access = await requireWorkspace(w);
  const base = `/app/${access.wedding.id}`;
  const { role, grants } = access.membership;
  const recent = await loadRecentComments(access.wedding.id);
  const canChange = can(role, "plan.edit", grants);

  return (
    <div className="max-w-xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Shared with you</h1>
        <p className="text-body-lg text-ink-muted">
          You&apos;re signed in as <Badge tone="neutral">{ROLE_LABELS[role]}</Badge>.{" "}
          {canChange
            ? "You can view and change the shared plan, and comment anywhere below."
            : "You can look through the shared choices and leave comments. Budgets, guests and documents stay private to the couple."}
        </p>
      </header>

      <section aria-labelledby="areas-heading" className="space-y-3">
        <h2 id="areas-heading" className="font-serif text-headline-sm">
          What you can see
        </h2>
        <ul className="space-y-2 text-body-md">
          <li>
            <Link href={`${base}/discover`} className={`${link} inline-flex min-h-11 items-center`}>
              Venues and vendors
            </Link>
          </li>
          <li>
            <Link
              href={`${base}/discover/compare`}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Comparisons
            </Link>
          </li>
          <li>
            <Link href={`${base}/design`} className={`${link} inline-flex min-h-11 items-center`}>
              Design boards
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="font-serif text-headline-sm">
          Recent comments
        </h2>
        {recent.length === 0 ? (
          <p className="text-body-md text-ink-muted">
            No comments yet. Open a venue, comparison or design board to start a conversation.
          </p>
        ) : (
          <ul className="space-y-3">
            {recent.map((c) => (
              <li key={c.id}>
                <Card className="space-y-2">
                  <p className="text-label-lg font-semibold">
                    {c.authorName}
                    <span className="font-normal text-ink-muted">
                      {" · "}
                      <time dateTime={c.createdAt}>{formatCommentDate(c.createdAt)}</time>
                    </span>
                  </p>
                  <p className="line-clamp-4 whitespace-pre-wrap break-words text-body-md">
                    {c.body}
                  </p>
                  <p className="text-body-sm text-ink-muted">
                    {KIND_LABELS[c.kind]}:{" "}
                    <Link
                      href={subjectPath(access.wedding.id, c.kind, c.subjectId)}
                      className={link}
                    >
                      {c.subjectTitle}
                    </Link>
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
