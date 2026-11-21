import "server-only";
import type { ProposalLine } from "@/domain/proposals/normalize";
import { createUserClient } from "@/server/supabase/server";

export type ProposalRecord = {
  id: string;
  candidateId: string;
  title: string;
  currency: string;
  receivedOn: string | null;
  validUntil: string | null;
  sourceUrl: string | null;
  notes: string | null;
  status: "open" | "declined";
  version: number;
  archived: boolean;
  lines: (ProposalLine & { evidence: string | null })[];
};

const COLUMNS =
  "id, candidate_id, title, currency, received_on, valid_until, source_url, notes, status, version, archived_at, proposal_lines(id, position, created_at, description, cost_mode, amount_minor, quantity, min_qty, max_qty, rate_bp, percent_base, required, certainty, included_in_line_id, evidence)";

type LineRow = {
  id: string;
  position: number;
  created_at: string;
  description: string;
  cost_mode: string;
  amount_minor: number | null;
  quantity: number | null;
  min_qty: number | null;
  max_qty: number | null;
  rate_bp: number | null;
  percent_base: boolean;
  required: boolean;
  certainty: string;
  included_in_line_id: string | null;
  evidence: string | null;
};
type Row = {
  id: string;
  candidate_id: string;
  title: string;
  currency: string;
  received_on: string | null;
  valid_until: string | null;
  source_url: string | null;
  notes: string | null;
  status: string;
  version: number;
  archived_at: string | null;
  proposal_lines: LineRow[];
};

const MODES = ["fixed", "per_guest", "quantity", "percent", "included"] as const;

function map(r: Row): ProposalRecord {
  const lines = [...r.proposal_lines]
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .map((l) => ({
      id: l.id,
      description: l.description,
      costMode: MODES.find((m) => m === l.cost_mode) ?? "fixed",
      amountMinor: l.amount_minor,
      quantity: l.quantity,
      minQty: l.min_qty,
      maxQty: l.max_qty,
      rateBp: l.rate_bp,
      percentBase: l.percent_base,
      required: l.required,
      certainty: l.certainty === "estimated" ? ("estimated" as const) : ("quoted" as const),
      includedInLineId: l.included_in_line_id,
      evidence: l.evidence,
    }));
  return {
    id: r.id,
    candidateId: r.candidate_id,
    title: r.title,
    currency: r.currency,
    receivedOn: r.received_on,
    validUntil: r.valid_until,
    sourceUrl: r.source_url,
    notes: r.notes,
    status: r.status === "declined" ? "declined" : "open",
    version: r.version,
    archived: r.archived_at !== null,
    lines,
  };
}

/** Non-archived proposals of one candidate. RLS limits this to members. */
export async function loadProposalsForCandidate(
  workspaceId: string,
  candidateId: string,
): Promise<ProposalRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("proposals")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .eq("candidate_id", candidateId)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new Error("Could not load quotes");
  return (data as unknown as Row[]).map(map);
}

export async function loadProposal(
  workspaceId: string,
  candidateId: string,
  proposalId: string,
): Promise<ProposalRecord | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("proposals")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .eq("candidate_id", candidateId)
    .eq("id", proposalId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("Could not load this quote");
  return data ? map(data as unknown as Row) : null;
}

/** Quotes by id, archived ones included, so a comparison can say a quote was removed. */
export async function loadProposalsByIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<ProposalRecord[]> {
  if (ids.length === 0) return [];
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("proposals")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .in("id", [...ids]);
  if (error) throw new Error("Could not load these quotes");
  return (data as unknown as Row[]).map(map);
}

/** Open, non-archived quotes across the wedding, for choosing what to compare. */
export async function loadComparableProposals(workspaceId: string): Promise<ProposalRecord[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("proposals")
    .select(COLUMNS)
    .eq("wedding_id", workspaceId)
    .eq("status", "open")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error("Could not load your quotes");
  return (data as unknown as Row[]).map(map);
}
