import { z } from "zod";
import { toCsv } from "@/domain/guests/csv";
import { manifestRows, summarizeShuttles } from "@/domain/shuttles/shuttles";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { shuttlesEnabled } from "@/server/shuttles/flag";
import { loadShuttles } from "@/server/shuttles/queries";
import { loadEventLabels } from "@/server/timeline/queries";

/**
 * Shuttle rider list for one event: shuttle, departure (event zone), pickup, drop-off and guest
 * name. No contact, dietary or access details and no notes. Every text cell is neutralized against
 * spreadsheet formulas by toCsv.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ w: string; eventId: string }> },
) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (
    !shuttlesEnabled() ||
    !hasCapability(access, "guests.manage") ||
    !z.uuid().safeParse(eventId).success
  ) {
    return new Response("Not found", { status: 404 });
  }
  const label = (await loadEventLabels(access.wedding.id)).find((e) => e.id === eventId);
  if (!label) return new Response("Not found", { status: 404 });
  const tz = label.effectiveTimeZone;
  const data = await loadShuttles(access.wedding.id, eventId);
  const rows = manifestRows(summarizeShuttles(data), tz, (iso, zone) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
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
      "content-disposition": 'attachment; filename="shuttle-riders.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
