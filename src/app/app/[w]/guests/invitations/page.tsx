import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EVENT_KIND_LABELS } from "@/domain/events/event";
import { invitationState, type InvitationState } from "@/domain/events/invitation";
import { summarizeResponses } from "@/domain/guests/rsvp";
import {
  EventForm,
  InvitationActions,
  InviteForm,
  MealOptionForm,
  MealToggle,
  OverrideForm,
} from "@/features/events/event-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventData } from "@/server/events/queries";
import { loadGuests } from "@/server/guests/queries";
import { getMailProvider } from "@/server/mail/provider";

export const metadata: Metadata = { title: "Events and invitations" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const STATE_LABEL: Record<InvitationState, string> = {
  open: "Open",
  closed: "Reply date passed",
  expired: "Link expired",
  revoked: "Revoked",
};
const STATE_TONE: Record<InvitationState, BadgeTone> = {
  open: "confirmed",
  closed: "pending",
  expired: "neutral",
  revoked: "neutral",
};
const STATUS_LABEL = {
  pending: "Waiting",
  accepted: "Attending",
  declined: "Not attending",
} as const;

const dayFmt = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export default async function InvitationsPage({ params }: { params: Promise<{ w: string }> }) {
  const { w } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Events and invitations
        </h1>
        <Card>
          <p className="text-body-md">
            Invitations hold private guest details, so they are limited to the workspace owner and
            partner.
          </p>
        </Card>
      </div>
    );
  }

  const [data, guestData] = await Promise.all([loadEventData(wid), loadGuests(wid)]);
  const now = new Date();
  const guestById = new Map(guestData.guests.map((g) => [g.id, g]));
  const activeGuests = guestData.guests.filter((g) => !g.archived);
  const defaultExpires = new Date(now.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Events and invitations
        </h1>
        <p className="text-body-lg text-ink-muted">
          Each event has its own invitations and answers. Creating a link sends nothing; you share
          it yourself. Guests answer without an account.
        </p>
        <p className="text-body-md text-ink-muted" data-testid="mail-status">
          {getMailProvider().configured
            ? "Email sending is set up, but nothing is sent unless you approve it."
            : "Email sending isn't set up, so copy each link and share it yourself. “Shared” means you told us you shared it, not that it was delivered or read."}
        </p>
        <Link href={`${base}/guests`} className={`${link} inline-flex min-h-11 items-center`}>
          Back to the guest list
        </Link>
      </header>

      {data.events.length === 0 && (
        <Card>
          <p className="text-body-md text-ink-muted">
            No events yet. Add your first event, such as the ceremony or reception, to start
            inviting guests.
          </p>
        </Card>
      )}

      {data.events.map((event) => {
        const members = data.members.filter((m) => m.eventId === event.id && m.active);
        const summary = summarizeResponses(
          members.map((m) => ({
            guestId: m.guestId,
            eligible: true,
            rsvpStatus: m.status,
            mealOptionId: m.mealOptionId,
          })),
        );
        const meals = data.mealOptions.filter((m) => m.eventId === event.id);
        const activeMeals = meals.filter((m) => m.active);
        const invitations = data.invitations.filter((i) => i.eventId === event.id);
        const invitedGuestIds = new Set(members.map((m) => m.guestId));
        const householdPicks = guestData.households
          .map((h) => {
            const inHousehold = activeGuests.filter((g) => g.householdId === h.id);
            return {
              id: h.id,
              name: h.name,
              total: inHousehold.length,
              invitable: inHousehold.filter((g) => !invitedGuestIds.has(g.id)).length,
            };
          })
          .filter((h) => h.total > 0);
        const soloPicks = activeGuests
          .filter((g) => g.householdId === null && !invitedGuestIds.has(g.id))
          .map((g) => ({ id: g.id, name: g.fullName }));
        const overCapacity = event.capacity !== null && summary.accepted > event.capacity;
        const mealName = (id: string | null) =>
          id ? (meals.find((m) => m.id === id)?.name ?? "Unknown") : null;
        const eventHeading = `event-${event.id}`;
        return (
          <section key={event.id} aria-labelledby={eventHeading} className="space-y-4">
            <Card className="space-y-4">
              <div>
                <CardTitle>
                  <span id={eventHeading}>{event.name}</span>
                </CardTitle>
                <p className="text-body-md text-ink-muted">
                  {EVENT_KIND_LABELS[event.kind]}
                  {event.localDate ? ` · ${event.localDate}` : " · date not set"}
                  {event.capacity !== null ? ` · capacity ${event.capacity}` : ""}
                  {event.targetAttendance !== null
                    ? ` · planning for ${event.targetAttendance}`
                    : ""}
                </p>
              </div>
              <dl
                className="grid grid-cols-2 gap-4 sm:grid-cols-4"
                aria-label={`Responses for ${event.name}`}
              >
                {[
                  ["Invited", summary.invited],
                  ["Attending", summary.accepted],
                  ["Waiting", summary.pending],
                  ["Not attending", summary.declined],
                ].map(([label, n]) => (
                  <div key={label}>
                    <dt className="text-label-lg text-ink-muted">{label}</dt>
                    <dd className="font-serif text-headline-sm">{n}</dd>
                  </div>
                ))}
              </dl>
              {overCapacity && (
                <p role="status" className="text-body-md text-danger">
                  {summary.accepted} guests are attending, which is more than the capacity of{" "}
                  {event.capacity}.
                </p>
              )}
              {summary.accepted > 0 && (
                <div>
                  <h3 className="text-label-lg font-semibold">Meal choices so far</h3>
                  <ul className="text-body-md">
                    {[...summary.mealCounts.entries()].map(([id, n]) => (
                      <li key={id}>
                        {mealName(id)}: {n}
                      </li>
                    ))}
                    {summary.acceptedWithoutMeal > 0 && (
                      <li>No choice yet: {summary.acceptedWithoutMeal}</li>
                    )}
                  </ul>
                </div>
              )}
            </Card>

            <details className="rounded-card border border-border-hairline p-4">
              <summary className="min-h-11 cursor-pointer font-semibold">
                Meal choices ({activeMeals.length} offered)
              </summary>
              <div className="mt-3 space-y-3">
                {meals.length === 0 && (
                  <p className="text-body-sm text-ink-muted">
                    No meal choices yet. Guests won&apos;t be asked about a meal.
                  </p>
                )}
                <ul className="space-y-2">
                  {meals.map((m) => (
                    <li key={m.id}>
                      <MealToggle workspaceId={wid} option={m} />
                    </li>
                  ))}
                </ul>
                <MealOptionForm workspaceId={wid} eventId={event.id} />
              </div>
            </details>

            <details className="rounded-card border border-border-hairline p-4">
              <summary className="min-h-11 cursor-pointer font-semibold">Edit this event</summary>
              <div className="mt-3">
                <EventForm
                  workspaceId={wid}
                  event={{ id: event.id, version: event.version }}
                  initial={{
                    name: event.name,
                    kind: event.kind,
                    localDate: event.localDate ?? "",
                    targetAttendance:
                      event.targetAttendance === null ? "" : String(event.targetAttendance),
                    capacity: event.capacity === null ? "" : String(event.capacity),
                  }}
                  submitLabel="Save event"
                />
              </div>
            </details>

            <details className="rounded-card border border-border-hairline p-4">
              <summary className="min-h-11 cursor-pointer font-semibold">
                Invite guests to {event.name}
              </summary>
              <div className="mt-3">
                <InviteForm
                  workspaceId={wid}
                  eventId={event.id}
                  households={householdPicks}
                  guests={soloPicks}
                  defaultExpires={defaultExpires}
                />
              </div>
            </details>

            <div className="space-y-3">
              <h3 className="font-serif text-headline-sm">Invitations ({invitations.length})</h3>
              {invitations.length === 0 && (
                <p className="text-body-md text-ink-muted">No invitations for this event yet.</p>
              )}
              {invitations.map((inv) => {
                const state = invitationState(inv, now);
                const invMembers = data.members.filter((m) => m.invitationId === inv.id);
                return (
                  <Card key={inv.id} className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">{inv.label}</p>
                      <div className="flex flex-wrap gap-2">
                        {state !== "revoked" && (
                          <Badge
                            tone={
                              inv.deliveryStatus === "shared_manually" ? "confirmed" : "neutral"
                            }
                          >
                            {inv.deliveryStatus === "shared_manually"
                              ? `Shared by you ${dayFmt(inv.deliveryMarkedAt ?? inv.expiresAt)}`
                              : "Not shared yet"}
                          </Badge>
                        )}
                        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                      </div>
                    </div>
                    <p className="text-body-sm text-ink-muted">
                      Link works until {dayFmt(inv.expiresAt)}
                      {inv.deadline ? ` · reply by ${dayFmt(inv.deadline)}` : ""}
                      {inv.plusOneQuota > 0
                        ? ` · plus-ones ${inv.plusOnesUsed} of ${inv.plusOneQuota} used`
                        : ""}
                    </p>
                    <ul className="space-y-1">
                      {invMembers.map((m) => {
                        const guest = guestById.get(m.guestId);
                        return (
                          <li key={m.id} className="text-body-md">
                            {guest?.fullName ?? "Guest"}
                            {m.isPlusOne ? " (plus-one)" : ""}:{" "}
                            <span className="font-semibold">{STATUS_LABEL[m.status]}</span>
                            {m.mealOptionId ? ` · ${mealName(m.mealOptionId)}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                    {state !== "revoked" && (
                      <>
                        <details>
                          <summary className="min-h-11 cursor-pointer font-semibold text-action-emphasis">
                            Change an answer
                          </summary>
                          <div className="mt-3 space-y-4">
                            {invMembers
                              .filter((m) => m.active)
                              .map((m) => (
                                <OverrideForm
                                  key={`${m.id}-${m.status}-${m.mealOptionId ?? ""}`}
                                  workspaceId={wid}
                                  member={{
                                    id: m.id,
                                    name: guestById.get(m.guestId)?.fullName ?? "guest",
                                    status: m.status,
                                    mealOptionId: m.mealOptionId,
                                  }}
                                  meals={activeMeals}
                                />
                              ))}
                          </div>
                        </details>
                        <InvitationActions
                          workspaceId={wid}
                          invitation={{
                            id: inv.id,
                            version: inv.version,
                            label: inv.label,
                            shared: inv.deliveryStatus === "shared_manually",
                          }}
                        />
                      </>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}

      <section aria-labelledby="add-event" className="space-y-3">
        <h2 id="add-event" className="font-serif text-headline-sm">
          Add an event
        </h2>
        <Card>
          <EventForm workspaceId={wid} submitLabel="Add event" />
        </Card>
      </section>
    </div>
  );
}
