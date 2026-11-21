import "server-only";
import {
  FORMATS,
  PAPERS,
  ORIENTATIONS,
  isPresetId,
  isSectionId,
  type Orientation,
  type PackageFormat,
  type Paper,
  type PackageRequest,
  type PresetId,
  type SectionId,
} from "@/domain/packages/catalog";
import {
  TEMPLATE_VERSION,
  parseStoredDocument,
  type PackageDocument,
} from "@/domain/packages/document";
import { buildDocument } from "@/domain/packages/sections";
import { createUserClient } from "@/server/supabase/server";
import { documentDigest } from "./digest";
import { loadProjection } from "./projection";

export type PackageSummary = {
  id: string;
  title: string;
  preset: PresetId;
  recipient: string;
  sections: SectionId[];
  options: { includeContacts: boolean; includeNotes: boolean };
  formats: PackageFormat[];
  paper: Paper;
  orientation: Orientation;
  digest: string;
  revision: number;
  templateVersion: number;
  generatedAt: string;
  createdAt: string;
  artifacts: { format: PackageFormat; bytes: number }[];
};
export type PackageDetail = PackageSummary & { document: PackageDocument | null };

const COLUMNS =
  "id, title, preset, recipient, sections, options, formats, paper, orientation, snapshot_digest, source_revision, template_version, generated_at, created_at, package_artifacts(format, bytes)";

type Row = {
  id: string;
  title: string;
  preset: string;
  recipient: string;
  sections: string[];
  options: unknown;
  formats: string[];
  paper: string;
  orientation: string;
  snapshot_digest: string;
  source_revision: number;
  template_version: number;
  generated_at: string;
  created_at: string;
  package_artifacts: { format: string; bytes: number }[];
};

function map(r: Row): PackageSummary {
  const o = (r.options ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    title: r.title,
    preset: isPresetId(r.preset) ? r.preset : "custom",
    recipient: r.recipient,
    sections: r.sections.filter(isSectionId),
    options: { includeContacts: o.includeContacts === true, includeNotes: o.includeNotes === true },
    formats: FORMATS.filter((f) => r.formats.includes(f)),
    paper: PAPERS.find((p) => p === r.paper) ?? "a4",
    orientation: ORIENTATIONS.find((p) => p === r.orientation) ?? "portrait",
    digest: r.snapshot_digest,
    revision: r.source_revision,
    templateVersion: r.template_version,
    generatedAt: r.generated_at,
    createdAt: r.created_at,
    artifacts: r.package_artifacts.flatMap((a) =>
      a.format === "pdf" || a.format === "csv" ? [{ format: a.format, bytes: a.bytes }] : [],
    ),
  };
}

/** RLS limits these rows to owner and partner. Pages also call requireWorkspace. */
export async function loadPackages(workspaceId: string): Promise<PackageSummary[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("packages")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .order("created_at", { ascending: false })
    .order("id")
    .limit(100);
  if (error) throw new Error("Could not load packages");
  return (data as Row[]).map(map);
}

export async function loadPackage(workspaceId: string, id: string): Promise<PackageDetail | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("packages")
    .select(`${COLUMNS}, snapshot`)
    .eq("wedding_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Could not load this package");
  if (!data) return null;
  return {
    ...map(data as unknown as Row),
    document: parseStoredDocument((data as unknown as { snapshot: unknown }).snapshot),
  };
}

export type Freshness = "current" | "stale" | "unknown";

/**
 * Re-derives each package's document from the live plan and compares digests. The result is only
 * a statement about the plan now; the stored snapshot and its files never change. Packages that
 * share a section list share one read.
 */
export async function packageFreshness(
  workspaceId: string,
  packages: readonly PackageSummary[],
): Promise<Map<string, Freshness>> {
  const out = new Map<string, Freshness>();
  const cache = new Map<string, Awaited<ReturnType<typeof loadProjection>> | null>();
  for (const p of packages) {
    const key = p.sections.join(",");
    if (!cache.has(key)) {
      try {
        cache.set(key, await loadProjection(workspaceId, p.sections));
      } catch {
        cache.set(key, null);
      }
    }
    const projection = cache.get(key);
    // A digest from another template version cannot be compared fairly.
    if (!projection || p.templateVersion !== TEMPLATE_VERSION) {
      out.set(p.id, "unknown");
      continue;
    }
    const req: PackageRequest = {
      title: p.title,
      preset: p.preset,
      recipient: p.recipient,
      sections: p.sections,
      options: p.options,
      formats: p.formats,
      paper: p.paper,
      orientation: p.orientation,
    };
    out.set(
      p.id,
      documentDigest(buildDocument(req, projection)) === p.digest ? "current" : "stale",
    );
  }
  return out;
}
