import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { IMAGE_MIME_TYPES, RIGHTS_SHORT, displayHost } from "@/domain/design/board";
import {
  AddItemForm,
  ArchiveBoardForm,
  EditBoardForm,
  EditItemForm,
  FavoriteButton,
  MoveButtons,
  RemoveItemForm,
  UploadImageForm,
} from "@/features/design/design-forms";
import { CommentsSection } from "@/features/comments/comments-section";
import { Swatches } from "@/features/design/swatches";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBoard, loadVendorOptions } from "@/server/design/queries";
import { unscannedDownloadsAllowed } from "@/server/supabase/admin";

export const metadata: Metadata = { title: "Design board" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string; boardId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { w, boardId } = await params;
  const { view } = await searchParams;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}/design`;
  if (!UUID.test(boardId)) notFound();
  const [board, vendorRows] = await Promise.all([loadBoard(wid, boardId), loadVendorOptions(wid)]);
  if (!board) notFound();
  const canEdit = hasCapability(access, "plan.edit");
  const previews = unscannedDownloadsAllowed();
  const vendors = vendorRows.map((v) => ({ id: v.id, label: `${v.name} (${v.category})` }));
  const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));
  const favoritesOnly = view === "favorites";
  const favoriteCount = board.items.filter((i) => i.favorite).length;
  const shown = favoritesOnly ? board.items.filter((i) => i.favorite) : board.items;

  return (
    <div className="max-w-4xl space-y-8">
      <header className="space-y-3">
        <p>
          <Link href={base} className={`${link} inline-flex min-h-11 items-center`}>
            All boards
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{board.title}</h1>
        {board.description && <p className="text-body-lg text-ink-muted">{board.description}</p>}
        <Swatches colors={board.palette} />
      </header>

      <nav aria-label="Board view" className="flex flex-wrap gap-4">
        <Link
          href={`${base}/${board.id}`}
          aria-current={favoritesOnly ? undefined : "page"}
          className={`${link} inline-flex min-h-11 items-center`}
        >
          All ({board.items.length})
        </Link>
        <Link
          href={`${base}/${board.id}?view=favorites`}
          aria-current={favoritesOnly ? "page" : undefined}
          className={`${link} inline-flex min-h-11 items-center`}
        >
          Favourites ({favoriteCount})
        </Link>
      </nav>

      {!previews && board.items.some((i) => i.kind === "image") && (
        <p className="rounded-control border border-border-hairline bg-surface p-4 text-body-md text-ink-muted">
          Image previews are off until a malware scanner is configured on this server. Your images
          are stored privately and listed below.
        </p>
      )}

      {shown.length === 0 && (
        <Card className="space-y-2">
          <CardTitle>{favoritesOnly ? "No favourites yet" : "Nothing saved yet"}</CardTitle>
          <p className="text-body-md text-ink-muted">
            {favoritesOnly
              ? "Mark an item as a favourite and it will show up here."
              : canEdit
                ? "Add an image, a link or a note below."
                : "Nothing has been added to this board yet."}
          </p>
        </Card>
      )}

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((item) => {
          const index = board.items.findIndex((i) => i.id === item.id);
          const host = item.url ? displayHost(item.url) : "";
          return (
            <li key={item.id}>
              <Card as="article" className="h-full space-y-3 p-4 sm:p-4">
                {item.kind === "image" &&
                  (previews ? (
                    <>
                      {/* Auth-gated route that streams private bytes; next/image can't fetch it. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${base}/${board.id}/image/${item.id}`}
                        alt={item.title}
                        loading="lazy"
                        className="aspect-[4/3] w-full rounded-control object-cover"
                      />
                    </>
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center rounded-control bg-status-neutral-bg p-3 text-center text-body-sm text-status-neutral-fg">
                      Preview off · {item.title}
                    </div>
                  ))}
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-serif text-headline-sm text-ink">{item.title}</h2>
                  {item.favorite && <Badge tone="ceremony">Favourite</Badge>}
                </div>
                {item.kind === "link" && item.url && (
                  <p className="text-body-md break-words">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                      className={link}
                    >
                      Open {host || "link"}
                      <span className="sr-only"> (opens in a new tab): {item.title}</span>
                    </a>
                  </p>
                )}
                {item.note && (
                  <p className="text-body-md whitespace-pre-line text-ink-muted">{item.note}</p>
                )}
                <p className="text-body-sm text-ink-muted">
                  {item.kind === "image" && item.rights ? `${RIGHTS_SHORT[item.rights]}` : null}
                  {item.candidateId && vendorName.get(item.candidateId)
                    ? `${item.kind === "image" ? " · " : ""}For ${vendorName.get(item.candidateId)}`
                    : null}
                </p>
                {canEdit && (
                  <div className="space-y-3 border-t border-border-hairline pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <FavoriteButton
                        workspaceId={wid}
                        itemId={item.id}
                        version={item.version}
                        favorite={item.favorite}
                        title={item.title}
                      />
                      {!favoritesOnly && (
                        <MoveButtons
                          workspaceId={wid}
                          itemId={item.id}
                          title={item.title}
                          first={index === 0}
                          last={index === board.items.length - 1}
                        />
                      )}
                    </div>
                    <details className="space-y-3">
                      <summary
                        className={`${link} inline-flex min-h-11 cursor-pointer items-center`}
                      >
                        Edit or remove<span className="sr-only">: {item.title}</span>
                      </summary>
                      <div className="space-y-6 pt-3">
                        <EditItemForm
                          workspaceId={wid}
                          vendors={vendors}
                          item={{
                            id: item.id,
                            kind: item.kind,
                            version: item.version,
                            title: item.title,
                            note: item.note ?? "",
                            url: item.url ?? "",
                            candidateId: item.candidateId ?? "",
                            rights: item.rights,
                          }}
                        />
                        <RemoveItemForm
                          workspaceId={wid}
                          itemId={item.id}
                          version={item.version}
                          title={item.title}
                        />
                      </div>
                    </details>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      {canEdit ? (
        <div className="space-y-6">
          <Card as="section" aria-labelledby="add-image" className="space-y-4">
            <CardTitle id="add-image">Add an image</CardTitle>
            <UploadImageForm
              workspaceId={wid}
              boardId={board.id}
              vendors={vendors}
              accept={IMAGE_MIME_TYPES.join(",")}
            />
          </Card>
          <Card as="section" aria-labelledby="add-link" className="space-y-4">
            <CardTitle id="add-link">Save a link</CardTitle>
            <AddItemForm workspaceId={wid} boardId={board.id} kind="link" vendors={vendors} />
          </Card>
          <Card as="section" aria-labelledby="add-note" className="space-y-4">
            <CardTitle id="add-note">Add a note</CardTitle>
            <AddItemForm workspaceId={wid} boardId={board.id} kind="note" vendors={vendors} />
          </Card>
          <Card as="section" aria-labelledby="edit-board" className="space-y-4">
            <CardTitle id="edit-board">Board details and palette</CardTitle>
            <EditBoardForm
              workspaceId={wid}
              boardId={board.id}
              version={board.version}
              title={board.title}
              description={board.description ?? ""}
              palette={board.palette.join(" ")}
            />
            <ArchiveBoardForm
              workspaceId={wid}
              boardId={board.id}
              version={board.version}
              basePath={base}
            />
          </Card>
        </div>
      ) : (
        <p className="text-body-md text-ink-muted">
          You can view this board. Only the owner and partner can change it.
        </p>
      )}
      <CommentsSection
        workspaceId={wid}
        role={access.membership.role}
        kind="design_board"
        subjectId={board.id}
      />
    </div>
  );
}
