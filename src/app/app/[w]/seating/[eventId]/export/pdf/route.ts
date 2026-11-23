import { z } from "zod";
import { buildPrintModel } from "@/domain/seating/print";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { renderSeatingPdf } from "@/server/seating/pdf";
import { loadSeating } from "@/server/seating/queries";

const query = z.object({
  doc: z.enum(["table-list", "cards"]).default("table-list"),
  paper: z.enum(["a4", "letter"]).default("a4"),
  meals: z.enum(["0", "1"]).default("0"),
});

/**
 * Table list or escort cards as a PDF for one event. Names, tables, seat numbers and meals only;
 * dietary, access, contact details and notes are never read (`details: false`) and the print model
 * has no field to carry them. A snapshot of the plan as it is now; it does not update.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ w: string; eventId: string }> },
) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!hasCapability(access, "seating.manage") || !z.uuid().safeParse(eventId).success) {
    return new Response("Not found", { status: 404 });
  }
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return new Response("Unsupported options", { status: 400 });
  const { doc, paper, meals } = parsed.data;

  const data = await loadSeating(access.wedding.id, eventId, { details: false });
  if (!data) return new Response("Not found", { status: 404 });

  const model = buildPrintModel({
    guests: data.guests,
    members: data.members,
    tables: data.tables,
    assignments: data.assignments,
    meals: data.meals,
    allowTentative: data.layout?.allowTentative ?? false,
    includeMeals: meals === "1",
  });
  const pdf = await renderSeatingPdf(
    doc,
    model,
    {
      eventName: data.event.name,
      weddingName: access.wedding.name,
      eventDate: data.event.localDate,
      revision: data.layout?.revision ?? 0,
      generatedAt: new Date().toISOString(),
    },
    paper,
  );
  const filename = doc === "cards" ? "escort-cards.pdf" : "table-list.pdf";
  return new Response(Buffer.from(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
