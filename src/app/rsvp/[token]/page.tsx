import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { EVENT_KIND_LABELS, formatEventDate, type EventKind } from "@/domain/events/event";
import { RsvpForm } from "@/features/events/rsvp-form";
import { lookupInvitation } from "@/server/rsvp/public";

// Token pages are private: never indexed, never cached, never leak the URL through Referer.
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-xl space-y-6 px-4 py-10">
      {children}
    </main>
  );
}

export default async function RsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await lookupInvitation(token);

  if (result.kind !== "ok") {
    const message =
      result.kind === "throttled"
        ? "Too many attempts. Please wait a few minutes and try again."
        : result.kind === "unavailable"
          ? "Responses aren't available right now. Please try again later."
          : "This invitation link isn't working. It may have expired or been replaced. Please ask the couple for a new one.";
    return (
      <Shell>
        <h1 className="font-serif text-headline-mobile">Invitation</h1>
        <Card>
          <p className="text-body-md">{message}</p>
        </Card>
      </Shell>
    );
  }

  const view = result.view;
  const date = formatEventDate(view.event.localDate);
  const kind = (view.event.kind in EVENT_KIND_LABELS ? view.event.kind : "other") as EventKind;
  return (
    <Shell>
      <header className="space-y-2">
        <p className="text-label-lg text-ink-muted">{view.weddingName}</p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{view.event.name}</h1>
        <p className="text-body-lg text-ink-muted">
          {EVENT_KIND_LABELS[kind]}
          {date ? ` · ${date}` : ""}
        </p>
        <p className="text-body-md">
          We&apos;d love to know whether you can join us. Invitation for {view.label}.
        </p>
      </header>
      <RsvpForm token={token} initial={view} />
    </Shell>
  );
}
