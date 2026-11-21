import "server-only";
import { readDraft, type SiteDraft } from "@/domain/website/site";
import { createUserClient } from "@/server/supabase/server";

export type SiteRecord = {
  id: string;
  version: number;
  draft: SiteDraft;
  slug: string | null;
  published: boolean;
  publishedAt: string | null;
  draftRev: number;
  publishedDraftRev: number | null;
};

/** RLS limits the row to owners and partners. A wedding with no site yet returns null. */
export async function loadSite(workspaceId: string): Promise<SiteRecord | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("wedding_sites")
    .select("id, version, draft, slug, published_at, draft_rev, published_draft_rev")
    .eq("wedding_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("Could not load the guest website");
  if (!data) return null;
  return {
    id: data.id,
    version: data.version,
    draft: readDraft(data.draft),
    slug: data.slug,
    published: data.published_at !== null,
    publishedAt: data.published_at,
    draftRev: data.draft_rev,
    publishedDraftRev: data.published_draft_rev,
  };
}
