import { z } from "zod";
import { attendanceRows } from "@/domain/checkin/checkin";
import { toCsv } from "@/domain/guests/csv";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { checkInEnabled } from "@/server/checkin/flag";
import { loadGuestArrivals } from "@/server/checkin/queries";
import { loadEventLabels } from "@/server/timeline/queries";

/**
 * Attendance for one event: guest, household, reply, whether they arrived and when (event zone).
 * Guests who said yes and did not arrive are listed too. No contact, dietary or access details.
 * Every text cell is neutralized against spreadsheet formulas by toCsv.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ w: string; eventId: string }> },
) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (
    !checkInEnabled() ||
    !hasCapability(access, "guests.manage") ||
    !z.uuid().safeParse(eventId).success
  ) {
    return new Response("Not found", { status: 404 });
  }
  const label = (await loadEventLabels(access.wedding.id)).find((e) => e.id === eventId);
  if (!label) return new Response("Not found", { status: 404 });
  const tz = label.effectiveTimeZone;
  const guests = await loadGuestArrivals(access.wedding.id, eventId);
  const rows = attendanceRows(guests, (iso) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso)),
  );
  return new Response(`﻿${toCsv(rows)}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="attendance.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
