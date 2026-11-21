import "server-only";
import type { CommentKind } from "@/domain/comments/comment";
import { isCommentKind } from "@/domain/comments/comment";
import { createUserClient } from "@/server/supabase/server";

export type CommentRow = {
  id: string;
  body: string;
  authorName: string;
  isMine: boolean;
  version: number;
  createdAt: string;
  edited: boolean;
};
export type RecentComment = {
  id: string;
  kind: CommentKind;
  subjectId: string;
  subjectTitle: string;
  body: string;
  authorName: string;
  createdAt: string;
};

const name = (v: string | null) => v ?? "A collaborator";

/** Members only (the RPC re-checks). Pages also call requireWorkspace. */
export async function loadComments(
  workspaceId: string,
  kind: CommentKind,
  subjectId: string,
): Promise<CommentRow[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("list_comments", {
    p_wedding: workspaceId,
    p_kind: kind,
    p_subject: subjectId,
  });
  if (error) throw new Error("Could not load comments");
  return (data ?? []).map((r) => ({
    id: r.id,
    body: r.body,
    authorName: name(r.author_name),
    isMine: r.is_mine,
    version: r.version,
    createdAt: r.created_at,
    edited: r.edited_at !== null,
  }));
}

export async function loadRecentComments(workspaceId: string): Promise<RecentComment[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("recent_comments", {
    p_wedding: workspaceId,
    p_limit: 30,
  });
  if (error) throw new Error("Could not load comments");
  return (data ?? []).flatMap((r) =>
    isCommentKind(r.subject_kind)
      ? [
          {
            id: r.id,
            kind: r.subject_kind,
            subjectId: r.subject_id,
            subjectTitle: r.subject_title ?? "Removed item",
            body: r.body,
            authorName: name(r.author_name),
            createdAt: r.created_at,
          },
        ]
      : [],
  );
}
