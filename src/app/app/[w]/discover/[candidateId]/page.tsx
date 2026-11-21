import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { priceLabel, sourceLabel } from "@/features/discover/format";
import { CommentsSection } from "@/features/comments/comments-section";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { updateCandidate } from "@/server/candidates/actions";
import { loadCandidate } from "@/server/candidates/queries";
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
  const [c, settings, quotes, ledger] = await Promise.all([
    loadCandidate(access.wedding.id, candidateId),
    loadWeddingSettings(access.wedding.id),
    loadProposalsForCandidate(access.wedding.id, candidateId),
    loadLedger(access.wedding.id),
  ]);
  if (!c) notFound();
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
          {canManage ? `Edit ${c.name}` : c.name}
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
          <ButtonLink href={`${base}/discover/${c.id}/quotes/new`} variant="outline" size="sm">
            Add a quote
          </ButtonLink>
        )}
      </section>

      {canManage ? (
        <>
          <h2 className="font-serif text-headline-sm">Details</h2>
          {c.priceCurrency !== null && c.priceCurrency !== settings.baseCurrency && (
            <p className="text-body-md text-ink-muted">
              This price was entered in {c.priceCurrency}, but your wedding now uses{" "}
              {settings.baseCurrency}. Saving a new amount records it in {settings.baseCurrency}.
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
          <div className="space-y-2 border-t border-border-hairline pt-6">
            <ArchiveCandidateForm
              workspaceId={access.wedding.id}
              candidateId={c.id}
              version={c.version}
            />
          </div>
        </>
      ) : (
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
          <p className="text-ink-muted">You can view this. Ask the workspace owner to change it.</p>
        </dl>
      )}
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
