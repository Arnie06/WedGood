import type { OptionInput } from "@/domain/comparison/evaluate";
import type { ComparisonOption, ComparisonRecord } from "@/server/comparisons/queries";

export function optionLabel(o: ComparisonOption): string {
  const name = o.candidate?.name ?? "Removed venue or vendor";
  return o.proposal ? `${name}: ${o.proposal.title}` : name;
}

/** A quote that was archived or is gone can't be priced; it stays visible but is left out. */
export function isRemoved(o: ComparisonOption): boolean {
  return o.proposal === null || o.proposal.archived || o.candidate === null;
}

export function toOptionInputs(c: ComparisonRecord): OptionInput[] {
  return c.options.flatMap((o) => {
    if (isRemoved(o) || !o.proposal || !o.candidate) return [];
    return [
      {
        id: o.id,
        proposalId: o.proposal.id,
        label: optionLabel(o),
        kind: o.candidate.kind,
        seatedCapacity: o.candidate.seatedCapacity,
        currency: o.proposal.currency,
        lines: o.proposal.lines,
        ratings: o.ratings,
      },
    ];
  });
}
