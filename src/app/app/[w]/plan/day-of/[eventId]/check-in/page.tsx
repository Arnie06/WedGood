import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardTitle } from "@/components/ui/card";
import {
  guestArrivalSentence,
  summarizeGuestArrivals,
  vendorArrivalSentence,
} from "@/domain/checkin/checkin";
import { GuestCheckInList, VendorCheckInList } from "@/features/checkin/checkin-lists";
import { timeLabel, zoneName } from "@/features/timeline/format";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { checkInEnabled } from "@/server/checkin/flag";
import { loadGuestArrivals, loadVendorArrivals } from "@/server/checkin/queries";
import { loadEventLabels } from "@/server/timeline/queries";

export const metadata: Metadata = { title: "Check-in" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";
const linkRow = `${link} inline-flex min-h-11 items-center`;

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ w: string; eventId: string }>;
}) {
  const { w, eventId } = await params;
  const access = await requireWorkspace(w);
  if (!checkInEnabled() || !UUID.test(eventId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const label = (await loadEventLabels(wid)).find((e) => e.id === eventId);
  if (!label) notFound();

  const tz = label.effectiveTimeZone;
  const canGuests = hasCapability(access, "guests.manage");
  const canVendors = hasCapability(access, "plan.edit");
  const [guests, vendors] = await Promise.all([
    canGuests ? loadGuestArrivals(wid, eventId) : Promise.resolve([]),
    loadVendorArrivals(wid, eventId),
  ]);
  const at = (iso: string | null) => (iso ? timeLabel(iso, tz) : null);
  const guestRows = guests.map((g) => ({ ...g, arrivedLabel: at(g.arrivedAt) }));
  const vendorRows = vendors.map((v) => ({ ...v, arrivedLabel: at(v.arrivedAt) }));
  const summary = summarizeGuestArrivals(guests);
  const zone = zoneName(
    tz,
    label.localDate ? new Date(`${label.localDate}T12:00:00Z`) : new Date(),
  );

  return (
    <div className="max-w-3xl space-y-6" data-testid="checkin-page">
      <header className="space-y-3">
        <p>
          <Link href={`${base}/plan/day-of/${eventId}`} className={linkRow}>
            Back to the {label.name} agenda
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Check-in for {label.name}
        </h1>
        <p className="text-body-lg text-ink-muted">
          Record who has actually arrived. This is separate from who said yes, and nothing is sent
          to anyone. Each arrival is stamped with the time you tap, in {zone}.
        </p>
      </header>

      {canGuests ? (
        <Card as="section" aria-labelledby="guests-heading" className="space-y-4">
          <CardTitle>
            <span id="guests-heading">Guests</span>
          </CardTitle>
          <p className="text-body-lg font-semibold" data-testid="checkin-guest-summary">
            {guestArrivalSentence(summary)}
          </p>
          <GuestCheckInList workspaceId={wid} eventId={eventId} guests={guestRows} />
          {guests.length > 0 && (
            <p>
              <a
                href={`${base}/plan/day-of/${eventId}/check-in/export`}
                className={linkRow}
                download
              >
                Download attendance (CSV)
              </a>
            </p>
          )}
        </Card>
      ) : (
        <Card>
          <p className="text-body-md">
            Guest check-in shows who was invited, so it is limited to people who manage guests.
          </p>
        </Card>
      )}

      <Card as="section" aria-labelledby="vendors-heading" className="space-y-4">
        <CardTitle>
          <span id="vendors-heading">Vendors</span>
        </CardTitle>
        <p className="text-body-lg font-semibold" data-testid="checkin-vendor-summary">
          {vendorArrivalSentence(vendors)}
        </p>
        {vendorRows.length === 0 ? (
          <p className="text-body-md text-ink-muted">
            Link vendors to this event on its page and they will appear here.
          </p>
        ) : (
          <VendorCheckInList
            workspaceId={wid}
            eventId={eventId}
            vendors={vendorRows}
            canEdit={canVendors}
          />
        )}
        {!canVendors && vendorRows.length > 0 && (
          <p className="text-body-sm text-ink-muted">You can see arrivals but not record them.</p>
        )}
      </Card>
    </div>
  );
}
