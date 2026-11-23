import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { daysBetween, formatDateOnly, parseDateOnly, todayInZone } from "@/domain/dates/date-only";
import { blockExposure, type Exposure } from "@/domain/lodging/attrition";
import type { BlockField, HotelField } from "@/domain/lodging/input";
import { stayLabel, stayView, summarizeStays } from "@/domain/lodging/stays";
import { formatMinor } from "@/domain/money/money";
import {
  ArchiveHotelForm,
  BlockForm,
  HotelForm,
  PickupForm,
  RemoveBlockForm,
  StaysForm,
} from "@/features/lodging/lodging-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { lodgingEnabled } from "@/server/lodging/flag";
import { loadLodging, type LodgingBlock, type LodgingHotel } from "@/server/lodging/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Lodging" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const linkRow = `${link} inline-flex min-h-11 items-center`;

const day = (iso: string) => formatDateOnly(parseDateOnly(iso));
const short = (iso: string) => formatDateOnly(parseDateOnly(iso), "en-US", { dateStyle: "medium" });

/** Major-unit text for a form field, e.g. 18950 -> "189.50" (2-digit currencies). */
function majorText(minor: number | null, currency: string): string {
  if (minor === null) return "";
  const digits =
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}
const percentText = (bp: number | null) =>
  bp === null ? "" : bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "");

const hotelInitial = (h?: LodgingHotel): Record<HotelField, string> => ({
  name: h?.name ?? "",
  address: h?.address ?? "",
  phone: h?.phone ?? "",
  websiteUrl: h?.websiteUrl ?? "",
  guestNote: h?.guestNote ?? "",
  showToGuests: (h?.showToGuests ?? true) ? "on" : "",
  showRate: h?.showRate ? "on" : "",
  candidateId: h?.candidateId ?? "",
});

const blockInitial = (currency: string, b?: LodgingBlock): Record<BlockField, string> => ({
  label: b?.label ?? "",
  checkIn: b?.checkIn ?? "",
  checkOut: b?.checkOut ?? "",
  roomsPerNight: b ? String(b.roomsPerNight) : "",
  nightlyRate: majorText(b?.nightlyRateMinor ?? null, currency),
  attritionPercent: percentText(b?.attritionAllowedBp ?? null),
  attritionCharge: majorText(b?.attritionChargeMinor ?? null, currency),
  cutoffDate: b?.cutoffDate ?? "",
  bookingUrl: b?.bookingUrl ?? "",
  bookingCode: b?.bookingCode ?? "",
  budgetCategoryId: b?.budgetCategoryId ?? "",
});

function bookByText(cutoff: string | null, today: string): string {
  if (!cutoff) return "No book-by date";
  const left = daysBetween(parseDateOnly(today), parseDateOnly(cutoff));
  if (left < 0) return `Book-by date passed (${short(cutoff)})`;
  if (left === 0) return `Book by today (${short(cutoff)})`;
  return `Book by ${short(cutoff)}, in ${left} ${left === 1 ? "day" : "days"}`;
}

