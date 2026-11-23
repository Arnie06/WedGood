import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EventSwitcher } from "@/features/events/event-switcher";
import { MessageActions, PrepareMessages } from "@/features/guests/message-controls";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventRecords } from "@/server/events/queries";
import { loadGuests } from "@/server/guests/queries";
import { loadGuestMessages, type GuestMessageRecord } from "@/server/guests/messages";
import { getMailProvider } from "@/server/mail/provider";
import { guestEmailEnabled } from "@/server/rsvp/flags";

export const metadata: Metadata = { title: "Guest emails" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const KIND_LABEL = {
  rsvp_confirmation: "Reply confirmation",
  reply_reminder: "Reply reminder",
} as const;
const STALE_SENDING_MS = 10 * 60_000;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });

function statusOf(m: GuestMessageRecord, now: Date): { label: string; tone: BadgeTone } {
  switch (m.status) {
    case "draft":
      return { label: "Waiting for approval", tone: "pending" };
    case "failed":
      return { label: "Not sent", tone: "pending" };
    case "sending":
      return m.sendingSince && now.getTime() - new Date(m.sendingSince).getTime() > STALE_SENDING_MS
        ? { label: "Result unknown", tone: "pending" }
        : { label: "Sending", tone: "neutral" };
    case "sent":
      return m.provider === "dev-sink"
        ? { label: "Captured locally", tone: "neutral" }
        : { label: "Handed to email service", tone: "confirmed" };
    case "cancelled":
      return { label: "Discarded", tone: "neutral" };
  }
}

