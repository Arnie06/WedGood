import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { PublicSite } from "@/domain/website/site";
import { SiteView } from "@/features/website/site-view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventData } from "@/server/events/queries";
import { loadSite } from "@/server/website/queries";

export const metadata: Metadata = {
  title: "Website preview",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/** The saved draft, only for signed-in owners and partners. Never reachable without a session. */
export default async function WebsitePreviewPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!hasCapability(access, "plan.edit")) notFound();
  const wid = access.wedding.id;
  const [site, eventData] = await Promise.all([loadSite(wid), loadEventData(wid)]);
  if (!site) notFound();
  const d = site.draft;
  const byId = new Map(eventData.events.map((e) => [e.id, e]));
  const preview: PublicSite = {
    template: d.template,
    title: d.title,
    ...(d.tagline !== undefined && { tagline: d.tagline }),
    ...(d.date !== undefined && { date: d.date }),
    ...(d.location !== undefined && { location: d.location }),
    ...(d.story !== undefined && { story: d.story }),
    ...(d.travel !== undefined && { travel: d.travel }),
    faq: d.faq,
    registry: d.registry,
    events: d.events.flatMap((x) => {
      const e = byId.get(x.eventId);
      if (!e) return [];
      return [
        {
          name: e.name,
          kind: e.kind,
          ...(e.localDate !== null && { localDate: e.localDate }),
          visibility: x.visibility,
          ...(x.when !== undefined && { when: x.when }),
          ...(x.where !== undefined && { where: x.where }),
          ...(x.notes !== undefined && { notes: x.notes }),
        },
      ];
    }),
  };
  return (
    <div>
      <p className="px-4 pt-2">
        <Link
          href={`/app/${wid}/website`}
          className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to the editor
        </Link>
      </p>
      <SiteView
        site={preview}
        banner="Draft preview. Only you can see this page. Nothing here is public until you publish."
      />
    </div>
  );
}
