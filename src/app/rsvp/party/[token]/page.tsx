import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { formatEventDate } from "@/domain/events/event";
import { PartyRsvpForm } from "@/features/events/party-rsvp-form";
import { partyLinksEnabled } from "@/server/rsvp/flags";
import { lookupParty } from "@/server/rsvp/public";

// Token pages are private: never indexed, never cached, never leak the URL through Referer.
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const BROKEN =
  "This invitation link isn't working. It may have expired or been replaced. Please ask the couple for a new one.";

function Notice({ message }: { message: string }) {
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-xl space-y-6 px-4 py-10">
      <h1 className="font-serif text-headline-mobile">Invitation</h1>
      <Card>
        <p className="text-body-md">{message}</p>
      </Card>
    </main>
  );
}

/** One link for every event a party is invited to (UX-06). */
export default async function PartyRsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!partyLinksEnabled()) return <Notice message={BROKEN} />;
  const result = await lookupParty(token);
  if (result.kind !== "ok") {
    return (
      <Notice
        message={
          result.kind === "throttled"
            ? "Too many attempts. Please wait a few minutes and try again."
            : result.kind === "unavailable"
              ? "Responses aren't available right now. Please try again later."
              : BROKEN
        }
      />
    );
  }
  const view = result.view;
  if (view.events.length === 0) {
    return (
      <Notice message="There's nothing to answer on this link right now. Please contact the couple." />
    );
  }
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-label-lg text-ink-muted">{view.weddingName}</p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Your invitation</h1>
        <p className="text-body-md">
          Invitation for {view.label}. You&apos;re invited to{" "}
          {view.events.length === 1 ? "one event" : `${view.events.length} events`}. Answer them all
          here and send once.
        </p>
        <ul className="space-y-1 text-body-md text-ink-muted">
          {view.events.map((e) => {
            const date = formatEventDate(e.event.localDate);
            return (
              <li key={e.invitationId}>
                {e.event.name}
                {date ? ` · ${date}` : ""}
              </li>
            );
          })}
        </ul>
      </header>
      <PartyRsvpForm token={token} initial={view} />
    </main>
  );
}
