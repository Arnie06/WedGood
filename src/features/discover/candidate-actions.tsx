"use client";

import { Star } from "lucide-react";
import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  archiveCandidate,
  setCandidateFavorite,
  type CandidateActionState,
} from "@/server/candidates/actions";

const idle: CandidateActionState = { status: "idle" };

/** One-tap favorite toggle. A retry or double tap is a no-op on the server. */
export function FavoriteButton({
  workspaceId,
  candidateId,
  name,
  favorite,
  disabled,
}: {
  workspaceId: string;
  candidateId: string;
  name: string;
  favorite: boolean;
  disabled: boolean;
}) {
  const [state, action, pending] = useTrayActionState(setCandidateFavorite, idle);
  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="favorite" value={favorite ? "false" : "true"} />
      <button
        type="submit"
        disabled={disabled || pending}
        aria-pressed={favorite}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-55",
          favorite ? "text-action-emphasis" : "text-ink-muted enabled:hover:text-action-emphasis",
        )}
      >
        <Star aria-hidden="true" className={cn("size-6", favorite && "fill-current")} />
      </button>
      {state.status === "error" && (
        <p role="alert" className="sr-only">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function ArchiveCandidateForm({
  workspaceId,
  candidateId,
  version,
}: {
  workspaceId: string;
  candidateId: string;
  version: number;
}) {
  const [state, action, pending] = useTrayActionState(archiveCandidate, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Removing…" : "Remove from my list"}
      </Button>
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
