import { toCsv } from "@/domain/guests/csv";
import { stayLabel, stayView } from "@/domain/lodging/stays";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { lodgingEnabled } from "@/server/lodging/flag";
import { loadLodging } from "@/server/lodging/queries";

/**
 * Who is staying where, for attending guests: name, household, where they're staying and whose
 * answer that is. No contact, dietary or access details. Every text cell is neutralized against
 * spreadsheet formulas by toCsv.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!lodgingEnabled() || !hasCapability(access, "guests.manage")) {
    return new Response("Not found", { status: 404 });
  }
  const data = await loadLodging(access.wedding.id);
  const names = new Map(data.hotels.map((h) => [h.id, h.name]));
  const nameOf = (id: string) => names.get(id) ?? "A hotel";
  const rows: string[][] = [["Guest", "Household", "Staying at", "Source", "Guest said"]];
  for (const g of data.attending) {
    const v = stayView(data.stays.get(g.id));
    rows.push([
      g.name,
      g.household ?? "",
      stayLabel(v.effective, nameOf),
      v.source === "planner" ? "You" : v.source === "guest" ? "Guest's RSVP" : "",
      v.guestDiffers ? stayLabel(v.guestDiffers, nameOf) : "",
    ]);
  }
  return new Response(`﻿${toCsv(rows)}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="lodging.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
