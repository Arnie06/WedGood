import "server-only";
import type { DocumentKind } from "@/domain/documents/validate";
import { isDocumentKind } from "@/domain/documents/validate";
import { createUserClient } from "@/server/supabase/server";

export type DocumentRecord = {
  id: string;
  kind: DocumentKind;
  title: string;
  mime: string;
  bytes: number;
  originalName: string | null;
  scanStatus: "pending" | "unscanned" | "clean" | "rejected";
  archived: boolean;
  version: number;
  createdAt: string;
};
export type DocumentLinkRecord = {
  id: string;
  documentId: string;
  targetType: "commitment" | "payment" | "candidate" | "proposal";
  targetId: string;
};
export type DocumentData = { documents: DocumentRecord[]; links: DocumentLinkRecord[] };

/**
 * Only owners and partners can read these rows (RLS). Pending and rejected uploads are not
 * listed: they never became documents. Pages also call requireWorkspace.
 */
export async function loadDocuments(workspaceId: string): Promise<DocumentData> {
  const supabase = await createUserClient();
  const [docs, links] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, kind, title, mime, bytes, original_name, scan_status, archived_at, version, created_at",
      )
      .eq("wedding_id", workspaceId)
      .in("scan_status", ["unscanned", "clean"])
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("document_links")
      .select("id, document_id, commitment_id, payment_id, candidate_id, proposal_id")
      .eq("wedding_id", workspaceId)
      .limit(5000),
  ]);
  if (docs.error || links.error) throw new Error("Could not load documents");
  return {
    documents: docs.data.map((d) => ({
      id: d.id,
      kind: isDocumentKind(d.kind) ? d.kind : "other",
      title: d.title,
      mime: d.mime,
      bytes: d.bytes,
      originalName: d.original_name,
      scanStatus: d.scan_status === "clean" ? "clean" : "unscanned",
      archived: d.archived_at !== null,
      version: d.version,
      createdAt: d.created_at,
    })),
    links: links.data.flatMap((l) => {
      const target = l.commitment_id
        ? ({ targetType: "commitment", targetId: l.commitment_id } as const)
        : l.payment_id
          ? ({ targetType: "payment", targetId: l.payment_id } as const)
          : l.candidate_id
            ? ({ targetType: "candidate", targetId: l.candidate_id } as const)
            : l.proposal_id
              ? ({ targetType: "proposal", targetId: l.proposal_id } as const)
              : null;
      return target ? [{ id: l.id, documentId: l.document_id, ...target }] : [];
    }),
  };
}
