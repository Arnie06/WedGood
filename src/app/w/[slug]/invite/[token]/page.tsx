import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { SiteView } from "@/features/website/site-view";
import { lookupInvitedSite } from "@/server/website/public";

// Token pages are private: never indexed, never cached, never leak the URL through Referer.
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function InvitedSitePage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const result = await lookupInvitedSite(slug, token);
  if (result.kind !== "ok") {
    const message =
      result.kind === "throttled"
        ? "Too many attempts. Please wait a few minutes and try again."
        : result.kind === "unavailable"
          ? "This page isn't available right now. Please try again later."
          : "This invitation link isn't working. It may have expired or been replaced. Please ask the couple for a new one.";
    return (
      <main id="main" className="mx-auto min-h-dvh max-w-xl space-y-6 px-4 py-10">
        <h1 className="font-serif text-headline-mobile">Invitation</h1>
        <Card>
          <p className="text-body-md">{message}</p>
        </Card>
      </main>
    );
  }
  return (
    <main id="main" className="min-h-dvh">
      <SiteView site={result.site} rsvpHref={`/rsvp/${encodeURIComponent(token)}`} />
    </main>
  );
}
