import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { NewBoardForm } from "@/features/design/design-forms";
import { Swatches } from "@/features/design/swatches";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBoards } from "@/server/design/queries";
import { unscannedDownloadsAllowed } from "@/server/supabase/admin";

export const metadata: Metadata = { title: "Design" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function DesignIndexPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}/design`;
  const canEdit = hasCapability(access, "plan.edit");
  const boards = await loadBoards(wid);
  const previews = unscannedDownloadsAllowed();

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Design</h1>
        <p className="text-body-lg text-ink-muted">
          Collect images, links and notes into boards, with a palette for each. Everything here is
          private to the people in your workspace.
        </p>
      </header>

      {boards.length === 0 && (
        <Card className="space-y-2">
          <CardTitle>No boards yet</CardTitle>
          <p className="text-body-md text-ink-muted">
            {canEdit
              ? "Start with a board for flowers, attire or the overall feel, then add what inspires you."
              : "The owner or a partner hasn't added a board yet."}
          </p>
        </Card>
      )}

      <ul className="space-y-3">
        {boards.map((b) => (
          <li key={b.id}>
            <Card className="space-y-3">
              <CardTitle>{b.title}</CardTitle>
              {b.description && <p className="text-body-md text-ink-muted">{b.description}</p>}
              <Swatches colors={b.palette} size="sm" />
              {previews && b.imageIds.length > 0 && (
                <ul className="grid grid-cols-4 gap-2" aria-hidden="true">
                  {b.imageIds.map((id) => (
                    <li key={id}>
                      {/* Auth-gated route that streams private bytes; next/image can't fetch it. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${base}/${b.id}/image/${id}`}
                        alt=""
                        loading="lazy"
                        className="aspect-square w-full rounded-control object-cover"
                      />
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-body-md text-ink-muted">
                {b.itemCount === 0
                  ? "Nothing saved yet"
                  : `${b.itemCount} ${b.itemCount === 1 ? "item" : "items"}`}
              </p>
              <Link
                href={`${base}/${b.id}`}
                className={`${link} inline-flex min-h-11 items-center`}
              >
                Open board<span className="sr-only">: {b.title}</span>
              </Link>
            </Card>
          </li>
        ))}
      </ul>

      {canEdit ? (
        <Card as="section" aria-labelledby="new-board" className="space-y-4">
          <CardTitle id="new-board">New board</CardTitle>
          <NewBoardForm workspaceId={wid} />
        </Card>
      ) : (
        <p className="text-body-md text-ink-muted">
          You can view boards. Only the owner and partner can change them.
        </p>
      )}
    </div>
  );
}
