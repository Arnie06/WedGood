import { NextResponse } from "next/server";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { unscannedDownloadsAllowed } from "@/server/supabase/admin";
import { createUserClient } from "@/server/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const plain = (status: number, body: string) =>
  new NextResponse(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Streams one board image to a signed-in member. The bytes are read with the member's own session,
 * so the storage policy independently re-checks membership, board and item state. The stored type
 * is served with nosniff and a sandboxing CSP; nothing is cached by shared caches.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ w: string; boardId: string; itemId: string }> },
) {
  const { w, boardId, itemId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(boardId) || !UUID.test(itemId) || !hasCapability(access, "design.view")) {
    return plain(404, "Not found");
  }
  if (!unscannedDownloadsAllowed()) {
    return plain(
      403,
      "Image previews are turned off until a malware scanner is configured for this server.",
    );
  }
  const supabase = await createUserClient();
  const { data: item } = await supabase
    .from("design_items")
    .select("mime, storage_key, kind")
    .eq("id", itemId)
    .eq("board_id", boardId)
    .eq("wedding_id", access.wedding.id)
    .maybeSingle();
  if (
    !item ||
    item.kind !== "image" ||
    !item.storage_key ||
    !item.mime ||
    !IMAGE_TYPES.has(item.mime)
  ) {
    return plain(404, "Not found");
  }
  const file = await supabase.storage.from("wedding-design").download(item.storage_key);
  if (file.error || !file.data) return plain(404, "Not found");
  return new NextResponse(file.data, {
    status: 200,
    headers: {
      "content-type": item.mime,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=60",
      "referrer-policy": "no-referrer",
    },
  });
}
