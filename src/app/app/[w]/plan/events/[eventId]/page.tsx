import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { stageLabel } from "@/domain/proposals/stages";
import { formatEventDate } from "@/domain/events/event";
import { vendorLabel } from "@/domain/events/vendors";
import {
  CAPACITY_SOURCE_LABELS,
  capacityFit,
  effectiveCapacity,
  fitSentence,
} from "@/domain/events/location";
import { forEvent } from "@/domain/attention/attention";
import { eventCostItems } from "@/domain/budget/event-costs";
import { EventCostsCard, type EventCost } from "@/features/budget/event-costs-card";
import type { CountContext } from "@/features/budget/format";
import { loadBudgetInputs, summarizeBudgetInputs } from "@/server/budget/view";
import { AttentionList } from "@/features/attention/attention-list";
import { loadAttention } from "@/server/attention/queries";
import { CountStrip, TotalsHidden } from "@/features/events/count-strip";
import { EventForm } from "@/features/events/event-forms";
import { EventSwitcher } from "@/features/events/event-switcher";
import { EventVendorsForm } from "@/features/events/vendor-links-form";
import {
  GuaranteeCard,
  type CardReplyBy,
  type CatererChoice,
  type CateringBookingRow,
} from "@/features/events/guarantee-card";
import { actorFor } from "@/domain/attention/history";
import { cateringBookings } from "@/domain/events/catering";
import { todayInZone } from "@/domain/dates/date-only";
import { buildReplyStrip, replyByLabel } from "@/domain/home/reply-strip";
import { viewCommitment } from "@/features/ledger/view";
import { loadReplyDeadlines } from "@/server/events/reply-dates";
import { EventLocationForm } from "@/features/events/location-form";
import { kindLabel, rangeLabel, zoneName } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventDemand } from "@/server/events/demand";
import { loadGuarantees, loadMemberRoles, type EventGuarantees } from "@/server/events/guarantee";
import { loadBookedVenueIds, loadEventLocations, loadVenueOptions } from "@/server/events/location";
import { loadEventRecords } from "@/server/events/queries";
import { loadEventVendorData } from "@/server/events/vendors";
import { loadTableSeatTotals } from "@/server/seating/queries";
import { shuttlesEnabled } from "@/server/shuttles/flag";
import { loadShuttleTotals } from "@/server/shuttles/queries";
import { loadEventLabels, loadTimeline } from "@/server/timeline/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { listTimeZones } from "@/domain/wedding/settings";

