import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { formatMinor } from "@/domain/money/money";
import { normalizeProposal } from "@/domain/proposals/normalize";
import { minorToMajorInput } from "@/domain/wedding/settings";
import { BookingForm } from "@/features/ledger/ledger-forms";
import { freeCosts } from "@/features/ledger/view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { loadCandidate } from "@/server/candidates/queries";
import { bookCommitment } from "@/server/ledger/actions";
import { loadLedger } from "@/server/ledger/queries";
import { loadProposalsForCandidate } from "@/server/proposals/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Record a booking" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string; candidateId: string }>;
  searchParams: Promise<{ proposal?: string }>;
}) {
  const { w, candidateId } = await params;
  const { proposal } = await searchParams;
  const access = await requireWorkspace(w);
  if (!UUID.test(candidateId)) notFound();
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const [candidate, settings, quotes, budget, ledger] = await Promise.all([
    loadCandidate(wid, candidateId),
    loadWeddingSettings(wid),
    loadProposalsForCandidate(wid, candidateId),
    loadBudget(wid),
    loadLedger(wid),
  ]);
  if (!candidate) notFound();
  const back = `${base}/discover/${candidate.id}`;
  const currency = settings.baseCurrency;

  if (!hasCapability(access, "budget.manage") || !hasCapability(access, "vendors.manage")) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Record a booking</h1>
        <p className="text-body-md text-ink-muted">
          You can view this, but only the workspace owner or partner can record a booking.
        </p>
        <Link href={back} className={link}>
          Back to {candidate.name}
        </Link>
      </div>
    );
  }
  const existing = ledger.commitments.find(
    (c) => c.candidateId === candidate.id && c.status === "active",
  );
  if (candidate.stage === "booked" || existing) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Already booked</h1>
        <p className="text-body-md text-ink-muted">
          {candidate.name} is already recorded as booked. To change the amount or schedule, amend
          the booking.
        </p>
        {existing && (
          <Link href={`${base}/plan/budget/bookings/${existing.id}`} className={link}>
            Open the booking
          </Link>
        )}
      </div>
    );
  }
  if (candidate.stage === "declined" || candidate.stage === "cancelled") {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Can&apos;t book yet</h1>
        <p className="text-body-md text-ink-muted">
          {candidate.name} is marked as passed. Move it back to considering first if you want to
          book it.
        </p>
        <Link href={back} className={link}>
          Back to {candidate.name}
        </Link>
      </div>
    );
  }

  const selected = quotes.find((q) => q.id === proposal && q.status === "open");
  const norm = selected ? normalizeProposal(selected.lines, settings.targetGuestCount) : null;
  const prefillAmount =
    norm?.complete === true && selected?.currency === currency ? norm.requiredKnownMinor : null;
  const costs = freeCosts(budget.items, budget.categories, ledger);

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          Record a booking with {candidate.name}
        </h1>
        <p className="text-body-lg text-ink-muted">
          Use this once you&apos;ve signed or explicitly agreed. Choosing a quote doesn&apos;t book
          anything; this step does.
        </p>
      </header>
      {selected && (
        <Card>
          <p className="text-body-md">
            From the quote <strong>{selected.title}</strong>.{" "}
            {prefillAmount !== null
              ? `Every required cost in it has a figure, so the total below starts at ${formatMinor(prefillAmount, currency)}. Check it against your contract.`
              : "It still has unknown costs, so enter the total from your contract."}
          </p>
        </Card>
      )}
      {!selected && quotes.some((q) => q.status === "open") && (
        <p className="text-body-md text-ink-muted">
          Booking from a quote? Open it from the quote list to link it here. You can also record a
          booking without one.
        </p>
      )}
      <BookingForm
        action={bookCommitment}
        workspaceId={wid}
        currency={currency}
        costs={costs}
        defaults={{
          title: selected ? `${candidate.name} · ${selected.title}` : candidate.name,
          amount: prefillAmount === null ? "" : minorToMajorInput(prefillAmount, currency),
        }}
        hidden={{
          candidateId: candidate.id,
          version: candidate.version,
          proposalId: selected?.id ?? "",
        }}
        submitLabel="Record this booking"
        pendingLabel="Recording…"
        confirmLabel={`I've signed or explicitly agreed to this with ${candidate.name}.`}
      />
      <Link href={back} className={link}>
        Cancel and go back
      </Link>
    </div>
  );
}
