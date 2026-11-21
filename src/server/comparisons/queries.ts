import "server-only";
import type { Criterion } from "@/domain/comparison/evaluate";
import type { SourceState } from "@/domain/comparison/staleness";
import { loadCandidatesByIds, type CandidateRecord } from "@/server/candidates/queries";
import { loadProposalsByIds, type ProposalRecord } from "@/server/proposals/queries";
import { createUserClient } from "@/server/supabase/server";

export type ComparisonSummary = {
  id: string;
  title: string;
  guestCount: number;
  optionCount: number;
  decided: boolean;
  createdAt: string;
};

export type ComparisonOption = {
  id: string;
  position: number;
  ratings: Record<string, number>;
  proposal: ProposalRecord | null;
  candidate: CandidateRecord | null;
};

export type DecisionRecord = {
  id: string;
  chosenProposalId: string;
  note: string | null;
  decidedAt: string;
  sourceState: SourceState;
  figures: unknown;
};

export type ComparisonRecord = {
  id: string;
  title: string;
  guestCount: number;
  currency: string;
  criteria: Criterion[];
  acceptsUnknowns: boolean;
  version: number;
  options: ComparisonOption[];
  decision: DecisionRecord | null;
  /** Past decisions on this comparison, newest first. */
  history: { id: string; chosenProposalId: string; decidedAt: string }[];
  /** The database's view of the inputs right now, to compare with the decision's. */
  currentState: SourceState;
};

function toCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: unknown) => {
    const o = c as { id?: unknown; label?: unknown; weight?: unknown };
    return typeof o.id === "string" && typeof o.label === "string" && typeof o.weight === "number"
      ? [{ id: o.id, label: o.label, weight: o.weight }]
      : [];
  });
}

function toRatings(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
  }
  return out;
}

export async function loadComparisons(workspaceId: string): Promise<ComparisonSummary[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("comparisons")
    .select("id, title, scenario_guest_count, created_at, comparison_options(id)")
    .eq("wedding_id", workspaceId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Could not load comparisons");
  const ids = (data ?? []).map((c) => c.id);
  const decided = new Set<string>();
  if (ids.length > 0) {
    const d = await supabase
      .from("decisions")
      .select("comparison_id")
      .eq("wedding_id", workspaceId)
      .is("superseded_at", null)
      .in("comparison_id", ids);
    if (d.error) throw new Error("Could not load decisions");
    for (const row of d.data ?? []) decided.add(row.comparison_id);
  }
  return (data ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    guestCount: c.scenario_guest_count,
    optionCount: Array.isArray(c.comparison_options) ? c.comparison_options.length : 0,
    decided: decided.has(c.id),
    createdAt: c.created_at,
  }));
}

export async function loadComparison(
  workspaceId: string,
  comparisonId: string,
): Promise<ComparisonRecord | null> {
  const supabase = await createUserClient();
  const { data: c, error } = await supabase
    .from("comparisons")
    .select(
      "id, title, scenario_guest_count, currency, criteria, accepts_unknowns, version, archived_at",
    )
    .eq("wedding_id", workspaceId)
    .eq("id", comparisonId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("Could not load this comparison");
  if (!c) return null;

  const [opts, decisions, state] = await Promise.all([
    supabase
      .from("comparison_options")
      .select("id, position, proposal_id, ratings")
      .eq("wedding_id", workspaceId)
      .eq("comparison_id", comparisonId)
      .order("position", { ascending: true }),
    supabase
      .from("decisions")
      .select("id, chosen_proposal_id, note, decided_at, source_state, snapshot, superseded_at")
      .eq("wedding_id", workspaceId)
      .eq("comparison_id", comparisonId)
      .order("decided_at", { ascending: false })
      .limit(20),
    supabase.rpc("comparison_source_state", { p_wedding: workspaceId, p_comparison: comparisonId }),
  ]);
  if (opts.error || decisions.error || state.error)
    throw new Error("Could not load this comparison");

  const proposals = await loadProposalsByIds(
    workspaceId,
    (opts.data ?? []).map((o) => o.proposal_id),
  );
  const candidates = await loadCandidatesByIds(workspaceId, [
    ...new Set(proposals.map((p) => p.candidateId)),
  ]);
  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  const candidateById = new Map(candidates.map((k) => [k.id, k]));

  const current = (decisions.data ?? []).find((d) => d.superseded_at === null) ?? null;
  const snapshot = current?.snapshot as { figures?: unknown } | undefined;
  return {
    id: c.id,
    title: c.title,
    guestCount: c.scenario_guest_count,
    currency: c.currency,
    criteria: toCriteria(c.criteria),
    acceptsUnknowns: c.accepts_unknowns,
    version: c.version,
    options: (opts.data ?? []).map((o) => {
      const proposal = proposalById.get(o.proposal_id) ?? null;
      return {
        id: o.id,
        position: o.position,
        ratings: toRatings(o.ratings),
        proposal,
        candidate: proposal ? (candidateById.get(proposal.candidateId) ?? null) : null,
      };
    }),
    decision: current
      ? {
          id: current.id,
          chosenProposalId: current.chosen_proposal_id,
          note: current.note,
          decidedAt: current.decided_at,
          sourceState: current.source_state as unknown as SourceState,
          figures: snapshot?.figures ?? null,
        }
      : null,
    history: (decisions.data ?? [])
      .filter((d) => d.superseded_at !== null)
      .map((d) => ({ id: d.id, chosenProposalId: d.chosen_proposal_id, decidedAt: d.decided_at })),
    currentState: state.data as unknown as SourceState,
  };
}
