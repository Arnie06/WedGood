"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/text-area-field";
import { MAX_COMMENT_LENGTH, type CommentKind } from "@/domain/comments/comment";
import {
  addComment,
  deleteComment,
  editComment,
  type CommentActionState,
} from "@/server/comments/actions";

const idle: CommentActionState = { status: "idle" };

function Feedback({ state }: { state: CommentActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

function Hidden({ values }: { values: Record<string, string | number> }) {
  return Object.entries(values).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

export function AddCommentForm({
  workspaceId,
  kind,
  subjectId,
}: {
  workspaceId: string;
  kind: CommentKind;
  subjectId: string;
}) {
  const [base] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (prev: CommentActionState, form: FormData) => {
      const next = await addComment(prev, form);
      // A new key only after a finished attempt; a double submit reuses the same key.
      setAttempt((n) => n + 1);
      return next;
    },
    idle,
  );
  const posted = state.status === "ok";
  return (
    <form
      action={formAction}
      className="space-y-3"
      noValidate
      // Remount after success so the box clears; after an error the typed text is echoed back.
      key={posted ? `ok-${attempt}` : "form"}
    >
      <Hidden values={{ workspaceId, kind, subjectId, idempotencyKey: `${base}-${attempt}` }} />
      <TextAreaField
        label="Add a comment"
        name="body"
        required
        maxLength={MAX_COMMENT_LENGTH}
        defaultValue={state.status === "error" ? state.body : ""}
        hint="Everyone in this workspace can read comments. Plain text only."
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Posting…" : "Post comment"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function CommentActions({
  workspaceId,
  commentId,
  version,
  body,
  canEdit,
  canDelete,
}: {
  workspaceId: string;
  commentId: string;
  version: number;
  body: string;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "edit" | "confirm">("idle");
  const [editState, editAction, editing] = useActionState(
    async (prev: CommentActionState, form: FormData) => {
      const next = await editComment(prev, form);
      if (next.status === "ok") setMode("idle");
      return next;
    },
    idle,
  );
  const [delState, delAction, deleting] = useActionState(deleteComment, idle);

  if (mode === "edit") {
    return (
      <form action={editAction} className="space-y-3" noValidate>
        <Hidden values={{ workspaceId, commentId, version }} />
        <TextAreaField
          label="Edit your comment"
          name="body"
          required
          maxLength={MAX_COMMENT_LENGTH}
          defaultValue={editState.status === "error" ? editState.body : body}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={editing}>
            {editing ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
        <Feedback state={editState} />
      </form>
    );
  }
  if (mode === "confirm") {
    return (
      <form action={delAction} className="space-y-2">
        <Hidden values={{ workspaceId, commentId }} />
        <p className="text-body-md">Delete this comment? This can&apos;t be undone.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={deleting}>
            {deleting ? "Deleting…" : "Yes, delete"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode("idle")}>
            Keep
          </Button>
        </div>
        <Feedback state={delState} />
      </form>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <Button type="button" size="sm" variant="outline" onClick={() => setMode("edit")}>
          Edit
        </Button>
      )}
      {canDelete && (
        <Button type="button" size="sm" variant="outline" onClick={() => setMode("confirm")}>
          Delete
        </Button>
      )}
    </div>
  );
}