export const metadata: Metadata = { title: "Event" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const linkRow = `${link} inline-flex min-h-11 items-center`;
const AGENDA_PREVIEW = 5;

export default async function EventPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(eventId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const canManage = hasCapability(access, "guests.manage");

  // Every member can read event names and dates; capacity and planning settings are manager-only.
  const canManageVendors = hasCapability(access, "vendors.manage");
  const [
    labels,
    records,
    demand,
    items,
    settings,
    venueOptions,
    locations,
    booked,
    tableTotals,
    vendorData,
    guarantees,
    attention,
    budgetInputs,
    replyDeadlines,
    memberRoles,
  ] = await Promise.all([
    loadEventLabels(wid),
    canManage ? loadEventRecords(wid) : Promise.resolve([]),
    loadEventDemand(wid, {
      canManageGuests: canManage,
      shareGuestTotals: access.wedding.shareGuestTotals,
    }),
    loadTimeline(wid, eventId),
    loadWeddingSettings(wid),
    loadVenueOptions(wid),
    loadEventLocations(wid),
    loadBookedVenueIds(wid),
    canManage ? loadTableSeatTotals(wid) : Promise.resolve(new Map<string, number>()),
    loadEventVendorData(wid),
    canManage || access.wedding.shareGuestTotals
      ? loadGuarantees(wid)
      : Promise.resolve(new Map<string, EventGuarantees>()),
    loadAttention(access, access.wedding.timezone),
    loadBudgetInputs(wid),
    // Invitations are owner and partner only (RLS); anyone else gets no dates.
    canManage ? loadReplyDeadlines(wid) : Promise.resolve(new Map<string, readonly string[]>()),
    loadMemberRoles(wid),
  ]);
  // UX-17: shuttles are behind GUEST_SHUTTLES=on and, like replies, only for people who manage guests.
  const showShuttles = shuttlesEnabled() && canManage;
  const shuttleTotals = showShuttles ? await loadShuttleTotals(wid, eventId) : null;
  const eventAttention = forEvent(attention.visible, eventId);
  const label = labels.find((e) => e.id === eventId);
  if (!label) notFound();
  const record = records.find((e) => e.id === eventId) ?? null;
  const counts = demand.byEvent.get(eventId) ?? null;
  const date = formatEventDate(label.localDate);

  // Where it is held, and the room that place gives. The event's own capacity wins; an archived
  // venue or space gives none (a stale choice), so it is never used to say "fits".
  const place = locations.get(eventId) ?? null;
  const venueRow = place ? venueOptions.find((v) => v.id === place.venue.id) : undefined;
  const capacity = effectiveCapacity({
    eventCapacity: record?.capacity ?? null,
    eventKind: label.kind,
    venue: place
      ? {
          seatedCapacity: place.venue.seatedCapacity,
          ceremonyCapacity: place.venue.ceremonyCapacity,
          archived: place.venue.archived,
        }
      : null,
    space: place?.space
      ? { seatedCapacity: place.space.seatedCapacity, archived: place.space.archived }
      : null,
  });
  const planning = counts && counts.invited > 0 ? counts.planningNumber : null;
  const fit = capacityFit(planning, capacity);
  const placeCapacity = place
    ? effectiveCapacity({
        eventCapacity: null,
        eventKind: label.kind,
        venue: {
          seatedCapacity: place.venue.seatedCapacity,
          ceremonyCapacity: place.venue.ceremonyCapacity,
          archived: place.venue.archived,
        },
        space: place.space
          ? { seatedCapacity: place.space.seatedCapacity, archived: place.space.archived }
          : null,
      })
    : null;
  const staleVenue = place?.venue.archived === true;
  const staleSpace = place?.space?.archived === true;

  const vendorIds = vendorData.byEvent.get(eventId) ?? [];
  const atEvent = vendorData.vendors.filter((v) => vendorIds.includes(v.id));

  // Caterer choices: this event's current vendors, plus the caterer already on a locked count even if
  // it was passed on or unassigned since, so revising never silently drops it.
  const lockedCaterer = guarantees.get(eventId)?.current?.candidateId ?? null;
  const caterers: CatererChoice[] = atEvent
    .filter((v) => v.state === "current" || v.id === lockedCaterer)
    .map((v) => ({ id: v.id, label: vendorLabel(v) }));
  if (lockedCaterer && !caterers.some((c) => c.id === lockedCaterer)) {
    const known = vendorData.vendors.find((v) => v.id === lockedCaterer);
    caterers.push({
      id: lockedCaterer,
      label: known
        ? `${vendorLabel(known)} (not assigned to this event now)`
        : "Chosen caterer (not assigned to this event now)",
    });
  }

  // The costs this event's guests price, read from the budget. Same figures and the same sharing rule
  // for reply counts as the budget page (ADR-031 D2).
  const budgetSummary = summarizeBudgetInputs(budgetInputs, settings);
  const figures = new Map(budgetSummary.items.map((f) => [f.itemId, f]));
  const bookedItems = new Set(
    budgetInputs.ledger.allocations.filter((a) => a.active).map((a) => a.budgetItemId),
  );
  const categoryNames = new Map(budgetInputs.budget.categories.map((c) => [c.id, c.name]));
  const eventCosts: EventCost[] = eventCostItems(budgetInputs.budget.items, eventId).flatMap(
    (item) => {
      const figure = figures.get(item.id);
      return figure
        ? [
            {
              item,
              figure,
              categoryName: categoryNames.get(item.categoryId) ?? "",
              booked: bookedItems.has(item.id),
            },
          ]
        : [];
    },
  );
  const countCtx: CountContext = {
    guestTarget: settings.targetGuestCount,
    currency: settings.baseCurrency,
    eventNames: new Map(labels.map((e) => [e.id, e.name])),
    showCounts: canManage || access.wedding.shareGuestTotals,
  };

  // The caterer count card's breakdown (UX-14): who locked it, the next reply date, and the bookings
  // that belong to this event's catering with their contract, invoiced and paid figures.
  const currentGuarantee = guarantees.get(eventId)?.current ?? null;
  const lockedBy = actorFor(currentGuarantee?.lockedBy ?? null, access.user.id, memberRoles);
  const replyRow = counts
    ? buildReplyStrip(
        [
          {
            id: eventId,
            name: label.name,
            localDate: label.localDate,
            timeZone: label.effectiveTimeZone,
          },
        ],
        demand.byEvent,
        replyDeadlines,
        new Date(),
      ).rows[0]
    : undefined;
  const replyBy: CardReplyBy | null =
    replyRow && replyRow.nextReplyBy && replyByLabel(replyRow)
      ? {
          iso: replyRow.nextReplyBy,
          several: replyRow.severalReplyDates,
          timeZone: replyRow.timeZone,
        }
      : null;
  const ledger = budgetInputs.ledger;
  const today = todayInZone(settings.timezone);
  const cateringRows: CateringBookingRow[] = cateringBookings({
    eventId,
    catererId: currentGuarantee?.candidateId ?? null,
    items: budgetInputs.budget.items,
    commitments: ledger.commitments,
    allocations: ledger.allocations,
  }).flatMap((b) => {
    const commitment = ledger.commitments.find((c) => c.id === b.commitmentId);
    if (!commitment) return [];
    const v = viewCommitment(ledger, commitment, today);
    return [
      {
        id: commitment.id,
        title: commitment.title,
        href: `${base}/plan/budget/bookings/${commitment.id}`,
        currency: commitment.currency,
        contractMinor: v.ladder.contractMinor,
        invoicedMinor: v.ladder.invoicedMinor,
        paidMinor: v.ladder.paidMinor,
        invoiceCount: v.invoices.filter((i) => i.status !== "void").length,
        withCaterer: b.withCaterer,
        minimum: b.minimum,
      },
    ];
  });

  const scheduled = items.filter((i) => i.status === "scheduled");
  const shown = scheduled.slice(0, AGENDA_PREVIEW);
  // Agenda times are read in the event's own zone (else the wedding's). Caterer dates stay in the
  // wedding's zone.
  const tz = label.effectiveTimeZone;

  return (
    <div className="max-w-3xl space-y-6" data-testid="event-page">
      <header className="space-y-3">
        <p className="text-body-md">
          <Link href={`${base}/plan/events`} className={linkRow}>
            All events
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{label.name}</h1>
        <p className="text-body-lg text-ink-muted">
          {[
            // Don't repeat the kind when the event is simply named after it.
            kindLabel(label.kind).toLowerCase() === label.name.toLowerCase()
              ? null
              : kindLabel(label.kind),
            date ?? "Date not set",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {record && (capacity !== null || record.targetAttendance !== null) && (
          <p className="text-body-md text-ink-muted">
            {[
              capacity !== null
                ? `Capacity ${capacity.value}${capacity.source === "event" ? "" : ` (${CAPACITY_SOURCE_LABELS[capacity.source]})`}`
                : null,
              record.targetAttendance !== null
                ? `Planned attendance ${record.targetAttendance}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {record && (
          <div>
            <TrayButton
              label="Edit event"
              variant="outline"
              size="sm"
              title="Edit event"
              description={record.name}
            >
              <EventForm
                workspaceId={wid}
                event={{ id: record.id, version: record.version }}
                initial={{
                  name: record.name,
                  kind: record.kind,
                  localDate: record.localDate ?? "",
                  targetAttendance:
                    record.targetAttendance === null ? "" : String(record.targetAttendance),
                  capacity: record.capacity === null ? "" : String(record.capacity),
                  planningBasis: record.planningBasis,
                  planOpenPlusOnes: record.planOpenPlusOnes ? "true" : "",
                  invitationsFinal: record.invitationsFinal ? "true" : "",
                  timeZone: record.timeZone ?? "",
                }}
                submitLabel="Save event"
                weddingZone={settings.timezone}
                timeZones={listTimeZones()}
                agenda={
                  scheduled[0]
                    ? {
                        count: scheduled.length,
                        title: scheduled[0].title,
                        startsAt: scheduled[0].startsAt,
                      }
                    : null
                }
              />
            </TrayButton>
          </div>
        )}
        <EventSwitcher base={base} events={labels} currentId={eventId} />
      </header>

      {eventAttention.length > 0 && (
        <Card
          as="section"
          aria-labelledby="event-attention"
          className="space-y-3"
          data-testid="event-attention"
        >
          <CardTitle>
            <span id="event-attention">Needs attention</span>
          </CardTitle>
          <AttentionList
            items={eventAttention}
            base={base}
            workspaceId={wid}
            canAct={attention.canAct}
            testId="event-attention-list"
          />
        </Card>
      )}

      <Card as="section" aria-labelledby="where-heading" className="space-y-3">
        <CardTitle>
          <span id="where-heading">Where</span>
        </CardTitle>
        {place === null ? (
          <p className="text-body-md text-ink-muted" data-testid="where-empty">
            No place chosen yet.
            {venueOptions.length === 0 ? " Save a venue under Discover, then choose it here." : ""}
          </p>
        ) : (
          <div className="space-y-2 text-body-md" data-testid="where-summary">
            <p className="break-words">
              <span className="font-semibold">
                {staleVenue ? (
                  place.venue.name
                ) : (
                  <Link href={`${base}/discover/${place.venue.id}`} className={link}>
                    {place.venue.name}
                  </Link>
                )}
              </span>
              {staleVenue && " (no longer in your saved venues)"}
              {place.space && (
                <>
                  {" · "}
                  {place.space.name}
                  {staleSpace && " (no longer at this venue)"}
                </>
              )}
            </p>
            {capacity !== null ? (
              <p className="text-ink-muted">
                Room for {capacity.value} ({CAPACITY_SOURCE_LABELS[capacity.source]}).
                {capacity.source === "event" &&
                  placeCapacity !== null &&
                  placeCapacity.value !== capacity.value &&
                  ` The ${placeCapacity.source} says ${placeCapacity.value}.`}
              </p>
            ) : (
              <p className="text-ink-muted">
                {staleVenue || staleSpace
                  ? "Choose a current place to compare capacity."
                  : "No capacity entered for this place yet."}
                {!staleVenue && venueRow && (
                  <>
                    {" "}
                    <Link href={`${base}/discover/${place.venue.id}`} className={link}>
                      Add it on the venue page
                    </Link>
                    .
                  </>
                )}
              </p>
            )}
            {counts && capacity !== null && (
              <p data-testid="where-fit">
                <Badge tone={fit.state === "short" ? "pending" : "confirmed"}>
                  {fit.state === "short" ? "Short" : "Fits"}
                </Badge>{" "}
                <span className="ml-1">{fitSentence(fit)}</span>
                {planning !== null && (
                  <span className="text-ink-muted"> (the planning number)</span>
                )}
              </p>
            )}
            {canManage &&
              place.venue.archived === false &&
              venueRow &&
              venueRow.spaces.length === 0 && (
                <p className="text-body-sm text-ink-muted">
                  This venue has no spaces yet.{" "}
                  <Link href={`${base}/discover/${place.venue.id}`} className={link}>
                    Add spaces
                  </Link>
                </p>
              )}
          </div>
        )}
        {canManage && (venueOptions.length > 0 || place !== null) && (
          <TrayButton
            label={place === null ? "Choose a place" : "Change place"}
            variant="outline"
            size="sm"
            title={`Where is ${label.name}?`}
            description="Pick a saved venue, then a space at it. Nothing is sent to the venue and no booking changes."
          >
            <EventLocationForm
              ctx={{
                workspaceId: wid,
                eventId,
                eventKind: label.kind,
                eventCapacity: record?.capacity ?? null,
                version: place?.version ?? 0,
                venues: venueOptions.map((v) => ({
                  id: v.id,
                  name: v.name,
                  seatedCapacity: v.seatedCapacity,
                  ceremonyCapacity: v.ceremonyCapacity,
                  spaces: v.spaces.map((s) => ({
                    id: s.id,
                    name: s.name,
                    seatedCapacity: s.seatedCapacity,
                  })),
                })),
                current: {
                  venueId: place?.venue.id ?? null,
                  venueName: place?.venue.name ?? null,
                  spaceId: place?.space?.id ?? null,
                  spaceName: place?.space?.name ?? null,
                  capacity: placeCapacity,
                },
                planning,
                tableSeats: tableTotals.get(eventId) ?? null,
                agenda: scheduled.map((i) => ({ id: i.id, title: i.title, location: i.location })),
                oldVenueBooked: place !== null && booked.has(place.venue.id),
              }}
            />
          </TrayButton>
        )}
      </Card>

      <Card as="section" aria-labelledby="who-heading" className="space-y-4">
        <CardTitle>
          <span id="who-heading">Who&apos;s coming</span>
        </CardTitle>
        {counts ? (
          <CountStrip demand={counts} eventName={label.name} capacity={capacity?.value ?? null} />
        ) : (
          <TotalsHidden />
        )}
        {canManage && (
          <p className="flex flex-wrap gap-x-6">
            <Link href={`${base}/guests/invitations#event-${eventId}`} className={linkRow}>
              Invitations and answers
              <span className="sr-only"> for {label.name}</span>
            </Link>
            <Link href={`${base}/guests`} className={linkRow}>
              Guest list
            </Link>
          </p>
        )}
      </Card>

      {counts && (
        <Card as="section" aria-labelledby="meals-heading" className="space-y-3">
          <CardTitle>
            <span id="meals-heading">Meals</span>
          </CardTitle>
          {counts.meals.length === 0 ? (
            <p className="text-body-md text-ink-muted">
              No meal choices yet. Guests won&apos;t be asked about a meal for this event.
            </p>
          ) : (
            <ul className="text-body-md" data-testid="meal-totals">
              {counts.meals.map((m) => (
                <li key={m.id}>
                  {m.name}: {m.count}
                  {m.active ? "" : " (no longer offered)"}
                </li>
              ))}
            </ul>
          )}
          {counts.yesWithoutMeal > 0 && counts.meals.length > 0 && (
            <p className="text-body-md">
              {counts.yesWithoutMeal} attending{" "}
              {counts.yesWithoutMeal === 1 ? "guest hasn't" : "guests haven't"} chosen a meal yet.
            </p>
          )}
          {canManage && (
            <p>
              <Link href={`${base}/guests/invitations#event-${eventId}`} className={linkRow}>
                Meal choices<span className="sr-only"> for {label.name}</span>
              </Link>
            </p>
          )}
        </Card>
      )}

      <GuaranteeCard
        workspaceId={wid}
        eventId={eventId}
        eventName={label.name}
        demand={counts}
        guarantees={guarantees.get(eventId)}
        caterers={caterers}
        canManage={canManage}
        timezone={settings.timezone}
        base={base}
        lockedBy={lockedBy}
        replyBy={replyBy}
        bookings={cateringRows}
      />

      <EventCostsCard
        eventName={label.name}
        costs={eventCosts}
        ctx={countCtx}
        budgetHref={`${base}/plan/budget`}
        canEdit={hasCapability(access, "budget.manage")}
      />

      {counts && (
        <Card as="section" aria-labelledby="seating-heading" className="space-y-3">
          <CardTitle>
            <span id="seating-heading">Seating</span>
          </CardTitle>
          <p className="text-body-md" data-testid="seating-totals">
            {counts.seatedConfirmed} of {counts.yes} attending{" "}
            {counts.yes === 1 ? "guest has" : "guests have"} a seat.
            {counts.needSeat > 0
              ? ` ${counts.needSeat} still ${counts.needSeat === 1 ? "needs" : "need"} one.`
              : ""}
            {counts.seatedTentative > 0
              ? ` ${counts.seatedTentative} more ${counts.seatedTentative === 1 ? "is" : "are"} held for guests who haven't answered.`
              : ""}
          </p>
          {hasCapability(access, "seating.manage") && (
            <p>
              <Link href={`${base}/seating/${eventId}`} className={linkRow}>
                Open the seating plan<span className="sr-only"> for {label.name}</span>
              </Link>
            </p>
          )}
        </Card>
      )}

      {shuttleTotals && (
        <Card as="section" aria-labelledby="shuttles-heading" className="space-y-3">
          <CardTitle>
            <span id="shuttles-heading">Shuttles</span>
          </CardTitle>
          <p className="text-body-md" data-testid="shuttle-totals">
            {shuttleTotals.runs === 0
              ? "No shuttles planned for this event."
              : `${shuttleTotals.runs} ${shuttleTotals.runs === 1 ? "shuttle" : "shuttles"} with ${shuttleTotals.seats} seats. ${shuttleTotals.rides} ${shuttleTotals.rides === 1 ? "ride" : "rides"} given to attending guests.`}
          </p>
          <p>
            <Link href={`${base}/plan/events/${eventId}/shuttles`} className={linkRow}>
              {shuttleTotals.runs === 0 ? "Plan shuttles" : "Open shuttles"}
              <span className="sr-only"> for {label.name}</span>
            </Link>
          </p>
        </Card>
      )}

      <Card as="section" aria-labelledby="vendors-heading" className="space-y-3">
        <CardTitle>
          <span id="vendors-heading">Vendors at this event</span>
        </CardTitle>
        {atEvent.length === 0 ? (
          <p className="text-body-md text-ink-muted" data-testid="vendors-empty">
            No vendors assigned yet.
            {vendorData.vendors.some((v) => v.state === "current")
              ? ""
              : " Save a vendor under Discover, then assign it here."}
          </p>
        ) : (
          <ul className="space-y-1" data-testid="event-vendors">
            {atEvent.map((v) => (
              <li key={v.id} className="text-body-md break-words">
                {v.archived ? (
                  <span className="font-semibold">{vendorLabel(v)}</span>
                ) : (
                  <Link href={`${base}/discover/${v.id}`} className={link}>
                    {vendorLabel(v)}
                  </Link>
                )}
                <span className="text-ink-muted">
                  {" · "}
                  {v.categoryLabel}
                  {!v.archived && ` · ${stageLabel(v.stage)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canManageVendors && vendorData.vendors.length > 0 && (
          <TrayButton
            label={atEvent.length === 0 ? "Assign vendors" : "Change vendors"}
            variant="outline"
            size="sm"
            title={`Who works at ${label.name}?`}
            description="Tick the vendors that serve this event. Nothing is sent to them and no booking changes."
          >
            <EventVendorsForm
              workspaceId={wid}
              subjectId={eventId}
              legend="Vendors"
              help="Vendors you've passed on aren't offered, but stay listed here until you remove them."
              options={vendorData.vendors.map((v) => ({
                id: v.id,
                label: vendorLabel(v),
                hint: `${v.categoryLabel}${v.archived ? "" : ` · ${stageLabel(v.stage)}`}`,
              }))}
              initial={vendorIds}
              empty="Save a vendor under Discover first."
            />
          </TrayButton>
        )}
      </Card>

      <Card as="section" aria-labelledby="agenda-heading" className="space-y-3">
        <CardTitle>
          <span id="agenda-heading">Agenda</span>
        </CardTitle>
        {scheduled.length === 0 ? (
          <p className="text-body-md text-ink-muted">No agenda yet. Add what happens and when.</p>
        ) : (
          <>
            <ol className="space-y-2" data-testid="agenda-preview">
              {shown.map((i) => (
                <li key={i.id} className="text-body-md">
                  <span className="font-semibold">{rangeLabel(i.startsAt, i.endsAt, tz)}</span>{" "}
                  {i.title}
                </li>
              ))}
            </ol>
            <p className="text-body-sm text-ink-muted">
              Times in {zoneName(tz, scheduled[0] ? new Date(scheduled[0].startsAt) : undefined)}.
              {scheduled.length > shown.length
                ? ` ${scheduled.length - shown.length} more on the full agenda.`
                : ""}
            </p>
          </>
        )}
        <p>
          <Link href={`${base}/plan/day-of/${eventId}`} className={linkRow}>
            {scheduled.length === 0 && hasCapability(access, "plan.edit")
              ? "Build the agenda"
              : "Open the agenda"}
            <span className="sr-only"> for {label.name}</span>
          </Link>
        </p>
      </Card>
    </div>
  );
}
