"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Hidden } from "@/features/events/event-forms";
import {
  discardGuestMessage,
  prepareGuestMessages,
  sendGuestMessage,
  type GuestMessageActionState,
} from "@/server/guests/message-actions";

const idle: GuestMessageActionState = { status: "idle" };

function Feedback({ state }: { state: GuestMessageActionState }) {
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

/** "Prepare confirmations" and "Prepare reminders" for one event. Prepares drafts; sends nothing. */
export function PrepareMessages({
  workspaceId,
  eventId,
  eventName,
}: {
  workspaceId: string;
  eventId: string;
  eventName: string;
}) {
  const [state, action, pending] = useActionState(prepareGuestMessages, idle);
  const [which, setWhich] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap gap-3">
        <Hidden values={{ workspaceId, eventId }} />
        <Button
          type="submit"
          name="kind"
          value="rsvp_confirmation"
          variant="secondary"
          disabled={pending}
          onClick={() => setWhich("rsvp_confirmation")}
        >
          {pending && which === "rsvp_confirmation" ? "Preparing…" : "Prepare confirmations"}
          <span className="sr-only"> for {eventName}</span>
        </Button>
        <Button
          type="submit"
          name="kind"
          value="reply_reminder"
          variant="outline"
          disabled={pending}
          onClick={() => setWhich("reply_reminder")}
        >
          {pending && which === "reply_reminder" ? "Preparing…" : "Prepare reminders"}
          <span className="sr-only"> for {eventName}</span>
        </Button>
      </form>
      <Feedback state={state} />
    </div>
  );
}

/** Approve-and-send (owner only) and discard for one draft or failed message. */
export function MessageActions({
  workspaceId,
  messageId,
  version,
  recipient,
  canSend,
  canDiscard,
  retry,
}: {
  workspaceId: string;
  messageId: string;
  version: number;
  recipient: string;
  canSend: boolean;
  canDiscard: boolean;
  retry: boolean;
}) {
  const { toast } = useToast();
  // A successful send or discard moves the card to the history list, which unmounts this
  // component and its inline feedback, so success is announced as a toast too.
  const withToast =
    (run: typeof sendGuestMessage) =>
    async (prev: GuestMessageActionState, form: FormData): Promise<GuestMessageActionState> => {
      const next = await run(prev, form);
      if (next.status === "ok") toast({ message: next.message });
      return next;
    };
  const [sent, sendAction, sending] = useActionState(withToast(sendGuestMessage), idle);
  const [discarded, discardAction, discarding] = useActionState(
    withToast(discardGuestMessage),
    idle,
  );
  const [last, setLast] = useState<"send" | "discard" | null>(null);
  const shown = last === "send" ? sent : last === "discard" ? discarded : idle;
  const busy = sending || discarding;
  const values = { workspaceId, messageId, version };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {canSend && (
          <form action={sendAction} onSubmit={() => setLast("send")}>
            <Hidden values={values} />
            <Button type="submit" variant="emphasis" size="sm" disabled={busy}>
              {sending ? "Sending…" : retry ? "Try again" : "Approve and send"}
              <span className="sr-only"> to {recipient}</span>
            </Button>
          </form>
        )}
        {canDiscard && (
          <form action={discardAction} onSubmit={() => setLast("discard")}>
            <Hidden values={values} />
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              {discarding ? "Discarding…" : "Discard"}
              <span className="sr-only"> the email to {recipient}</span>
            </Button>
          </form>
        )}
      </div>
      <Feedback state={shown} />
    </div>
  );
}
