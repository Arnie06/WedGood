"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EventActionState } from "@/server/events/actions";
import { createPartyLink, reissuePartyLink, revokePartyLink } from "@/server/events/party-actions";
import { Feedback, Hidden, LinkList } from "./event-forms";

const idle: EventActionState = { status: "idle" };

/**
 * Make, replace or revoke one party's link for all events (UX-06). One component per party so a
 * link shown once after "Make one link" stays visible when the page refreshes with the new party.
 */
export function PartyLinkControls({
  workspaceId,
  label,
  invitationIds,
  canCreate,
  party,
}: {
  workspaceId: string;
  label: string;
  invitationIds: string[];
  canCreate: boolean;
  party: { id: string; version: number } | null;
}) {
  const [keyBase, setKeyBase] = useState(() => crypto.randomUUID());
  const [created, createAction, creating] = useActionState(
    async (prev: EventActionState, form: FormData) => {
      const next = await createPartyLink(prev, form);
      if (next.status === "ok") setKeyBase(crypto.randomUUID());
      return next;
    },
    idle,
  );
  const [reissued, reissueAction, reissuing] = useActionState(reissuePartyLink, idle);
  const [revoked, revokeAction, revoking] = useActionState(revokePartyLink, idle);
  const busy = creating || reissuing || revoking;
  // The latest result wins: a revoke after a create hides the created link.
  const [last, setLast] = useState<"create" | "reissue" | "revoke" | null>(null);
  const shown =
    last === "create"
      ? created
      : last === "reissue"
        ? reissued
        : last === "revoke"
          ? revoked
          : idle;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {party === null && canCreate && (
          <form action={createAction} onSubmit={() => setLast("create")}>
            <Hidden values={{ workspaceId, idempotencyKey: keyBase }} />
            {invitationIds.map((id) => (
              <input key={id} type="hidden" name="invitationId" value={id} />
            ))}
            <Button type="submit" variant="secondary" disabled={busy}>
              {creating ? "Creating…" : "Make one link"}
              <span className="sr-only"> for {label}</span>
            </Button>
          </form>
        )}
        {party !== null && (
          <>
            <form action={reissueAction} onSubmit={() => setLast("reissue")}>
              <Hidden values={{ workspaceId, partyId: party.id, version: party.version, label }} />
              <Button type="submit" variant="secondary" disabled={busy}>
                New link<span className="sr-only"> for all events for {label}</span>
              </Button>
            </form>
            <form action={revokeAction} onSubmit={() => setLast("revoke")}>
              <Hidden values={{ workspaceId, partyId: party.id, version: party.version }} />
              <Button type="submit" variant="outline" disabled={busy}>
                Revoke<span className="sr-only"> the link for all events for {label}</span>
              </Button>
            </form>
          </>
        )}
      </div>
      <Feedback state={shown} />
      {shown.status === "ok" && shown.links && <LinkList links={shown.links} />}
    </div>
  );
}
