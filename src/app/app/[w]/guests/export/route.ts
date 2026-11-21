import { toCsv } from "@/domain/guests/csv";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadGuests } from "@/server/guests/queries";

/**
 * Guest list export. Private fields (dietary, accessibility, notes, mailing addresses) are never
 * included here, and every text cell is neutralized against spreadsheet formulas.
 */
export async function GET(_: Request, { params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!hasCapability(access, "guests.manage")) {
    return new Response("Not found", { status: 404 });
  }
  const data = await loadGuests(access.wedding.id);
  const households = new Map(data.households.map((h) => [h.id, h.name]));
  const rows = [
    ["Name", "Household", "Email", "Phone", "Adult or child", "Tags"],
    ...data.guests
      .filter((g) => !g.archived)
      .map((g) => [
        g.fullName,
        (g.householdId && households.get(g.householdId)) || "",
        g.email ?? "",
        g.phone ?? "",
        g.ageGroup ?? "",
        g.tags.join("; "),
      ]),
  ];
  return new Response(`﻿${toCsv(rows)}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="guest-list.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
