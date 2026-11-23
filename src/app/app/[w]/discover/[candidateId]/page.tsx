import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { ProposalForm } from "@/features/quotes/proposal-form";
import { createProposal } from "@/server/proposals/actions";
import { stageLabel } from "@/domain/proposals/stages";
import { QuoteList } from "@/features/quotes/quote-list";
import { StageForm } from "@/features/quotes/quote-actions";
import { loadLedger } from "@/server/ledger/queries";
import { loadProposalsForCandidate } from "@/server/proposals/queries";
import { categoryLabel } from "@/domain/candidates/categories";
import { displayHost } from "@/domain/candidates/input";
import { minorToMajorInput } from "@/domain/wedding/settings";
import { ArchiveCandidateForm } from "@/features/discover/candidate-actions";
import { CandidateForm } from "@/features/discover/candidate-form";
import { ArchiveSpaceForm, SpaceForm } from "@/features/discover/space-forms";
import { priceLabel, sourceLabel } from "@/features/discover/format";
import { CommentsSection } from "@/features/comments/comments-section";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { updateCandidate } from "@/server/candidates/actions";
import { loadCandidate } from "@/server/candidates/queries";
import { loadEventLocations, loadSpacesForVenue } from "@/server/events/location";
import { loadEventVendorData } from "@/server/events/vendors";
import { WorksAt } from "@/features/events/works-at";
import { loadEventLabels } from "@/server/timeline/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Venue or vendor" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ w: string; candidateId: string }>;
}) {
  const { w, candidateId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(candidateId)) notFound();
  const base = `/app/${access.wedding.id}`;
  const canManage = hasCapability(access, "vendors.manage");
  const [c, settings, quotes, ledger, spaces, locations, eventLabels, eventVendors] =
    await Promise.all([
      loadCandidate(access.wedding.id, candidateId),
      loadWeddingSettings(access.wedding.id),
      loadProposalsForCandidate(access.wedding.id, candidateId),
      loadLedger(access.wedding.id),
      loadSpacesForVenue(access.wedding.id, candidateId),
      loadEventLocations(access.wedding.id),
      loadEventLabels(access.wedding.id),
      loadEventVendorData(access.wedding.id),
    ]);
  if (!c) notFound();
  const heldHere = eventLabels.filter((e) => locations.get(e.id)?.venue.id === candidateId);
  const currency = c.priceCurrency ?? settings.baseCurrency;
  const booking = ledger.commitments.find(
    (x) => x.candidateId === candidateId && x.status === "active",
  );
  const canBook =
    hasCapability(access, "budget.manage") &&
    canManage &&
    !booking &&
    c.stage !== "booked" &&
    c.stage !== "declined" &&
    c.stage !== "cancelled";
  const price = priceLabel(c.priceMinor, c.priceBasis, c.priceCurrency);

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {c.name}
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-body-md text-ink-muted">
          <Badge tone="neutral">{categoryLabel(c.category)}</Badge>
          {c.isFavorite && <Badge tone="confirmed">Favorite</Badge>}
          <Badge tone={c.stage === "declined" ? "neutral" : "pending"}>{stageLabel(c.stage)}</Badge>
        </p>
      </div>

      <section aria-labelledby="stage-heading" className="space-y-3">
        <h2 id="stage-heading" className="font-serif text-headline-sm">
          Progress
        </h2>
        {canManage ? (
          <StageForm
            workspaceId={access.wedding.id}
            candidateId={c.id}
            version={c.version}
            stage={c.stage}
          />
        ) : (
          <p className="text-body-md text-ink-muted">Stage: {stageLabel(c.stage)}</p>
        )}
      </section>

      {(booking || canBook) && (
        <section aria-labelledby="booking-heading" className="space-y-3">
          <h2 id="booking-heading" className="font-serif text-headline-sm">
            Booking
          </h2>
          {booking ? (
            <p className="text-body-md">
              Booked.{" "}
              <Link href={`${base}/plan/budget/bookings/${booking.id}`} className={link}>
                See the booking and payments
              </Link>
            </p>
          ) : (
            <>
              <p className="text-body-md text-ink-muted">
                Once you&apos;ve signed or explicitly agreed, record it here. Nothing is sent to
                them and no money moves.
              </p>
              <ButtonLink href={`${base}/discover/${c.id}/book`} variant="secondary" size="sm">
                Record a booking
              </ButtonLink>
            </>
          )}
        </section>
      )}

      {c.kind === "vendor" && (
        <WorksAt
          workspaceId={access.wedding.id}
          vendorId={c.id}
          vendorName={c.name}
          events={eventLabels}
          linkedEventIds={eventVendors.byVendor.get(c.id) ?? []}
          canManage={canManage}
          headingId="works-at-heading"
        />
      )}

      <section aria-labelledby="quotes-heading" className="space-y-3">
        <h2 id="quotes-heading" className="font-serif text-headline-sm">
          Quotes
        </h2>
        {quotes.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              No quotes yet. When they send one, add its costs here so you can see what&apos;s known
              and what&apos;s still missing. Adding a quote doesn&apos;t book anything.
            </p>
          </Card>
        ) : (
          <QuoteList
            quotes={quotes}
            base={base}
            candidateId={c.id}
            guestCount={settings.targetGuestCount}
          />
        )}
        {canManage && (
          <TrayButton
            label="Add a quote"
            variant="outline"
            size="sm"
            title={`Add a quote from ${c.name}`}
            openOnParam="addQuote"
            description="Start with the basics, then add each cost on the next page. This only records what you were told. It doesn't book anything."
          >
            <ProposalForm
              action={createProposal}
              submitLabel="Save and add costs"
              pendingLabel="Saving…"
              defaults={{ title: "", receivedOn: "", validUntil: "", sourceUrl: "", notes: "" }}
              hidden={{
                workspaceId: access.wedding.id,
                candidateId: c.id,
                idempotencyKey: randomUUID(),
              }}
            />
          </TrayButton>
        )}
      </section>

      {c.kind === "venue" && (
        <section aria-labelledby="spaces-heading" className="space-y-3" data-testid="spaces">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="spaces-heading" className="font-serif text-headline-sm">
              Spaces
            </h2>
            {canManage && (
              <TrayButton
                label="Add a space"
                variant="outline"
                size="sm"
                title={`Add a space at ${c.name}`}
                description="A room or area an event could use. Capacities are only what you were told."
              >
                <SpaceForm workspaceId={access.wedding.id} venueId={c.id} />
              </TrayButton>
            )}
          </div>
          {spaces.length === 0 ? (
            <p className="text-body-md text-ink-muted">
              No spaces yet. Add the rooms or areas you might use, like a terrace or a hall, so each
              event can say which one it is in.
            </p>
          ) : (
            <ul className="space-y-3">
              {spaces.map((sp) => (
                <li
                  key={sp.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border-hairline p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold break-words">{sp.name}</p>
                    <p className="text-body-md text-ink-muted">
                      {[
                        sp.seatedCapacity !== null ? `Seats ${sp.seatedCapacity}` : null,
                        sp.standingCapacity !== null ? `Standing ${sp.standingCapacity}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Capacity not entered yet"}
                    </p>
                    {sp.notes && (
                      <p className="text-body-md text-ink-muted whitespace-pre-wrap">{sp.notes}</p>
                    )}
                  </div>
                  {canManage && (
                    <TrayButton
                      label="Edit"
                      ariaLabel={`Edit ${sp.name}`}
                      variant="outline"
                      size="sm"
                      title={`Edit ${sp.name}`}
                    >
                      <SpaceForm
                        workspaceId={access.wedding.id}
                        venueId={c.id}
                        space={{ id: sp.id, version: sp.version }}
                        defaults={{
                          name: sp.name,
                          seatedCapacity: sp.seatedCapacity?.toString() ?? "",
                          standingCapacity: sp.standingCapacity?.toString() ?? "",
                          notes: sp.notes ?? "",
                        }}
                      />
                      <div className="border-t border-border-hairline pt-4">
                        <ArchiveSpaceForm
                          workspaceId={access.wedding.id}
                          spaceId={sp.id}
                          version={sp.version}
                        />
                      </div>
                    </TrayButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {heldHere.length > 0 && (
            <p className="text-body-md text-ink-muted" data-testid="held-here">
              Held here:{" "}
              {heldHere.map((e, i) => (
                <span key={e.id}>
                  {i > 0 && ", "}
                  <Link href={`${base}/plan/events/${e.id}`} className={link}>
                    {e.name}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="details-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="details-heading" className="font-serif text-headline-sm">
            Details
          </h2>
          {canManage && (
            <TrayButton label="Edit details" variant="outline" size="sm" title={`Edit ${c.name}`}>
              {c.priceCurrency !== null && c.priceCurrency !== settings.baseCurrency && (
                <p className="text-body-md text-ink-muted">
                  This price was entered in {c.priceCurrency}, but your wedding now uses{" "}
                  {settings.baseCurrency}. Saving a new amount records it in {settings.baseCurrency}
                  .
                </p>
              )}
              <CandidateForm
                action={updateCandidate}
                kind={c.kind}
                currency={c.priceMinor !== null ? currency : settings.baseCurrency}
                submitLabel="Save changes"
                pendingLabel="Saving…"
                defaults={{
                  name: c.name,
                  category: c.category === "venue" ? "" : c.category,
                  sourceUrl: c.sourceUrl ?? "",
                  sourceCheckedOn: c.sourceCheckedOn ?? "",
                  location: c.location ?? "",
                  pricingDisplay: c.pricingDisplay ?? "",
                  price: minorToMajorInput(c.priceMinor, currency),
                  priceBasis: c.priceBasis ?? "",
                  notes: c.notes ?? "",
                  seatedCapacity: c.seatedCapacity?.toString() ?? "",
                  ceremonyCapacity: c.ceremonyCapacity?.toString() ?? "",
                }}
                hidden={{
                  workspaceId: access.wedding.id,
                  candidateId: c.id,
                  version: String(c.version),
                }}
              />
              <div className="border-t border-border-hairline pt-4">
                <ArchiveCandidateForm
                  workspaceId={access.wedding.id}
                  candidateId={c.id}
                  version={c.version}
                />
              </div>
            </TrayButton>
          )}
        </div>
        <dl className="space-y-4 text-body-md">
          {c.location && <Item label="Location">{c.location}</Item>}
          <Item label="Price">{price ?? "Not entered yet"}</Item>
          {c.pricingDisplay && <Item label="Pricing note">{c.pricingDisplay}</Item>}
          {c.kind === "venue" && (
            <Item label="Capacity">
              {[
                c.seatedCapacity !== null ? `Seats ${c.seatedCapacity}` : null,
                c.ceremonyCapacity !== null ? `Ceremony ${c.ceremonyCapacity}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Not entered yet"}
            </Item>
          )}
          <Item label="Source">
            {sourceLabel(c.sourceUrl, c.sourceCheckedOn)}
            {c.sourceUrl && (
              <>
                {" · "}
                <a
                  href={c.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className={link}
                >
                  {displayHost(c.sourceUrl)}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            )}
          </Item>
          {c.notes && (
            <Item label="Notes">
              <span className="whitespace-pre-wrap">{c.notes}</span>
            </Item>
          )}
          {!canManage && (
            <p className="text-ink-muted">
              You can view this. Ask the workspace owner to change it.
            </p>
          )}
        </dl>
      </section>
      <CommentsSection
        workspaceId={access.wedding.id}
        role={access.membership.role}
        kind="candidate"
        subjectId={c.id}
      />
      <p>
        <Link href={`${base}/discover`} className={link}>
          Back to your list
        </Link>
      </p>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-label-lg font-semibold">{label}</dt>
      <dd className="text-ink-muted">{children}</dd>
    </div>
  );
}
