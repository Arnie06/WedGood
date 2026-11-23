import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { publicationState, publicPath, suggestSlug } from "@/domain/website/site";
import { PublishForm, SiteForm, UnpublishForm } from "@/features/website/website-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventData } from "@/server/events/queries";
import { loadSite } from "@/server/website/queries";
import { emptyDraft } from "@/domain/website/site";

export const metadata: Metadata = { title: "Guest website" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

const STATE_LABEL = {
  draft: ["Draft, not public", "pending"],
  published: ["Published", "confirmed"],
  "published-with-changes": ["Published, with unpublished changes", "pending"],
  unpublished: ["Unpublished, not public", "neutral"],
} as const;

export default async function WebsitePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;

  if (!hasCapability(access, "plan.edit") || !hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest website</h1>
        <Card>
          <p className="text-body-md">
            The guest website is managed by the workspace owner and partner, and by planners they
            have given both Guests and Plan access. You can ask them to share the link once it is
            published.
          </p>
        </Card>
      </div>
    );
  }

  const [site, eventData] = await Promise.all([loadSite(wid), loadEventData(wid)]);
  const events = eventData.events.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    localDate: e.localDate,
  }));
  const draft = site?.draft ?? emptyDraft(access.wedding.name);
  const state = site
    ? publicationState({
        published: site.published,
        everPublished: site.slug !== null,
        draftRev: site.draftRev,
        publishedDraftRev: site.publishedDraftRev,
      })
    : "draft";
  const [label, tone] = STATE_LABEL[state];
  const version = site?.version ?? 0;

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest website</h1>
        <p className="text-body-lg text-ink-muted">
          A simple page for your guests. It stays private until you publish it, and it only ever
          shows what you write here.
        </p>
        <p className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Badge tone={tone}>{label}</Badge>
          {site?.published && site.slug && (
            <Link
              href={publicPath(site.slug)}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Open public page
            </Link>
          )}
        </p>
      </header>

      <Card as="section" aria-labelledby="site-edit" className="space-y-4">
        <CardTitle id="site-edit">Write the page</CardTitle>
        <SiteForm workspaceId={wid} version={version} draft={draft} events={events} />
      </Card>

      {site ? (
        <>
          <Card as="section" aria-labelledby="site-preview" className="space-y-3">
            <CardTitle id="site-preview">Preview</CardTitle>
            <p className="text-body-md text-ink-muted">
              See the saved draft exactly as guests would, including events shared with invited
              guests only. Only signed-in owners and partners can open the preview.
            </p>
            <Link
              href={`${base}/website/preview`}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Preview the saved draft
            </Link>
          </Card>

          <Card as="section" aria-labelledby="site-publish" className="space-y-4">
            <CardTitle id="site-publish">{site.published ? "Publication" : "Publish"}</CardTitle>
            {state === "published-with-changes" && (
              <p className="text-body-md">
                Your public page still shows the version you last published. Publish again to share
                your latest saved draft.
              </p>
            )}
            {hasCapability(access, "site.publish") ? (
              <PublishForm
                workspaceId={wid}
                version={version}
                suggestedSlug={suggestSlug(draft.title)}
                currentSlug={site.slug}
                republish={site.published}
              />
            ) : (
              <p className="text-body-md text-ink-muted" data-testid="publish-reserved">
                Only the owner and partner can publish the website. Save your draft and ask them to
                publish it.
              </p>
            )}
            {site.published && <UnpublishForm workspaceId={wid} version={version} />}
          </Card>
        </>
      ) : (
        <Card>
          <p className="text-body-md">
            Save your first draft to unlock the preview and publishing.
          </p>
        </Card>
      )}
    </div>
  );
}
