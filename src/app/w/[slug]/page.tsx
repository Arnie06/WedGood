import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteView } from "@/features/website/site-view";
import { lookupPublishedSite } from "@/server/website/public";

// Always read live so an unpublish takes effect immediately and nothing stale is cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const result = await lookupPublishedSite((await params).slug);
  if (result.kind !== "ok")
    return { title: "Wedding website", robots: { index: false, follow: false } };
  return {
    title: result.site.title,
    ...(result.site.tagline !== undefined && { description: result.site.tagline }),
    referrer: "strict-origin-when-cross-origin",
  };
}

export default async function PublicSitePage({ params }: Props) {
  const result = await lookupPublishedSite((await params).slug);
  if (result.kind === "missing") notFound();
  if (result.kind === "unavailable") {
    return (
      <main id="main" className="mx-auto min-h-dvh max-w-xl px-4 py-10">
        <h1 className="font-serif text-headline-mobile">Wedding website</h1>
        <p className="mt-4 text-body-md">
          This page isn&apos;t available right now. Please try again later.
        </p>
      </main>
    );
  }
  if (result.kind !== "ok") notFound();
  return (
    <main id="main" className="min-h-dvh">
      <SiteView site={result.site} />
    </main>
  );
}
