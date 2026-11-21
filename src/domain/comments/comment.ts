/** Comment rules shared by the form, the server action and (re-checked) the database. */

export const COMMENT_KINDS = ["candidate", "comparison", "design_board"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
export const MAX_COMMENT_LENGTH = 2000;

export function isCommentKind(value: unknown): value is CommentKind {
  return typeof value === "string" && (COMMENT_KINDS as readonly string[]).includes(value);
}

export const KIND_LABELS: Record<CommentKind, string> = {
  candidate: "Venue or vendor",
  comparison: "Comparison",
  design_board: "Design board",
};

export type ParsedComment = { ok: true; body: string } | { ok: false; error: string };

/** Trims, rejects empty and over-long text. Stored and rendered as plain text, never HTML. */
export function parseCommentBody(raw: string): ParsedComment {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) return { ok: false, error: "Write a comment first." };
  if ([...body].length > MAX_COMMENT_LENGTH) {
    return { ok: false, error: `Keep comments under ${MAX_COMMENT_LENGTH} characters.` };
  }
  return { ok: true, body };
}

/** In-app route for a comment subject; always under the caller's own workspace path. */
export function subjectPath(workspaceId: string, kind: CommentKind, subjectId: string): string {
  const base = `/app/${workspaceId}`;
  switch (kind) {
    case "candidate":
      return `${base}/discover/${subjectId}`;
    case "comparison":
      return `${base}/discover/compare/${subjectId}`;
    case "design_board":
      return `${base}/design/${subjectId}`;
  }
}

/** Whether `actor` may delete: authors always, owner and partner as moderators. */
export function canDeleteComment(
  role: "owner" | "partner" | "editor" | "viewer",
  isMine: boolean,
): boolean {
  return isMine || role === "owner" || role === "partner";
}
