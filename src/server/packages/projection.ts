import "server-only";
import { summarizeBudget, type ItemCounts } from "@/domain/budget/summary";
import { summarizeResponses } from "@/domain/guests/rsvp";
import type { SectionId } from "@/domain/packages/catalog";
import type {
  AgendaIn,
  BoardIn,
  DecisionIn,
  DocumentIn,
  EventIn,
  GuaranteeIn,
  PaymentsIn,
  ProjectionInput,
  RsvpIn,
  SeatingIn,
  VendorIn,
} from "@/domain/packages/sections";
import { todayInZone } from "@/domain/dates/date-only";
import { staleReasons } from "@/domain/comparison/staleness";
import { buildSeatingPlan, snapshotState } from "@/domain/seating/plan";
import { loadBudget, loadItemCounts } from "@/server/budget/queries";
import { loadCandidates } from "@/server/candidates/queries";
import { loadComparison, loadComparisons } from "@/server/comparisons/queries";
import { loadBoard, loadBoards } from "@/server/design/queries";
import { loadDocuments } from "@/server/documents/queries";
import { loadEventData } from "@/server/events/queries";
import { loadGuarantees } from "@/server/events/guarantee";
import { loadLedger } from "@/server/ledger/queries";
import { loadSeating } from "@/server/seating/queries";
import { createUserClient } from "@/server/supabase/server";
import { loadTimeline } from "@/server/timeline/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

/**
 * Reads only the data the chosen sections need, as the signed-in user (so RLS still applies) and
 * reuses the same loaders and domain functions the pages use, so a package can never disagree with
 * the screen it came from. The result feeds `buildDocument`.
 *
 * These are several reads, not one database snapshot. The preview digest is therefore re-checked
 * at creation (see actions.ts) and a package is judged stale by digest, never by this read alone.
 */
