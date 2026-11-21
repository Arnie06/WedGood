import type { DocumentLinkRecord } from "@/server/documents/queries";

export type TargetLabels = Map<string, string>;

export const linkKey = (l: Pick<DocumentLinkRecord, "targetType" | "targetId">) =>
  `${l.targetType}:${l.targetId}`;

/** Where a document is attached, as readable labels. Unknown targets are labelled, not hidden. */
export function linksFor(
  documentId: string,
  links: readonly DocumentLinkRecord[],
  labels: TargetLabels,
): { key: string; label: string }[] {
  return links
    .filter((l) => l.documentId === documentId)
    .map((l) => ({ key: linkKey(l), label: labels.get(linkKey(l)) ?? "An item that was removed" }));
}
