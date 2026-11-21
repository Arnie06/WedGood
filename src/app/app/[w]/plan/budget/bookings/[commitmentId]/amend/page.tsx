import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMinor } from "@/domain/money/money";
import { minorToMajorInput } from "@/domain/wedding/settings";
import { BookingForm } from "@/features/ledger/ledger-forms";
import { freeCosts, viewCommitment } from "@/features/ledger/view";
import { todayInZone } from "@/domain/dates/date-only";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadBudget } from "@/server/budget/queries";
import { amendCommitment } from "@/server/ledger/actions";
import { loadLedger } from "@/server/ledger/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Amend a booking" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function AmendPage({
  params,
}: {
  params: Promise<{ w: string; commitmentId: string }>;
}) {
  const { w, commitmentId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(commitmentId)) notFound();
  const wid = access.wedding.id;
  const back = `/app/${wid}/plan/budget/bookings/${commitmentId}`;
  const [settings, budget, ledger] = await Promise.all([
    loadWeddingSettings(wid),
    loadBudget(wid),
    loadLedger(wid),
  ]);
  const commitment = ledger.commitments.find((c) => c.id === commitmentId);
  if (!commitment) notFound();
  const cur = settings.baseCurrency;

  if (!hasCapability(access, "budget.manage") || commitment.status !== "active") {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Amend a booking</h1>
        <p className="text-body-md text-ink-muted">
          {commitment.status !== "active"
            ? "This version has already been replaced. Open the current booking to amend it."
            : "Only the workspace owner or partner can amend a booking."}
        </p>
        <Link href={back} className={link}>
          Back to the booking
        </Link>
      </div>
    );
  }

  const v = viewCommitment(ledger, commitment, todayInZone(settings.timezone));
  const costs = freeCosts(budget.items, budget.categories, ledger, commitment.id);
  const defaults: Record<string, string> = {
    title: commitment.title,
    amount: minorToMajorInput(commitment.amountMinor, cur),
    signedOn: commitment.signedOn ?? "",
  };
  v.allocations.forEach((a, n) => {
    defaults[`allocItem${n}`] = a.budgetItemId;
    defaults[`allocAmount${n}`] = minorToMajorInput(a.amountMinor, cur);
  });
  v.installments.forEach((i, n) => {
    defaults[`dueOn${n}`] = i.dueOn;
    defaults[`instAmount${n}`] = minorToMajorInput(i.amountMinor, cur);
    defaults[`instLabel${n}`] = i.label ?? "";
  });
  // Costs this booking already covers must stay selectable.
  const options = [
    ...costs,
    ...v.allocations
      .filter((a) => !costs.some((c) => c.id === a.budgetItemId))
      .map((a) => ({
        id: a.budgetItemId,
        label: budget.items.find((i) => i.id === a.budgetItemId)?.name ?? "A cost",
      })),
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          Amend {commitment.title}
        </h1>
        <p className="text-body-lg text-ink-muted">
          Currently {formatMinor(commitment.amountMinor, cur)}. Saving keeps the current version in
          the history and replaces it.{" "}
          {v.payments.some((p) => !p.voided) && "Your recorded payments move to the new version."}
        </p>
      </header>
      <BookingForm
        action={amendCommitment}
        workspaceId={wid}
        currency={cur}
        costs={options}
        defaults={defaults}
        hidden={{ commitmentId: commitment.id, version: commitment.version }}
        submitLabel="Save the amended booking"
        pendingLabel="Saving…"
        confirmLabel="I've signed or explicitly agreed to these changes."
      />
      <Link href={back} className={link}>
        Cancel and go back
      </Link>
    </div>
  );
}
