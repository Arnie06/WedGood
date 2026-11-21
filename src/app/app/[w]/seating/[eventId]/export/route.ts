import { z } from "zod";
import { toCsv } from "@/domain/guests/csv";
import { buildSeatingPlan } from "@/domain/seating/plan";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadSeating } from "@/server/seating/queries";

/**
 * Seating and meal CSV for one event. Names, tables and meals only; dietary, accessibility, contact
 * details and notes are never included. Every text cell is neutralized against spreadsheet formulas.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ w: string; eventId: string }> },
) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!hasCapability(access, "guests.manage") || !z.uuid().safeParse(eventId).success) {
    return new Response("Not found", { status: 404 });
  }
  const view = new URL(request.url).searchParams.get("view") === "meals" ? "meals" : "seating";
  const data = await loadSeating(access.wedding.id, eventId);
  if (!data) return new Response("Not found", { status: 404 });
  const plan = buildSeatingPlan({
    guests: data.guests,
    members: data.members,
    tables: data.tables,
    assignments: data.assignments,
    meals: data.meals,
    allowTentative: data.layout?.allowTentative ?? false,
  });
  const mealOf = new Map(data.members.map((m) => [m.guestId, m.mealOptionId]));
  const mealName = new Map(data.meals.map((m) => [m.id, m.name]));
  const meal = (guestId: string) => mealName.get(mealOf.get(guestId) ?? "") ?? "No choice yet";

  const rows: string[][] =
    view === "meals"
      ? [
          ["Meal", "Guests attending"],
          ...plan.meals.map((m) => [m.name, String(m.confirmed)]),
          ["Total attending", String(plan.totals.accepted)],
        ]
      : [
          ["Table", "Guest", "Status", "Meal"],
          ...plan.tables.flatMap((t) => [
            ...t.confirmed.map((g) => [t.label, g.name, "Seated", meal(g.id)]),
            ...t.tentative.map((g) => [t.label, g.name, "Tentative", meal(g.id)]),
          ]),
          ...plan.queue.map((g) => ["", g.name, "Not seated yet", meal(g.id)]),
        ];
  const filename = view === "meals" ? "meal-totals.csv" : "seating.csv";
  return new Response(`﻿${toCsv(rows)}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
