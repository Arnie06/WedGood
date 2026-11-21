import { NextResponse } from "next/server";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { unscannedDownloadsAllowed } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const plain = (status: number, body: string) =>
  new NextResponse(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Authorizes as the signed-in user, then hands out a 60-second signed URL created with that
 * user's own session, so the storage policy independently re-checks role, archive and scan state.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ w: string; documentId: string }> },
) {
  const { w, documentId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(documentId) || !hasCapability(access, "budget.manage"))
    return plain(404, "Not found");

  const supabase = await createUserClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("title, mime, storage_key, scan_status, archived_at")
    .eq("id", documentId)
    .eq("wedding_id", access.wedding.id)
    .maybeSingle();
  if (!doc || doc.archived_at !== null || !["unscanned", "clean"].includes(doc.scan_status)) {
    return plain(404, "Not found");
  }
  if (doc.scan_status === "unscanned" && !unscannedDownloadsAllowed()) {
    return plain(
      403,
      "Downloads are turned off until a malware scanner is configured for this workspace's server.",
    );
  }
  const safeName = `${
    doc.title
      .replace(/[^\p{L}\p{N} ._-]+/gu, "")
      .trim()
      .slice(0, 80) || "document"
  }.${EXTENSIONS[doc.mime] ?? "bin"}`;
  const signed = await supabase.storage
    .from("wedding-documents")
    .createSignedUrl(doc.storage_key, 60, { download: safeName });
  if (signed.error || !signed.data) return plain(404, "Not found");
  const response = NextResponse.redirect(signed.data.signedUrl, 302);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
