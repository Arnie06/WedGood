/**
 * Vendor pipeline stages (docs/06-DATA-MODEL.md). "booked" and "cancelled" are part of the
 * vocabulary but are only reachable through the booking flow (R1-07), which needs a reviewed
 * commitment, so the pipeline controls here never offer them.
 */
export const PIPELINE_STAGES = [
  { value: "saved", label: "Saved", hint: "On your list" },
  { value: "contacted", label: "Contacted", hint: "You've reached out" },
  { value: "proposal_received", label: "Proposal received", hint: "They sent a quote" },
  { value: "considering", label: "Considering", hint: "Seriously weighing them" },
  { value: "booked", label: "Booked", hint: "Recorded with a commitment" },
  { value: "declined", label: "Passed", hint: "Not moving forward" },
  { value: "cancelled", label: "Cancelled", hint: "Booking was cancelled" },
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number]["value"];

/** Stages a person can move a venue or vendor to today. */
export const MOVABLE_STAGES: readonly PipelineStage[] = [
  "saved",
  "contacted",
  "proposal_received",
  "considering",
  "declined",
];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return PIPELINE_STAGES.some((s) => s.value === value);
}

export function stageLabel(stage: string): string {
  return PIPELINE_STAGES.find((s) => s.value === stage)?.label ?? "Saved";
}

/**
 * Open stages move freely among each other and to "declined"; "declined" can be reopened.
 * Booked and cancelled records are never changed by this control.
 */
export function canMoveStage(from: PipelineStage, to: PipelineStage): boolean {
  if (from === "booked" || from === "cancelled") return false;
  return MOVABLE_STAGES.includes(to);
}

/** Stages the couple is still actively working on (everything but passed/cancelled). */
export function isActiveStage(stage: PipelineStage): boolean {
  return stage !== "declined" && stage !== "cancelled";
}
