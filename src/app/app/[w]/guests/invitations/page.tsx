import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { EVENT_KIND_LABELS, effectiveEventZone } from "@/domain/events/event";
import { invitationState, type InvitationState } from "@/domain/events/invitation";
import { partyGroups, partyIsLive, type PartyGroup } from "@/domain/events/party";
import { lockedTypes, summarizeAnswers } from "@/domain/guests/rsvp-form";
import { CountStrip } from "@/features/events/count-strip";
import { RsvpAnswers } from "@/features/events/rsvp-answers";
import { RsvpFormBuilder } from "@/features/events/rsvp-form-builder";
import { PartyLinkControls } from "@/features/events/party-forms";
import {
  EventForm,
  InvitationActions,
  InviteForm,
  MealOptionForm,
  MealToggle,
  OverrideForm,
} from "@/features/events/event-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventDemand } from "@/server/events/demand";
import { loadEventData, loadInvitationSubmissions } from "@/server/events/queries";
import { zoneLabel } from "@/features/events/reply-by";
import { ZonedDate } from "@/features/events/zoned-date";
import { loadGuests } from "@/server/guests/queries";
import { getMailProvider } from "@/server/mail/provider";
import { loadRsvpForms } from "@/server/events/rsvp-forms";
import { formBuilderEnabled, guestEmailEnabled, partyLinksEnabled } from "@/server/rsvp/flags";
import { listTimeZones } from "@/domain/wedding/settings";

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

