import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { PACKAGE_BUCKET } from "@/server/packages/constants";
import { sha256Hex } from "@/server/packages/digest";
import { createAdminClient } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("Not found", { status: 404 });

function fileName(title: string, format: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "wedding-package"}.${format}`;
}

/**
 * Authorizes the signed-in user (owner or partner, through RLS), then reads the private file with
 * the service role and checks it against the checksum recorded at creation. A fixed copy: the
 * file is the snapshot as it was generated.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ w: string; id: string }> },
) {
  const { w, id } = await params;
  const access = await requireWorkspace(w);
  if (!hasCapability(access, "exports.create") || !UUID.test(id)) return notFound();
  const format = new URL(request.url).searchParams.get("format");
  if (format !== "pdf" && format !== "csv") return notFound();

  const supabase = await createUserClient();
  const { data: art } = await supabase
    .from("package_artifacts")
    .select("storage_key, checksum_sha256, bytes, packages!inner(title)")
    .eq("wedding_id", access.wedding.id)
    .eq("package_id", id)
    .eq("format", format)
    .maybeSingle();
  if (!art) return notFound();
  const pkg = Array.isArray(art.packages) ? art.packages[0] : art.packages;

  const admin = createAdminClient();
  if (!admin) {
    return new Response("Downloads aren't set up on this server.", { status: 503 });
  }
  const file = await admin.storage.from(PACKAGE_BUCKET).download(art.storage_key);
  if (file.error) return new Response("The file could not be read.", { status: 502 });
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (bytes.byteLength !== art.bytes || sha256Hex(bytes) !== art.checksum_sha256) {
    return new Response("The stored file failed its integrity check, so it was not sent.", {
      status: 500,
    });
  }
  return new Response(bytes, {
    headers: {
      "content-type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName(pkg?.title ?? "", format)}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