function ExposureList({
  e,
  b,
  money,
}: {
  e: Exposure;
  b: LodgingBlock;
  money: (n: number) => string;
}) {
  const rows: [string, string][] = [
    [
      "Rooms held",
      `${b.roomsPerNight} ${b.roomsPerNight === 1 ? "room" : "rooms"} × ${e.nights} ${e.nights === 1 ? "night" : "nights"} = ${e.roomNightsHeld} room-nights`,
    ],
    [
      "To owe nothing",
      e.roomNightsRequired === null
        ? "Unknown: add the attrition terms from your contract"
        : `${e.roomNightsRequired} room-nights booked by guests`,
    ],
    [
      "Booked so far",
      b.pickedUpRoomNights === null || b.pickedUpAsOf === null
        ? "No report from the hotel yet"
        : `${b.pickedUpRoomNights} room-nights (hotel report, ${short(b.pickedUpAsOf)})`,
    ],
    [
      "Possible charge now",
      e.expectedMinor !== null
        ? e.expectedMinor === 0
          ? "None at the last report"
          : `${money(e.expectedMinor)} (${e.shortfall} room-nights short)`
        : `Unknown: ${e.missing
            .map((m) =>
              m === "rate"
                ? "no rate"
                : m === "attrition"
                  ? "no attrition terms"
                  : "no pickup report",
            )
            .join(", ")}`,
    ],
    ["If no one books", e.worstMinor === null ? "Unknown" : money(e.worstMinor)],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-label-lg text-ink-muted">{k}</dt>
          <dd className="text-body-md break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function LodgingPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  if (!lodgingEnabled()) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Lodging</h1>
        <Card>
          <p className="text-body-md">
            Lodging shows who is attending and where they stay, so it is limited to people who
            manage guests.
          </p>
        </Card>
      </div>
    );
  }

  const [data, settings] = await Promise.all([loadLodging(wid), loadWeddingSettings(wid)]);
  const cur = settings.baseCurrency;
  const money = (n: number) => formatMinor(n, cur);
  const today = todayInZone(access.wedding.timezone);
  const summary = summarizeStays(data.attending, data.stays);
  const hotelName = new Map(data.hotels.map((h) => [h.id, h.name]));
  const nameOf = (id: string) => hotelName.get(id) ?? "A hotel";
  const vendorName = new Map(data.vendors.map((v) => [v.id, v.name]));
  const categoryName = new Map(data.categories.map((c) => [c.id, c.name]));
  const active = data.hotels.filter((h) => !h.archived);
  const archived = data.hotels.filter((h) => h.archived);
  const ordered = [...active, ...archived];

  return (
    <div className="max-w-3xl space-y-8" data-testid="lodging-page">
      <header className="space-y-3">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Lodging</h1>
        <p className="text-body-lg text-ink-muted">
          Hotels you recommend, the rooms you&apos;re holding, and where guests are staying. Nothing
          here is sent to hotels or guests.
        </p>
      </header>

      <section aria-labelledby="hotels-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="hotels-heading" className="font-serif text-headline-sm">
            Hotels
          </h2>
          {active.length < 30 && (
            <TrayButton label="Add a hotel" size="sm" title="Add a hotel">
              <HotelForm workspaceId={wid} initial={hotelInitial()} vendors={data.vendors} />
            </TrayButton>
          )}
        </div>
        {ordered.length === 0 && (
          <Card>
            <p className="text-body-md">
              No hotels yet. Add one to hold rooms for guests, track the hotel&apos;s pickup reports
              and show it on your website.
            </p>
          </Card>
        )}
        <ul className="space-y-4">
          {ordered.map((h) => {
            const blocks = data.blocks
              .filter((b) => b.hotelId === h.id)
              .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
            const counts = summary.byHotel.get(h.id);
            return (
              <Card as="li" key={h.id} className="space-y-4" data-testid={`hotel-${h.name}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <CardTitle as="h3">{h.name}</CardTitle>
                    <p className="flex flex-wrap gap-2">
                      {h.archived ? (
                        <Badge tone="neutral">Archived</Badge>
                      ) : h.showToGuests ? (
                        <Badge tone="confirmed">Shown to guests</Badge>
                      ) : (
                        <Badge tone="neutral">Not shown to guests</Badge>
                      )}
                      {!h.archived && h.showToGuests && (
                        <Badge tone="neutral">{h.showRate ? "Rate shown" : "Rate hidden"}</Badge>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!h.archived && (
                      <TrayButton
                        label="Edit"
                        variant="outline"
                        size="sm"
                        title="Edit hotel"
                        description={h.name}
                      >
                        <HotelForm
                          workspaceId={wid}
                          initial={hotelInitial(h)}
                          vendors={data.vendors}
                          hotel={{ id: h.id, version: h.version }}
                        />
                      </TrayButton>
                    )}
                    <TrayButton
                      label={h.archived ? "Restore" : "Archive"}
                      variant="quiet"
                      size="sm"
                      title={h.archived ? "Restore hotel" : "Archive hotel"}
                      description={h.name}
                    >
                      <ArchiveHotelForm
                        workspaceId={wid}
                        hotel={{ id: h.id, version: h.version, name: h.name, archived: h.archived }}
                      />
                    </TrayButton>
                  </div>
                </div>
                {h.address && <p className="text-body-md break-words">{h.address}</p>}
                {h.candidateId && vendorName.has(h.candidateId) && (
                  <p className="text-body-md">
                    Linked vendor:{" "}
                    <Link href={`${base}/discover/${h.candidateId}`} className={link}>
                      {vendorName.get(h.candidateId)}
                    </Link>
                  </p>
                )}
                <p className="text-body-md text-ink-muted" data-testid="hotel-guest-count">
                  {counts
                    ? `${counts.people} attending ${counts.people === 1 ? "guest says" : "guests say"} they're staying here (${counts.households} ${counts.households === 1 ? "household" : "households"}). That's a guide, not the hotel's count.`
                    : "No attending guests have said they're staying here yet."}
                </p>

                {blocks.map((b) => {
                  const e = blockExposure(b);
                  const name = b.label ? `${b.label} block` : `Block from ${short(b.checkIn)}`;
                  return (
                    <div
                      key={b.id}
                      className="space-y-3 border-t border-border-hairline pt-4"
                      data-testid="lodging-block"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="text-label-lg font-semibold break-words">
                            {b.label ? `${b.label}: ` : ""}
                            {day(b.checkIn)} to {day(b.checkOut)}
                          </h4>
                          <p className="text-body-md">
                            {bookByText(b.cutoffDate, today)}
                            {b.nightlyRateMinor !== null &&
                              ` · ${money(b.nightlyRateMinor)} a night`}
                          </p>
                          {b.budgetCategoryId && categoryName.has(b.budgetCategoryId) && (
                            <p className="text-body-sm text-ink-muted">
                              Budget category: {categoryName.get(b.budgetCategoryId)}
                            </p>
                          )}
                        </div>
                        {!h.archived && (
                          <div className="flex flex-wrap gap-2">
                            <TrayButton
                              label="Pickup report"
                              variant="outline"
                              size="sm"
                              title="Hotel pickup report"
                              description={`${h.name} · ${name}`}
                            >
                              <PickupForm
                                workspaceId={wid}
                                today={today}
                                block={{
                                  id: b.id,
                                  version: b.version,
                                  checkIn: b.checkIn,
                                  checkOut: b.checkOut,
                                  rooms: b.roomsPerNight,
                                  held: e.roomNightsHeld,
                                  roomNights: b.pickedUpRoomNights,
                                  asOf: b.pickedUpAsOf,
                                }}
                              />
                            </TrayButton>
                            <TrayButton
                              label="Edit"
                              variant="quiet"
                              size="sm"
                              title="Edit block"
                              description={`${h.name} · ${name}`}
                            >
                              <BlockForm
                                workspaceId={wid}
                                hotelId={h.id}
                                initial={blockInitial(cur, b)}
                                categories={data.categories}
                                currency={cur}
                                block={{ id: b.id, version: b.version }}
                              />
                            </TrayButton>
                            <TrayButton
                              label="Remove"
                              variant="quiet"
                              size="sm"
                              title="Remove block"
                              description={`${h.name} · ${name}`}
                            >
                              <RemoveBlockForm
                                workspaceId={wid}
                                block={{ id: b.id, version: b.version, name }}
                              />
                            </TrayButton>
                          </div>
                        )}
                      </div>
                      <ExposureList e={e} b={b} money={money} />
                    </div>
                  );
                })}
                {!h.archived && blocks.length < 10 && (
                  <TrayButton
                    label={blocks.length === 0 ? "Add a room block" : "Add another block"}
                    variant="outline"
                    size="sm"
                    title="Add a room block"
                    description={h.name}
                  >
                    <BlockForm
                      workspaceId={wid}
                      hotelId={h.id}
                      initial={blockInitial(cur)}
                      categories={data.categories}
                      currency={cur}
                    />
                  </TrayButton>
                )}
              </Card>
            );
          })}
        </ul>
        {data.blocks.length > 0 && (
          <p className="text-body-sm text-ink-muted">
            Possible charges also appear on the{" "}
            <Link href={`${base}/plan/budget`} className={link}>
              Budget page
            </Link>
            , beside your forecast and never added to it.
          </p>
        )}
      </section>

      <section aria-labelledby="stays-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="stays-heading" className="font-serif text-headline-sm">
            Who&apos;s staying where
          </h2>
          {data.attending.length > 0 && (
            <TrayButton
              label="Set where guests stay"
              variant="outline"
              size="sm"
              title="Set where guests stay"
            >
              <StaysForm
                workspaceId={wid}
                hotels={active.map((h) => ({ id: h.id, name: h.name }))}
                guests={data.attending.map((g) => {
                  const now = stayView(data.stays.get(g.id)).effective;
                  return {
                    id: g.id,
                    name: g.name,
                    detail:
                      [g.household, now ? stayLabel(now, nameOf) : null]
                        .filter(Boolean)
                        .join(" · ") || null,
                  };
                })}
              />
            </TrayButton>
          )}
        </div>
        <Card className="space-y-3">
          {data.attending.length === 0 ? (
            <p className="text-body-md">No one has accepted an invitation yet.</p>
          ) : (
            <>
              <p className="text-body-md" data-testid="stay-summary">
                {data.attending.length} attending:{" "}
                {[
                  ...active
                    .filter((h) => summary.byHotel.has(h.id))
                    .map((h) => `${summary.byHotel.get(h.id)?.people ?? 0} at ${h.name}`),
                  ...archived
                    .filter((h) => summary.byHotel.has(h.id))
                    .map(
                      (h) => `${summary.byHotel.get(h.id)?.people ?? 0} at ${h.name} (archived)`,
                    ),
                  summary.elsewhere > 0 && `${summary.elsewhere} elsewhere`,
                  summary.notStaying > 0 && `${summary.notStaying} not staying overnight`,
                  summary.unknown > 0 && `${summary.unknown} not known yet`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                .
              </p>
              <ul className="divide-y divide-border-hairline">
                {data.attending.map((g) => {
                  const v = stayView(data.stays.get(g.id));
                  return (
                    <li
                      key={g.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 compact:py-1"
                    >
                      <span className="min-w-0 break-words">
                        <span className="text-body-md font-semibold">{g.name}</span>
                        {g.household && (
                          <span className="block text-body-sm text-ink-muted">{g.household}</span>
                        )}
                      </span>
                      <span className="text-body-md">
                        {stayLabel(v.effective, nameOf)}
                        {v.source === "guest" && (
                          <span className="block text-body-sm text-ink-muted">
                            From the guest&apos;s RSVP
                          </span>
                        )}
                        {v.guestDiffers && (
                          <span className="block text-body-sm text-ink-muted">
                            Guest said: {stayLabel(v.guestDiffers, nameOf)}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p>
                <a href={`${base}/plan/lodging/export`} className={linkRow} download>
                  Download who&apos;s staying where (CSV)
                </a>
              </p>
            </>
          )}
        </Card>
      </section>
    </div>
  );
}