const sentLabel = (n: number) => (n === 1 ? "Sent once" : `Sent ${n} times`);
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

  const showForms = formBuilderEnabled();
  const [data, guestData, demand, submissions, forms] = await Promise.all([
    loadEventData(wid),
    loadGuests(wid),
    loadEventDemand(wid, {
      canManageGuests: true,
      shareGuestTotals: access.wedding.shareGuestTotals,
    }),
    loadInvitationSubmissions(wid),
    showForms ? loadRsvpForms(wid) : null,
  ]);
  const now = new Date();
  const mail = getMailProvider();
  const guestById = new Map(guestData.guests.map((g) => [g.id, g]));
  const activeGuests = guestData.guests.filter((g) => !g.archived);
  const defaultExpires = new Date(now.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);
  const showParties = partyLinksEnabled();
  const groups = showParties
    ? partyGroups({
        // Event order (date, then name), so each party lists its events as the guest sees them.
        invitations: [...data.invitations].sort(
          (a, b) =>
            data.events.findIndex((e) => e.id === a.eventId) -
            data.events.findIndex((e) => e.id === b.eventId),
        ),
        members: data.members,
        parties: data.parties,
        now,
      })
    : [];
  const livePartyIds = new Set(data.parties.filter((p) => partyIsLive(p, now)).map((p) => p.id));

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
          {mail.configured && !mail.captureOnly
            ? "Email sending is set up, but nothing is sent unless you approve it."
            : `${mail.captureOnly ? "Email is in test mode and reaches no one" : "Email sending isn't set up"}, so copy each link and share it yourself. “Shared” means you told us you shared it, not that it was delivered or read.`}
        </p>
        {guestEmailEnabled() && (
          <p className="text-body-md">
            <Link href={`${base}/guests/messages`} className={link}>
              Guest emails
            </Link>
            : prepare reply confirmations and reminders, and read each one before it can be sent.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <TrayButton
            label="Add an event"
            title="Add an event"
            description="Such as your ceremony or reception. Guests are invited to each event separately."
          >
            <EventForm
              workspaceId={wid}
              submitLabel="Add event"
              weddingZone={access.wedding.timezone}
              timeZones={listTimeZones()}
            />
          </TrayButton>
          <Link href={`${base}/guests`} className={`${link} inline-flex min-h-11 items-center`}>
            Back to the guest list
          </Link>
        </div>
      </header>

      {groups.length > 0 && (
        <PartyLinksSection
          workspaceId={wid}
          groups={groups}
          eventName={(invitationId) => {
            const inv = data.invitations.find((i) => i.id === invitationId);
            return data.events.find((e) => e.id === inv?.eventId)?.name ?? "Event";
          }}
          weddingZone={access.wedding.timezone}
        />
      )}

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
        const counts = demand.byEvent.get(event.id);
        const meals = data.mealOptions.filter((m) => m.eventId === event.id);
        const activeMeals = meals.filter((m) => m.active);
        const invitations = data.invitations.filter((i) => i.eventId === event.id);
        const eventZone = effectiveEventZone(event.timeZone, access.wedding.timezone);
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
        const mealName = (id: string | null) =>
          id ? (meals.find((m) => m.id === id)?.name ?? "Unknown") : null;
        const eventHeading = `event-${event.id}`;
        const form = forms?.byEvent(event.id) ?? null;
        // Answers from people attending now, to questions guests are asked now (UX-11).
        const attendingIds = new Set(
          members.filter((m) => m.status === "accepted").map((m) => m.id),
        );
        const eventAnswers = forms ? forms.answers.filter((a) => a.eventId === event.id) : [];
        const askedKeys = new Set(form?.published?.definition.questions.map((q) => q.key) ?? []);
        const shownAnswers = eventAnswers
          .filter((a) => attendingIds.has(a.memberId) && askedKeys.has(a.questionKey))
          .map((a) => ({
            questionKey: a.questionKey,
            value: a.value,
            guestName: guestById.get(a.guestId)?.fullName ?? "Guest",
          }));
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
              {counts && (
                <CountStrip demand={counts} eventName={event.name} capacity={event.capacity} />
              )}
              {counts && counts.yes > 0 && (
                <div>
                  <h3 className="text-label-lg font-semibold">Meal choices so far</h3>
                  <ul className="text-body-md">
                    {counts.meals
                      .filter((m) => m.count > 0)
                      .map((m) => (
                        <li key={m.id}>
                          {m.name}: {m.count}
                        </li>
                      ))}
                    {counts.yesWithoutMeal > 0 && <li>No choice yet: {counts.yesWithoutMeal}</li>}
                  </ul>
                </div>
              )}
            </Card>

            <div className="flex flex-wrap gap-3">
              <TrayButton
                label="Invite guests"
                size="sm"
                title={`Invite guests to ${event.name}`}
                description="Creating a link sends nothing. You share it yourself."
              >
                <InviteForm
                  workspaceId={wid}
                  eventId={event.id}
                  households={householdPicks}
                  guests={soloPicks}
                  defaultExpires={defaultExpires}
                  zoneLabel={zoneLabel(
                    effectiveEventZone(event.timeZone, access.wedding.timezone),
                    now,
                  )}
                />
              </TrayButton>
              <TrayButton
                label={`Meal choices (${activeMeals.length})`}
                variant="outline"
                size="sm"
                title="Meal choices"
                description={event.name}
              >
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
              </TrayButton>
              {form && (
                <TrayButton
                  label={`Guest questions (${form.published?.definition.questions.length ?? 0})`}
                  variant="outline"
                  size="sm"
                  title="Guest questions"
                  description={event.name}
                >
                  <RsvpFormBuilder
                    workspaceId={wid}
                    eventId={event.id}
                    eventName={event.name}
                    version={form.version}
                    draft={form.draft}
                    published={
                      form.published
                        ? {
                            version: form.published.version,
                            definition: form.published.definition,
                            publishedOn: dayFmt(form.published.publishedAt),
                          }
                        : null
                    }
                    lockedTypes={Object.fromEntries(lockedTypes(form.history))}
                  />
                </TrayButton>
              )}
              {form?.published && form.published.definition.questions.length > 0 && (
                <TrayButton
                  label="Answers"
                  ariaLabel={`Answers to your questions for ${event.name}`}
                  variant="outline"
                  size="sm"
                  title="Answers to your questions"
                  description={event.name}
                >
                  <RsvpAnswers
                    summaries={summarizeAnswers(form.published.definition, shownAnswers)}
                    hiddenCount={eventAnswers.length - shownAnswers.length}
                  />
                </TrayButton>
              )}
              <Link
                href={`${base}/plan/events/${event.id}`}
                className={`${link} inline-flex min-h-11 items-center`}
              >
                Open the event page<span className="sr-only"> for {event.name}</span>
              </Link>
            </div>

            <div className="space-y-3">
              <h3 className="font-serif text-headline-sm">Invitations ({invitations.length})</h3>
              {invitations.length === 0 && (
                <p className="text-body-md text-ink-muted">No invitations for this event yet.</p>
              )}
              {invitations.map((inv) => {
                const state = invitationState(inv, now);
                const invMembers = data.members.filter((m) => m.invitationId === inv.id);
                const sends = submissions.get(inv.id) ?? [];
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
                    {inv.partyId && livePartyIds.has(inv.partyId) && state !== "revoked" && (
                      <p className="text-body-sm text-ink-muted">
                        Also answered through the link for all events.
                      </p>
                    )}
                    <p className="text-body-sm text-ink-muted">
                      Link works until{" "}
                      <ZonedDate iso={inv.expiresAt} timeZone={eventZone} month="short" />
                      {inv.deadline && (
                        <>
                          {" · reply by "}
                          <ZonedDate iso={inv.deadline} timeZone={eventZone} month="short" />
                        </>
                      )}
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
                    {sends.length > 0 && (
                      <TrayButton
                        triggerStyle="link"
                        label={sentLabel(sends.length)}
                        ariaLabel={`${sentLabel(sends.length)} by the guest for ${inv.label}`}
                        title="What the guest sent"
                        description={inv.label}
                      >
                        <p className="text-body-sm text-ink-muted">
                          One line for each time the guest pressed Send and something changed. Sends
                          that changed nothing are not listed. Names, answers and notes are not kept
                          here; the fingerprint only shows whether two sends were the same.
                        </p>
                        <ol className="mt-3 space-y-3">
                          {sends.map((x) => (
                            <li key={x.id} className="space-y-1 text-body-md">
                              <p className="font-semibold">
                                <ZonedDate iso={x.submittedAt} timeZone={eventZone} month="short" />
                                {x.partyId ? " · through the link for all events" : ""}
                              </p>
                              <p className="text-body-sm text-ink-muted">
                                {x.acceptedCount} accepted · {x.declinedCount} declined
                                {x.plusOneAdded ? " · plus-one added" : ""}
                                {x.plusOnesRemoved > 0
                                  ? ` · ${x.plusOnesRemoved} ${x.plusOnesRemoved === 1 ? "plus-one" : "plus-ones"} removed`
                                  : ""}
                                {x.detailsCount > 0
                                  ? ` · notes saved for ${x.detailsCount} ${x.detailsCount === 1 ? "person" : "people"}`
                                  : ""}
                                {x.answersCount > 0
                                  ? ` · answered your questions for ${x.answersCount} ${x.answersCount === 1 ? "person" : "people"}`
                                  : ""}
                              </p>
                              <p className="text-body-sm text-ink-muted">
                                {x.customForm
                                  ? `Your questions, version ${x.formVersion}`
                                  : "Standard form"}{" "}
                                · workspace revision {x.acceptedRevision} · fingerprint{" "}
                                <span className="font-mono">{x.payloadHash.slice(0, 10)}</span>
                              </p>
                            </li>
                          ))}
                        </ol>
                      </TrayButton>
                    )}
                    {state !== "revoked" && (
                      <>
                        <TrayButton
                          triggerStyle="link"
                          label="Change an answer"
                          ariaLabel={`Change an answer for ${inv.label}`}
                          title="Change an answer"
                          description={inv.label}
                        >
                          <div className="space-y-4">
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
                        </TrayButton>
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
    </div>
  );
}

const BLOCKED: Record<Exclude<PartyGroup["blocked"], null | "has_link">, string> = {
  too_few_events: "Invite them to another event to make one link.",
  same_event_twice:
    "They have two invitations to the same event, so these can't share one link. Revoke one first.",
  too_many_events: "One link can cover up to 12 events.",
};

/** UX-06: one link per household for every event it is invited to. */
function PartyLinksSection({
  workspaceId,
  groups,
  eventName,
  weddingZone,
}: {
  workspaceId: string;
  groups: PartyGroup[];
  eventName: (invitationId: string) => string;
  weddingZone: string;
}) {
  return (
    <section aria-labelledby="party-links" className="space-y-3">
      <h2 id="party-links" className="font-serif text-headline-sm">
        One link for all events
      </h2>
      <p className="text-body-md text-ink-muted">
        A household invited to more than one event can answer them all from one link. Their link for
        each event keeps working, and both show the same answers.
      </p>
      <ul className="space-y-3">
        {groups.map((g) => {
          const covered = g.party
            ? g.invitationIds.filter((id) => !g.notInLink.includes(id))
            : g.invitationIds;
          return (
            <li key={g.key}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{g.label}</p>
                  <Badge tone={g.party ? "confirmed" : "neutral"}>
                    {g.party ? "Link made" : "No link yet"}
                  </Badge>
                </div>
                <p className="text-body-md">
                  {g.party ? "Covers " : "Would cover "}
                  {covered.map(eventName).join(", ")}
                </p>
                {g.party && (
                  <p className="text-body-sm text-ink-muted">
                    Link works until{" "}
                    <ZonedDate iso={g.party.expiresAt} timeZone={weddingZone} month="short" />. Each
                    event keeps its own reply-by date.
                  </p>
                )}
                {g.notInLink.length > 0 && (
                  <p className="text-body-sm text-ink-muted">
                    Not in this link: {g.notInLink.map(eventName).join(", ")}. To include it, revoke
                    this link and make a new one.
                  </p>
                )}
                {g.blocked && g.blocked !== "has_link" && (
                  <p className="text-body-sm text-ink-muted">{BLOCKED[g.blocked]}</p>
                )}
                <PartyLinkControls
                  workspaceId={workspaceId}
                  label={g.label}
                  invitationIds={g.invitationIds}
                  canCreate={g.blocked === null}
                  party={g.party ? { id: g.party.id, version: g.party.version } : null}
                />
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