export async function loadProjection(
  workspaceId: string,
  sections: readonly SectionId[],
): Promise<ProjectionInput & { revision: number }> {
  const want = new Set(sections);
  const supabase = await createUserClient();
  const [settings, rev] = await Promise.all([
    loadWeddingSettings(workspaceId),
    supabase.from("weddings").select("revision").eq("id", workspaceId).single(),
  ]);
  if (rev.error) throw new Error("Could not read the plan revision");

  const needEvents =
    want.has("events") || want.has("timeline") || want.has("rsvp") || want.has("seating");
  const needLedger = want.has("budget") || want.has("payments");
  const [eventData, ledger, budgetData, candidates, documents, boards, comparisons] =
    await Promise.all([
      needEvents ? loadEventData(workspaceId) : null,
      needLedger ? loadLedger(workspaceId) : null,
      want.has("budget") ? loadBudget(workspaceId) : null,
      want.has("vendors") ? loadCandidates(workspaceId) : null,
      want.has("documents") ? loadDocuments(workspaceId) : null,
      want.has("design") ? loadBoards(workspaceId) : null,
      want.has("decisions") ? loadComparisons(workspaceId) : null,
    ]);

  const eventCounts: ReadonlyMap<string, ItemCounts> = budgetData
    ? await loadItemCounts(workspaceId, budgetData.items)
    : new Map();

  const events: EventIn[] = (eventData?.events ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    localDate: e.localDate,
    targetAttendance: e.targetAttendance,
    capacity: e.capacity,
  }));

  const timeline: AgendaIn[] = [];
  if (want.has("timeline")) {
    for (const e of events) {
      for (const t of await loadTimeline(workspaceId, e.id)) {
        timeline.push({
          eventId: e.id,
          title: t.title,
          startsAt: t.startsAt,
          endsAt: t.endsAt,
          timezone: t.timezone,
          cancelled: t.status === "cancelled",
          location: t.location,
          responsible: t.responsibleLabel,
          contact: t.contact,
          notes: t.notes,
        });
      }
    }
  }

  const vendors: VendorIn[] = (candidates ?? []).map((c) => ({
    name: c.name,
    kind: c.kind,
    category: c.category,
    stage: c.stage,
    location: c.location,
  }));

  const budget =
    budgetData && ledger
      ? summarizeBudget({
          targetMinor: settings.targetBudgetMinor,
          reserveBp: budgetData.reserveBp,
          guestCount: settings.targetGuestCount,
          eventCounts,
          categories: budgetData.categories,
          items: budgetData.items,
          commitments: ledger.commitments
            .filter((c) => c.status === "active")
            .map((c) => ({ id: c.id, amountMinor: c.amountMinor, status: c.status })),
          allocations: ledger.allocations
            .filter((a) => a.active)
            .map((a) => ({
              commitmentId: a.commitmentId,
              budgetItemId: a.budgetItemId,
              amountMinor: a.amountMinor,
            })),
          payments: ledger.payments
            .filter((p) => !p.voided)
            .map((p) => ({
              id: p.id,
              commitmentId: p.commitmentId,
              budgetItemId: p.budgetItemId,
              kind: p.kind,
              amountMinor: p.amountMinor,
            })),
        })
      : null;

  const payments: PaymentsIn | null =
    want.has("payments") && ledger
      ? {
          commitments: ledger.commitments.map((c) => ({
            id: c.id,
            title: c.title,
            amountMinor: c.amountMinor,
            status: c.status,
            signedOn: c.signedOn,
          })),
          payments: ledger.payments
            .filter((p) => !p.voided)
            .map((p) => ({
              commitmentId: p.commitmentId,
              kind: p.kind,
              amountMinor: p.amountMinor,
            })),
          installments: ledger.installments.map((i) => ({
            commitmentId: i.commitmentId,
            dueOn: i.dueOn,
            amountMinor: i.amountMinor,
            label: i.label,
          })),
        }
      : null;

  const rsvp: RsvpIn[] = [];
  if (want.has("rsvp") && eventData) {
    for (const e of eventData.events) {
      const members = eventData.members.filter((m) => m.eventId === e.id && m.active);
      if (members.length === 0) continue;
      const s = summarizeResponses(
        members.map((m) => ({
          guestId: m.guestId,
          eligible: true,
          rsvpStatus: m.status,
          mealOptionId: m.mealOptionId,
        })),
      );
      rsvp.push({
        eventId: e.id,
        invited: s.invited,
        accepted: s.accepted,
        pending: s.pending,
        declined: s.declined,
        acceptedWithoutMeal: s.acceptedWithoutMeal,
        meals: eventData.mealOptions
          .filter((m) => m.eventId === e.id)
          .map((m) => ({ name: m.name, accepted: s.mealCounts.get(m.id) ?? 0 }))
          .filter((m) => m.accepted > 0),
      });
    }
  }

  // Locked caterer counts (REL-08). Packages are owner and partner only, so RLS returns them.
  const guarantees: GuaranteeIn[] = [];
  if (want.has("rsvp")) {
    for (const [eventId, g] of await loadGuarantees(workspaceId)) {
      if (!g.current) continue;
      guarantees.push({
        eventId,
        count: g.current.count,
        lockedOn: todayInZone(settings.timezone, new Date(g.current.lockedAt)),
        dueOn: g.current.dueOn,
        revisions: g.history.length,
      });
    }
  }

  const seating: SeatingIn[] = [];
  if (want.has("seating")) {
    for (const e of events) {
      const data = await loadSeating(workspaceId, e.id);
      if (!data) continue;
      if (!data.layout) {
        seating.push({
          eventId: e.id,
          hasLayout: false,
          state: "none",
          accepted: 0,
          confirmedSeated: 0,
          tentativeSeated: 0,
          unassignedAccepted: 0,
          tables: [],
        });
        continue;
      }
      const plan = buildSeatingPlan({
        guests: data.guests,
        members: data.members,
        tables: data.tables,
        assignments: data.assignments,
        meals: data.meals,
        allowTentative: data.layout.allowTentative,
      });
      seating.push({
        eventId: e.id,
        hasLayout: true,
        state: snapshotState(data.layout),
        accepted: plan.totals.accepted,
        confirmedSeated: plan.totals.confirmedSeated,
        tentativeSeated: plan.totals.tentativeSeated,
        unassignedAccepted: plan.totals.unassignedAccepted,
        tables: plan.tables.map((t) => ({
          label: t.label,
          capacity: t.capacity,
          confirmed: t.confirmed.length,
          tentative: t.tentative.length,
          open: t.open,
        })),
      });
    }
  }

  const boardsIn: BoardIn[] = [];
  for (const b of boards ?? []) {
    const detail = await loadBoard(workspaceId, b.id);
    if (!detail) continue;
    boardsIn.push({
      title: detail.title,
      description: detail.description,
      palette: detail.palette,
      items: detail.items.map((i) => ({ kind: i.kind, title: i.title, note: i.note })),
    });
  }

  const documentsIn: DocumentIn[] = (documents?.documents ?? [])
    .filter((d) => !d.archived)
    .map((d) => ({ title: d.title, kind: d.kind, addedOn: d.createdAt.slice(0, 10) }));

  const decisions: DecisionIn[] = [];
  for (const c of (comparisons ?? []).filter((x) => x.decided).slice(0, 25)) {
    const full = await loadComparison(workspaceId, c.id);
    if (!full?.decision) continue;
    const chosen = full.options.find((o) => o.proposal?.id === full.decision?.chosenProposalId);
    decisions.push({
      title: full.title,
      guestCount: full.guestCount,
      chosen: chosen?.candidate?.name ?? chosen?.proposal?.title ?? "Option no longer available",
      decidedOn: full.decision.decidedAt.slice(0, 10),
      inputsChanged: staleReasons(full.decision.sourceState, full.currentState).length > 0,
    });
  }

  return {
    revision: rev.data.revision,
    name: settings.name,
    date: settings.date,
    timezone: settings.timezone,
    location: settings.location,
    currency: settings.baseCurrency,
    targetGuestCount: settings.targetGuestCount,
    events,
    timeline,
    vendors,
    budget,
    payments,
    rsvp,
    guarantees,
    seating,
    boards: boardsIn,
    documents: documentsIn,
    decisions,
  };
}
