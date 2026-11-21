"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parsePackageRequest } from "@/domain/packages/catalog";
import { documentToCsv, type PackageMeta } from "@/domain/packages/csv";
import { TEMPLATE_VERSION } from "@/domain/packages/document";
import { buildDocument } from "@/domain/packages/sections";
import { capabilitiesFor } from "@/domain/permissions";
import { ForbiddenError, requireCapability } from "@/server/auth/workspace-guard";
import { createAdminClient } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";
import { documentDigest, sha256Hex } from "./digest";
import { PACKAGE_BUCKET } from "./constants";
import { friendlyPackageError } from "./errors";
import { renderPdf } from "./pdf";
import { loadProjection } from "./projection";

export type PackageActionState = { status: "idle" } | { status: "error"; message: string };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const uuid = z.uuid();
const CHANGED =
  "Your plan changed since the preview. Reload this page to review the updated preview.";

const fail = (message: string): PackageActionState => ({ status: "error", message });
const list = (form: FormData, key: string) =>
  form.getAll(key).filter((v): v is string => typeof v === "string");
const one = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

/**
 * Create a package: authorize, re-derive the document and require it to match the approved
 * preview digest and plan revision, render the files, store them privately, then record the
 * snapshot and file rows in one database call. Nothing is sent to anyone.
 */
export async function createPackage(
  _: PackageActionState,
  form: FormData,
): Promise<PackageActionState> {
  const ids = z
    .object({
      workspaceId: uuid,
      packageId: uuid,
      generatedAt: z.iso.datetime(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      revision: z.coerce.number().int().min(0),
    })
    .safeParse({
      workspaceId: form.get("workspaceId"),
      packageId: form.get("packageId"),
      generatedAt: form.get("generatedAt"),
      digest: form.get("digest"),
      revision: form.get("revision"),
    });
  if (!ids.success) return fail("Reload the page and try again.");
  const { workspaceId, packageId, generatedAt, digest, revision } = ids.data;
  if (Math.abs(Date.now() - Date.parse(generatedAt)) > 60 * 60 * 1000) {
    return fail("This preview is more than an hour old. Reload the page to start again.");
  }

  let access;
  try {
    access = await requireCapability(workspaceId, "exports.create");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return fail("Packages can only be created by the workspace owner or a partner.");
    }
    throw e;
  }
  const parsed = parsePackageRequest(
    {
      title: one(form, "title"),
      preset: one(form, "preset"),
      recipient: one(form, "recipient"),
      sections: list(form, "sections"),
      includeContacts: one(form, "includeContacts"),
      includeNotes: one(form, "includeNotes"),
      formats: list(form, "formats"),
      paper: one(form, "paper"),
      orientation: one(form, "orientation"),
    },
    capabilitiesFor(access.membership.role, access.membership.grants),
    access.wedding.name,
  );
  if (!parsed.ok) return fail("Please check the package details and try again.");
  if (parsed.dropped.length > 0) {
    return fail("Some chosen sections aren't available to your role. Reload to review.");
  }
  const request = parsed.value;

  const admin = createAdminClient();
  if (!admin) {
    return fail(
      "File storage isn't set up on this server yet, so no package was created. The owner needs to configure private storage.",
    );
  }

  const supabase = await createUserClient();
  const existing = await supabase.from("packages").select("id").eq("id", packageId).maybeSingle();
  if (existing.error) return fail(friendlyPackageError({}));
  if (existing.data) return done(workspaceId, packageId);

  const projection = await loadProjection(workspaceId, request.sections);
  const doc = buildDocument(request, projection);
  const actual = documentDigest(doc);
  if (actual !== digest || projection.revision !== revision) return fail(CHANGED);

  const meta: PackageMeta = { generatedAt, revision: projection.revision, digest: actual };
  const files: { format: "pdf" | "csv"; bytes: Uint8Array; type: string }[] = [];
  if (request.formats.includes("pdf")) {
    const pdf = await renderPdf(doc, meta, request.paper, request.orientation);
    files.push({ format: "pdf", bytes: pdf.bytes, type: "application/pdf" });
  }
  if (request.formats.includes("csv")) {
    files.push({
      format: "csv",
      bytes: new TextEncoder().encode(documentToCsv(doc, meta)),
      type: "text/csv",
    });
  }
  if (files.some((f) => f.bytes.byteLength > MAX_FILE_BYTES)) {
    return fail("This package is too large to create. Choose fewer sections.");
  }

  const keys: string[] = [];
  for (const f of files) {
    const key = `${workspaceId}/${packageId}.${f.format}`;
    // Equal input renders equal bytes, so a concurrent or repeated attempt overwrites with the same file.
    const stored = await admin.storage.from(PACKAGE_BUCKET).upload(key, f.bytes, {
      contentType: f.type,
      upsert: true,
      cacheControl: "0",
    });
    if (stored.error) {
      if (keys.length > 0) await admin.storage.from(PACKAGE_BUCKET).remove(keys);
      return fail("We couldn't store the files. Nothing was saved. Try again.");
    }
    keys.push(key);
  }

  const created = await supabase.rpc("create_package", {
    p_wedding: workspaceId,
    p_id: packageId,
    p_title: request.title,
    p_preset: request.preset,
    p_recipient: request.recipient,
    p_sections: request.sections,
    p_options: request.options,
    p_formats: request.formats,
    p_paper: request.paper,
    p_orientation: request.orientation,
    p_snapshot: doc,
    p_digest: actual,
    p_expected_revision: revision,
    p_template_version: TEMPLATE_VERSION,
    p_generated_at: generatedAt,
    p_artifacts: files.map((f) => ({
      format: f.format,
      checksum: sha256Hex(f.bytes),
      bytes: f.bytes.byteLength,
    })),
  });
  if (created.error) {
    // Keep the files if a concurrent identical submit already recorded the package.
    const now = await supabase.from("packages").select("id").eq("id", packageId).maybeSingle();
    if (!now.data) await admin.storage.from(PACKAGE_BUCKET).remove(keys);
    else return done(workspaceId, packageId);
    return fail(friendlyPackageError(created.error));
  }
  return done(workspaceId, packageId);
}

function done(workspaceId: string, packageId: string): never {
  revalidatePath(`/app/${workspaceId}/plan/packages`);
  redirect(`/app/${workspaceId}/plan/packages/${packageId}`);
}
