import { Card } from "@/components/ui/card";
import { canDeleteComment, type CommentKind } from "@/domain/comments/comment";
import type { MembershipRole } from "@/domain/permissions";
import { loadComments } from "@/server/comments/queries";
import { AddCommentForm, CommentActions } from "./comment-forms";

export function formatCommentDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Comment thread for one subject. Every member, viewers included, can read and post. */
export async function CommentsSection({
  workspaceId,
  role,
  kind,
  subjectId,
}: {
  workspaceId: string;
  role: MembershipRole;
  kind: CommentKind;
  subjectId: string;
}) {
  const comments = await loadComments(workspaceId, kind, subjectId);
  return (
    <section aria-labelledby="comments-heading" className="space-y-4">
      <h2 id="comments-heading" className="font-serif text-headline-sm">
        Comments
      </h2>
      {comments.length === 0 ? (
        <p className="text-body-md text-ink-muted">
          No comments yet. Share a thought with the people planning with you.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id}>
              <Card className="space-y-2">
                <p className="text-label-lg font-semibold">
                  {c.authorName}
                  {c.isMine && <span className="font-normal text-ink-muted"> (you)</span>}
                  <span className="font-normal text-ink-muted">
                    {" · "}
                    <time dateTime={c.createdAt}>{formatCommentDate(c.createdAt)}</time>
                    {c.edited && " · edited"}
                  </span>
                </p>
                <p className="whitespace-pre-wrap break-words text-body-md">{c.body}</p>
                <CommentActions
                  workspaceId={workspaceId}
                  commentId={c.id}
                  version={c.version}
                  body={c.body}
                  canEdit={c.isMine}
                  canDelete={canDeleteComment(role, c.isMine)}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
      <AddCommentForm workspaceId={workspaceId} kind={kind} subjectId={subjectId} />
    </section>
  );
}
