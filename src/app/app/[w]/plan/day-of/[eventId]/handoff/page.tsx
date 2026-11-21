import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { instantToLocal } from "@/domain/timeline/zoned";
import { PrintButton } from "@/features/timeline/agenda-forms";
import { dayLabel, kindLabel, rangeLabel, zoneName } from "@/features/timeline/format";
import { requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidates } from "@/server/candidates/queries";
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
  const [events, items, members, candidates, settings] = await Promise.all([
    loadEventLabels(wid),
    loadTimeline(wid, eventId),
    loadAssigneeOptions(wid),
    loadCandidates(wid),
    loadWeddingSettings(wid),
  ]);
  const event = events.find((e) => e.id === eventId);
  if (!event) notFound();
  const memberName = new Map(members.map((m) => [m.userId, m.label]));
  const vendorName = new Map(candidates.map((c) => [c.id, c.name]));
  const active = items.filter((i) => i.status === "scheduled");

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
          {kindLabel(event.kind)} · all times local to {settings.timezone} (
          {zoneName(settings.timezone)}). This is the plan as last saved, not live status.
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
