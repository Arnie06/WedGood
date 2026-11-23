"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useTrayClose } from "@/components/ui/tray";
import {
  dismissAttention,
  handleAttentionItem,
  restoreAttention,
  type AttentionActionState,
} from "@/server/attention/actions";

type Props = {
  workspaceId: string;
  /** What the button does. */
  mode: "dismiss" | "handle" | "restore";
  /** The item's title, so a screen reader hears which item the button is for. */
  itemTitle: string;
  kind: string;
  subjectId: string;
  fingerprint: string;
  /** The stored row, for "Mark handled". */
  storedId: string | null;
};

const LABELS = { dismiss: "Dismiss", handle: "Mark handled", restore: "Show again" } as const;

/**
 * One small button per item for owner and partner. Dismiss hides a computed item until it changes;
 * Mark handled closes a stored one; Show again undoes a dismissal. None of them change the wedding.
 */
export function AttentionButton({
  workspaceId,
  mode,
  itemTitle,
  kind,
  subjectId,
  fingerprint,
  storedId,
}: Props) {
  const { toast } = useToast();
  // Inside the item drawer, a successful action closes it (the item has moved lists).
  const closeTray = useTrayClose();
  const run =
    mode === "dismiss"
      ? dismissAttention
      : mode === "restore"
        ? restoreAttention
        : handleAttentionItem;
  const [state, action, pending] = useActionState(
    async (prev: AttentionActionState, form: FormData) => {
      const next = await run(prev, form);
      if (next.status === "ok") {
        toast({ message: next.message });
        closeTray();
      } else if (next.status === "error") toast({ message: next.message, tone: "error" });
      return next;
    },
    { status: "idle" } as AttentionActionState,
  );
  return (
    <form action={action}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {mode === "handle" ? (
        <input type="hidden" name="itemId" value={storedId ?? ""} />
      ) : (
        <>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="subjectId" value={subjectId} />
          {mode === "dismiss" && <input type="hidden" name="fingerprint" value={fingerprint} />}
        </>
      )}
      <Button
        type="submit"
        variant="quiet"
        size="sm"
        disabled={pending}
        aria-label={`${LABELS[mode]}: ${itemTitle}`}
      >
        {pending ? "Saving…" : LABELS[mode]}
      </Button>
      {state.status === "error" && (
        <p role="alert" className="sr-only">
          {state.message}
        </p>
      )}
    </form>
  );
}
