import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { instantToLocal } from "@/domain/timeline/zoned";
import { PrintButton } from "@/features/timeline/agenda-forms";
import { dayLabel, kindLabel, rangeLabel, zoneName } from "@/features/timeline/format";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { agendaByVendor, vendorLabel } from "@/domain/events/vendors";
import { stageLabel } from "@/domain/proposals/stages";
import { loadAgendaVendorOptions, loadEventVendorData } from "@/server/events/vendors";
import { loadAssigneeOptions } from "@/server/plan/queries";
import { loadEventLabels, loadTimeline } from "@/server/timeline/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Coordinator handoff" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

/** Read-only, print-friendly agenda for whoever runs the day. No guest data and no live status. */
export default async function HandoffPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(eventId)) notFound();
  const wid = access.wedding.id;
  const [events, items, members, settings, vendorData] = await Promise.all([
    loadEventLabels(wid),
    loadTimeline(wid, eventId),
    loadAssigneeOptions(wid),
    loadWeddingSettings(wid),
    loadEventVendorData(wid),
  ]);
  const agendaVendors = await loadAgendaVendorOptions(
    wid,
    eventId,
    items.flatMap((i) => (i.vendorId ? [i.vendorId] : [])),
  );
  const event = events.find((e) => e.id === eventId);
  if (!event) notFound();
  const memberName = new Map(members.map((m) => [m.userId, m.label]));
  const vendorName = agendaVendors.names;
  const active = items.filter((i) => i.status === "scheduled");
  // Vendors assigned to this event, each with the agenda items that name them. There is no
  // separate vendor contact record, so contacts are the lines written on those agenda items.
  const here = new Set(vendorData.byEvent.get(eventId) ?? []);
  const atEvent = vendorData.vendors.filter((v) => here.has(v.id));
  const itemsByVendor = agendaByVendor(active);

  const days: { key: string; label: string; items: typeof active }[] = [];
  for (const item of active) {
    const key = instantToLocal(new Date(item.startsAt), item.timezone).date;
    const day = days.at(-1);
    if (day?.key === key) day.items.push(item);
    else days.push({ key, label: dayLabel(item.startsAt, item.timezone), items: [item] });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <p className="text-label-lg text-ink-muted">
          Coordinator handoff · private to your workspace
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          {settings.name}: {event.name}
        </h1>
        <p className="text-body-md text-ink-muted">
          {kindLabel(event.kind)} · all times local to{" "}
          {event.effectiveTimeZone.replaceAll("_", " ")} (
          {zoneName(event.effectiveTimeZone, items[0] ? new Date(items[0].startsAt) : undefined)}).
          This is the plan as last saved, not live status.
        </p>
        <p className="flex flex-wrap items-center gap-x-6 print:hidden">
          <Link
            href={`/app/${wid}/plan/day-of/${event.id}`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Back to the agenda
          </Link>
          <PrintButton />
        </p>
      </header>

      {active.length === 0 && (
        <p className="text-body-md text-ink-muted">There are no scheduled items to hand off yet.</p>
      )}

      {atEvent.length > 0 && (
        <section aria-labelledby="vendors-here" className="space-y-2" data-testid="handoff-vendors">
          <h2 id="vendors-here" className="font-serif text-headline-sm">
            Vendors at this event
          </h2>
          <ul className="border-t border-border-control">
            {atEvent.map((v) => {
              const theirs = itemsByVendor.get(v.id) ?? [];
              const contacts = [...new Set(theirs.flatMap((i) => (i.contact ? [i.contact] : [])))];
              return (
                <li
                  key={v.id}
                  className="break-inside-avoid space-y-1 border-b border-border-control py-3 text-body-md [overflow-wrap:anywhere]"
                >
                  <p className="font-semibold">{vendorLabel(v)}</p>
                  <p>
                    {v.categoryLabel}
                    {!v.archived && ` · ${v.stage === "booked" ? "Booked" : stageLabel(v.stage)}`}
                  </p>
                  {theirs.length > 0 ? (
                    <p>
                      On the agenda:{" "}
                      {theirs
                        .map((i) => `${rangeLabel(i.startsAt, i.endsAt, i.timezone)} ${i.title}`)
                        .join("; ")}
                    </p>
                  ) : (
                    <p className="text-ink-muted">Not named on any agenda item yet.</p>
                  )}
                  {contacts.length > 0 && <p>Contact: {contacts.join("; ")}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {days.map((day) => (
        <section key={day.key} aria-labelledby={`h-${day.key}`} className="space-y-2">
          <h2 id={`h-${day.key}`} className="font-serif text-headline-sm">
            {day.label}
          </h2>
          <ol className="border-t border-border-control">
            {day.items.map((item) => {
              const who = [
                item.assigneeUserId ? memberName.get(item.assigneeUserId) : null,
                item.vendorId ? vendorName.get(item.vendorId) : null,
                item.responsibleLabel,
              ].filter((x): x is string => Boolean(x));
              return (
                <li
                  key={item.id}
                  className="break-inside-avoid space-y-1 border-b border-border-control py-3 text-body-md [overflow-wrap:anywhere]"
                >
                  <p className="font-semibold">
                    {rangeLabel(item.startsAt, item.endsAt, item.timezone)} · {item.title}
                  </p>
                  {item.location && <p>Where: {item.location}</p>}
                  <p>In charge: {who.length > 0 ? who.join(" · ") : "Unassigned"}</p>
                  {item.contact && <p>Contact: {item.contact}</p>}
                  {item.notes && <p className="whitespace-pre-line text-ink-muted">{item.notes}</p>}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