export default async function GuestMessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<{ event?: string | string[] }>;
}) {
  const { w } = await params;
  const access = await requireWorkspace(w);
  if (!guestEmailEnabled()) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest emails</h1>
        <Card>
          <p className="text-body-md">
            Guest emails hold guests&apos; addresses and replies, so they are limited to people who
            manage guests.
          </p>
        </Card>
      </div>
    );
  }

  const query = await searchParams;
  const requested = typeof query.event === "string" ? query.event : null;
  const events = await loadEventRecords(wid);
  const event = events.find((e) => e.id === requested) ?? events[0] ?? null;
  const provider = getMailProvider();
  const canSend = hasCapability(access, "external.send");
  const now = new Date();

  const [messages, guestData] = event
    ? await Promise.all([loadGuestMessages(wid, event.id), loadGuests(wid)])
    : [[], { guests: [] }];
  const guestName = new Map(guestData.guests.map((g) => [g.id, g.fullName]));
  const open = messages.filter(
    (m) => m.status === "draft" || m.status === "failed" || m.status === "sending",
  );
  const done = messages.filter((m) => m.status === "sent" || m.status === "cancelled");

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-3">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest emails</h1>
        <p className="text-body-lg text-ink-muted">
          Prepare a confirmation for guests who have replied, or a reminder for people you&apos;re
          still waiting on. Read each one first: nothing goes out until the workspace owner approves
          that email.
        </p>
        <p className="text-body-md" data-testid="guest-mail-status">
          {!provider.configured
            ? "Email sending isn't set up yet. You can prepare and read emails here, but none can be sent."
            : provider.captureOnly
              ? "Test mode: an approved email is captured here and is not delivered to anyone."
              : "Email sending is set up. An approved email is handed to the email service; we can't tell whether it was delivered or read."}
        </p>
        <p className="text-body-md text-ink-muted">
          Emails don&apos;t contain the guest&apos;s reply link, because links are only shown once
          when you make them. They ask guests to use the link from their invitation.
        </p>
        <Link
          href={`${base}/guests/invitations`}
          className={`${link} inline-flex min-h-11 items-center`}
        >
          Back to events and invitations
        </Link>
      </header>

      {!event ? (
        <Card>
          <p className="text-body-md">
            Add an event and invite guests first. Emails are prepared per event.
          </p>
        </Card>
      ) : (
        <>
          <section aria-labelledby="prepare-heading" className="space-y-4">
            <EventSwitcher
              base={base}
              events={events}
              currentId={event.id}
              hrefFor={(id) => `${base}/guests/messages?event=${id}`}
            />
            <Card className="space-y-3">
              <CardTitle id="prepare-heading">{event.name}</CardTitle>
              <p className="text-body-md text-ink-muted">
                Only guests with an email address are included, one email per address. Preparing
                again skips anyone who already has an email for the same replies (or a reminder
                today).
              </p>
              <PrepareMessages workspaceId={wid} eventId={event.id} eventName={event.name} />
            </Card>
          </section>

          <section aria-labelledby="review-heading" className="space-y-4">
            <h2 id="review-heading" className="font-serif text-headline-sm">
              To review ({open.length})
            </h2>
            {!canSend && open.length > 0 && (
              <p className="text-body-md text-ink-muted">
                Only the workspace owner can approve sending. You can read and discard emails.
              </p>
            )}
            {open.length === 0 ? (
              <p className="text-body-md text-ink-muted">
                Nothing waiting. Prepared emails appear here.
              </p>
            ) : (
              <ul className="space-y-4">
                {open.map((m) => (
                  <MessageCard
                    key={m.id}
                    message={m}
                    name={guestName.get(m.guestId) ?? "Guest"}
                    now={now}
                  >
                    {m.status === "sending" && statusOf(m, now).label === "Sending" ? (
                      <p className="text-body-md text-ink-muted">
                        Being sent now. Reload in a moment.
                      </p>
                    ) : (
                      <MessageActions
                        workspaceId={wid}
                        messageId={m.id}
                        version={m.version}
                        recipient={guestName.get(m.guestId) ?? m.recipientEmail}
                        canSend={canSend && provider.configured}
                        canDiscard={m.status !== "sending"}
                        retry={m.status !== "draft"}
                      />
                    )}
                    {m.status === "sending" && statusOf(m, now).label === "Result unknown" && (
                      <p className="text-body-md">
                        We didn&apos;t hear back about this one. Trying again uses the same email
                        reference, so the email service won&apos;t send it twice.
                      </p>
                    )}
                  </MessageCard>
                ))}
              </ul>
            )}
          </section>

          {done.length > 0 && (
            <section aria-labelledby="history-heading" className="space-y-4">
              <h2 id="history-heading" className="font-serif text-headline-sm">
                Sent and discarded ({done.length})
              </h2>
              <ul className="space-y-4">
                {done.map((m) => (
                  <MessageCard
                    key={m.id}
                    message={m}
                    name={guestName.get(m.guestId) ?? "Guest"}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function MessageCard({
  message: m,
  name,
  now,
  children,
}: {
  message: GuestMessageRecord;
  name: string;
  now: Date;
  children?: ReactNode;
}) {
  const status = statusOf(m, now);
  return (
    <Card as="li" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-label-lg font-semibold">
            {KIND_LABEL[m.kind]} to {name}
          </h3>
          <p className="break-all text-body-md text-ink-muted">{m.recipientEmail}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <details className="rounded-control border border-border-hairline">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-label-lg font-semibold">
          Read the email<span className="sr-only"> to {name}</span>
        </summary>
        <div className="space-y-2 border-t border-border-hairline px-4 py-3">
          <p className="text-body-md">
            <span className="font-semibold">Subject:</span> {m.subject}
          </p>
          <p className="whitespace-pre-wrap break-words text-body-md">{m.body}</p>
        </div>
      </details>
      <p className="text-body-md text-ink-muted">
        Prepared {when(m.createdAt)}
        {m.sentAt &&
          (m.provider === "dev-sink"
            ? ` · captured by the local test sink ${when(m.sentAt)}, not delivered`
            : ` · handed to the email service ${when(m.sentAt)}`)}
        {m.status === "failed" && m.lastError && ` · ${m.lastError}`}
      </p>
      {children}
    </Card>
  );
}
