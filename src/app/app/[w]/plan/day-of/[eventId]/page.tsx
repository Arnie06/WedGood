import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { findResourceConflicts, itemToFormValues } from "@/domain/timeline/timeline";
import { instantToLocal } from "@/domain/timeline/zoned";
import { AgendaItemForm, DeleteAgendaItemForm } from "@/features/timeline/agenda-forms";
import { dayLabel, kindLabel, rangeLabel, zoneName } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { vendorLabel } from "@/domain/events/vendors";
import { loadAgendaVendorOptions, loadEventVendorData } from "@/server/events/vendors";
import { checkInEnabled } from "@/server/checkin/flag";
import { loadAssigneeOptions } from "@/server/plan/queries";
import { loadEventLabels, loadTimeline } from "@/server/timeline/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Wedding-day agenda" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function AgendaPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(eventId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canEdit = hasCapability(access, "plan.edit");
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

  const tz = event.effectiveTimeZone;
  // Abbreviations such as EDT depend on the date, so name the zone as it is on the agenda's first day.
  const zoneAt = items[0] ? new Date(items[0].startsAt) : undefined;
  const memberName = new Map(members.map((m) => [m.userId, m.label]));
  const vendorName = agendaVendors.names;
  const memberOptions = members.map((m) => ({ id: m.userId, label: m.label }));
  const vendorOptions = { atEvent: agendaVendors.atEvent, others: agendaVendors.others };
  const atThisEvent = vendorData.vendors.filter((v) =>
    (vendorData.byEvent.get(eventId) ?? []).includes(v.id),
  );
  const conflicts = findResourceConflicts(items);
  const conflictFor = (id: string) =>
    conflicts
      .filter((c) => c.aId === id || c.bId === id)
      .map(
        (c) => items.find((i) => i.id === (c.aId === id ? c.bId : c.aId))?.title ?? "another item",
      );
  const sharedWord = {
    person: "the same team member",
    vendor: "the same vendor",
    responsible: "the same person",
  };

  const days: { key: string; label: string; items: typeof items }[] = [];
  for (const item of items) {
    const key = instantToLocal(new Date(item.startsAt), item.timezone).date;
    const day = days.at(-1);
    if (day?.key === key) day.items.push(item);
    else days.push({ key, label: dayLabel(item.startsAt, item.timezone), items: [item] });
  }
  const defaultDate = event.localDate ?? settings.date ?? "";

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{event.name}</h1>
        <p className="text-body-lg text-ink-muted">
          {kindLabel(event.kind)} agenda · times are local to {tz.replaceAll("_", " ")} (
          {zoneName(tz, zoneAt)}){event.timeZone ? ", this event's own zone" : ""}.
        </p>
        <p className="flex flex-wrap gap-x-6">
          <Link
            href={`${base}/plan/day-of`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            All events
          </Link>
          <Link
            href={`${base}/plan/day-of/${event.id}/handoff`}
            className={`${link} inline-flex min-h-11 items-center`}
          >
            Printable coordinator handoff
          </Link>
          {checkInEnabled() && (
            <Link
              href={`${base}/plan/day-of/${event.id}/check-in`}
              className={`${link} inline-flex min-h-11 items-center`}
            >
              Check-in on the day
            </Link>
          )}
        </p>
        {atThisEvent.length > 0 && (
          <p className="text-body-md text-ink-muted" data-testid="agenda-vendors">
            Vendors at this event:{" "}
            {atThisEvent.map((v, i) => (
              <span key={v.id}>
                {i > 0 && ", "}
                {vendorLabel(v)}
              </span>
            ))}
            .{" "}
            <Link href={`${base}/plan/events/${eventId}`} className={link}>
              Change on the event page
            </Link>
          </p>
        )}
      </header>

      {items.length === 0 && (
        <Card>
          <p className="text-body-md text-ink-muted">
            Nothing on this agenda yet.{" "}
            {canEdit
              ? "Add the first moment below, such as guest arrival or the ceremony."
              : "The workspace owner or a partner can add items."}
          </p>
        </Card>
      )}

      {days.map((day) => (
        <section key={day.key} aria-labelledby={`day-${day.key}`} className="space-y-3">
          <h2 id={`day-${day.key}`} className="font-serif text-headline-sm">
            {day.label}
          </h2>
          <ol className="space-y-3">
            {day.items.map((item) => {
              const clashes = conflictFor(item.id);
              const clash = conflicts.find((c) => c.aId === item.id || c.bId === item.id);
              const who = [
                item.assigneeUserId ? memberName.get(item.assigneeUserId) : null,
                item.vendorId ? vendorName.get(item.vendorId) : null,
                item.responsibleLabel,
              ].filter((x): x is string => Boolean(x));
              return (
                <li key={item.id}>
                  <Card className="space-y-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <CardTitle as="h3">{item.title}</CardTitle>
                      <p className="text-label-lg font-semibold">
                        {rangeLabel(item.startsAt, item.endsAt, item.timezone)}
                      </p>
                    </div>
                    {item.status === "cancelled" && <Badge tone="neutral">Cancelled</Badge>}
                    <dl className="space-y-1 text-body-md [overflow-wrap:anywhere]">
                      {item.location && (
                        <div>
                          <dt className="inline font-semibold">Where: </dt>
                          <dd className="inline">{item.location}</dd>
                        </div>
                      )}
                      {who.length > 0 && (
                        <div>
                          <dt className="inline font-semibold">In charge: </dt>
                          <dd className="inline">{who.join(" · ")}</dd>
                        </div>
                      )}
                      {item.contact && (
                        <div>
                          <dt className="inline font-semibold">Contact: </dt>
                          <dd className="inline">{item.contact}</dd>
                        </div>
                      )}
                      {item.notes && (
                        <dd className="whitespace-pre-line text-ink-muted">{item.notes}</dd>
                      )}
                    </dl>
                    {clash && (
                      <p className="text-body-md text-ink-muted" role="note">
                        <strong>Heads up:</strong> this overlaps {clashes.join(", ")} and needs{" "}
                        {sharedWord[clash.shared]} at the same time. Overlaps are fine when that is
                        intended.
                      </p>
                    )}
                    {canEdit && (
                      <details className="pt-2">
                        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-action-emphasis underline underline-offset-4">
                          Edit<span className="sr-only"> {item.title}</span>
                        </summary>
                        <div className="space-y-6 pt-4">
                          <AgendaItemForm
                            mode="edit"
                            members={memberOptions}
                            vendors={vendorOptions}
                            timezoneLabel={zoneName(item.timezone, new Date(item.startsAt))}
                            defaults={itemToFormValues(item)}
                            hidden={{
                              workspaceId: wid,
                              itemId: item.id,
                              version: String(item.version),
                            }}
                          />
                          <DeleteAgendaItemForm
                            workspaceId={wid}
                            itemId={item.id}
                            version={item.version}
                          />
                        </div>
                      </details>
                    )}
                  </Card>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {canEdit && (
        <section aria-labelledby="add-heading">
          <Card className="space-y-4">
            <CardTitle id="add-heading">Add to the agenda</CardTitle>
            <AgendaItemForm
              mode="create"
              members={memberOptions}
              vendors={vendorOptions}
              timezoneLabel={zoneName(tz, zoneAt)}
              defaults={{
                title: "",
                date: defaultDate,
                startTime: "",
                endDate: "",
                endTime: "",
                location: "",
                responsibleLabel: "",
                contact: "",
                notes: "",
                assignee: "",
                vendor: "",
                status: "scheduled",
              }}
              hidden={{ workspaceId: wid, eventId: event.id, idempotencyKey: randomUUID() }}
            />
          </Card>
        </section>
      )}
    </div>
  );
}
