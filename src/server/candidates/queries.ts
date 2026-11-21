import "server-only";
import type { CandidateKind, PriceBasis } from "@/domain/candidates/categories";
import { isPipelineStage, type PipelineStage } from "@/domain/proposals/stages";
import { createUserClient } from "@/server/supabase/server";

export type CandidateRecord = {
  id: string;
  kind: CandidateKind;
  category: string;
  name: string;
  sourceUrl: string | null;
  sourceCheckedOn: string | null;
  location: string | null;
  pricingDisplay: string | null;
  priceMinor: number | null;
  priceBasis: PriceBasis | null;
  priceCurrency: string | null;
  notes: string | null;
  isFavorite: boolean;
  seatedCapacity: number | null;
  ceremonyCapacity: number | null;
  version: number;
  stage: PipelineStage;
};

const COLUMNS =
  "id, kind, category, name, source_url, source_checked_on, location, pricing_display, price_minor, price_basis, price_currency, notes, is_favorite, version, stage, venues(seated_capacity, ceremony_capacity)";

type Row = {
  id: string;
  kind: string;
  category: string;
  name: string;
  source_url: string | null;
  source_checked_on: string | null;
  location: string | null;
  pricing_display: string | null;
  price_minor: number | null;
  price_basis: string | null;
  price_currency: string | null;
  notes: string | null;
  is_favorite: boolean;
  version: number;
  stage: string;
  venues:
    | { seated_capacity: number | null; ceremony_capacity: number | null }
    | null
    | { seated_capacity: number | null; ceremony_capacity: number | null }[];
};

function map(r: Row): CandidateRecord {
  const venue = Array.isArray(r.venues) ? r.venues[0] : r.venues;
  return {
    id: r.id,
    kind: r.kind === "venue" ? "venue" : "vendor",
    category: r.category,
    name: r.name,
    sourceUrl: r.source_url,
    sourceCheckedOn: r.source_checked_on,
    location: r.location,
    pricingDisplay: r.pricing_display,
    priceMinor: r.price_minor,
    priceBasis: r.price_basis === "total" || r.price_basis === "per_guest" ? r.price_basis : null,
    priceCurrency: r.price_currency,
    notes: r.notes,
    isFavorite: r.is_favorite,
    seatedCapacity: venue?.seated_capacity ?? null,
    ceremonyCapacity: venue?.ceremony_capacity ?? null,
    version: r.version,
    stage: isPipelineStage(r.stage) ? r.stage : "saved",
  };
}

/** Non-archived candidates. RLS limits this to members; callers also use requireWorkspace. */
export async function loadCandidates(workspaceId: string): Promise<CandidateRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error("Could not load saved venues and vendors");
  return (data as unknown as Row[]).map(map);
}

export async function loadCandidate(
  workspaceId: string,
  candidateId: string,
): Promise<CandidateRecord | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .eq("id", candidateId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("Could not load this venue or vendor");
  return data ? map(data as unknown as Row) : null;
}

/** Candidates by id, archived ones included, for comparisons that outlive an archive. */
export async function loadCandidatesByIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<CandidateRecord[]> {
  if (ids.length === 0) return [];
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .in("id", [...ids]);
  if (error) throw new Error("Could not load these venues and vendors");
  return (data as unknown as Row[]).map(map);
}
