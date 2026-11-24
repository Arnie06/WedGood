import type { Metadata } from "next";
import Link from "next/link";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { DensityToggle } from "@/components/ui/density-toggle";
import { TrayButton } from "@/components/ui/tray";
import { newItemDefaults, reservePercentText } from "@/domain/budget/input";
import { formatMinor } from "@/domain/money/money";
import { minorToMajorInput } from "@/domain/wedding/settings";
import {
  ArchiveCategoryForm,
  ArchiveItemForm,
  CategoryForm,
  ItemForm,
  ReserveForm,
  SuggestedCategoriesForm,
} from "@/features/budget/budget-forms";
import {
  itemAmountLabel,
  itemBasisLabel,
  itemDriftNote,
  itemTrackingNote,
  type CountContext,
} from "@/features/budget/format";
import { createCategory, createItem, updateCategory, updateItem } from "@/server/budget/actions";
import { loadBudgetInputs, summarizeBudgetInputs } from "@/server/budget/view";
import { loadEventLabels } from "@/server/timeline/queries";
import { loadDriftRows } from "@/server/events/guarantee";
import { DriftNote } from "@/features/events/drift-note";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { readDensity } from "@/server/display/density";
import { PossibleCostsCard } from "@/features/budget/possible-costs-card";
import { lodgingEnabled } from "@/server/lodging/flag";
import { loadPossibleCosts } from "@/server/lodging/queries";

export const metadata: Metadata = { title: "Budget" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function BudgetPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canEdit = hasCapability(access, "budget.manage");
  const density = await readDensity(access.wedding.id, access.membership.role);
  const [settings, inputs, events, possibleCosts] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadBudgetInputs(access.wedding.id),
    loadEventLabels(access.wedding.id),
    lodgingEnabled() ? loadPossibleCosts(access.wedding.id) : Promise.resolve([]),
  ]);
  const { budget, ledger } = inputs;
  // Locked caterer counts against replies. Only for members who may read guest totals (ADR-031 D2).
  const drift = await loadDriftRows(access.wedding.id, {
    canManageGuests: hasCapability(access, "guests.manage"),
    shareGuestTotals: access.wedding.shareGuestTotals,
  });
  const cur = settings.baseCurrency;
  const money = (n: number) => formatMinor(n, cur);
  const guests = settings.targetGuestCount;
  const s = summarizeBudgetInputs(inputs, settings);
  // Reply counts follow ADR-031 D2: the number and its arithmetic are for owner and partner, or for
  // everyone once the owner shares guest totals. The forecast itself follows replies for all.
  const countCtx: CountContext = {
    guestTarget: guests,
    currency: cur,
    eventNames: new Map(events.map((e) => [e.id, e.name])),
    showCounts: hasCapability(access, "guests.manage") || access.wedding.shareGuestTotals,
  };
  const figures = new Map(s.items.map((f) => [f.itemId, f]));
  // Plan against replies across reply-based costs, for those who may see counts. Prices as entered.
  const tracked = s.items.filter((f) => f.planMinor !== null && f.actualMinor !== null);
  const trackPlan = tracked.reduce((n, f) => n + (f.planMinor ?? 0), 0);
  const trackActual = tracked.reduce((n, f) => n + (f.actualMinor ?? 0), 0);
  const usesTarget = budget.items.some(
    (i) => i.costMode === "per_guest" && (i.countSource ?? "guest_target") === "guest_target",
  );
  const bookedItems = new Set(
    ledger.allocations.filter((a) => a.active).map((a) => a.budgetItemId),
  );
  const hasBookings = ledger.commitments.some((c) => c.status === "active");
  const lowerBound = s.incomplete ? "At least " : "";
  const hasPlan = budget.categories.length > 0;
  // An empty budget leads with setup; the summary appears once there is something to summarise.
  const showSummary =
    hasPlan ||
    hasBookings ||
    s.targetMinor !== null ||
    s.netPaidMinor > 0 ||
    budget.items.length > 0;
  const catOptions = budget.categories.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="space-y-6">
      <WorkspacePageHeading
        title="Budget"
        description={`Plan costs and track bookings and payments in ${cur}.`}
        actions={
          canEdit && (
            <>
              {hasPlan && (
                <TrayButton
                  label="Add a cost"
                  title="Add a cost"
                  description="What you expect to spend. Leave the amount blank if you don't know yet."
                >
                  <ItemForm
                    action={createItem}
                    rotateKey
                    workspaceId={access.wedding.id}
                    currency={cur}
                    categories={catOptions}
                    events={events}
                    defaults={newItemDefaults(events)}
                    submitLabel="Add cost"
                    pendingLabel="Adding…"
                  />
                </TrayButton>
              )}
              <TrayButton
                label="Add a category"
                variant={hasPlan ? "outline" : "primary"}
                title="Add a category"
                description="A group of costs, like Flowers. The target is guidance, not a limit."
              >
                <CategoryForm
                  action={createCategory}
                  rotateKey
                  workspaceId={access.wedding.id}
                  currency={cur}
                  defaults={{ name: "", allocation: "" }}
                  submitLabel="Add category"
                  pendingLabel="Adding…"
                />
              </TrayButton>
            </>
          )
        }
      />

      {drift.length > 0 && (
        <section aria-labelledby="caterer-counts" className="space-y-3" data-testid="budget-drift">
          <h2 id="caterer-counts" className="font-serif text-headline-sm">
            Caterer counts
          </h2>
          <Card className="space-y-2">
            <p className="text-body-md text-ink-muted">
              A locked count doesn&apos;t change when guests reply, so a cost booked from it stays
              as signed.
            </p>
            {drift.map((r) => (
              <DriftNote
                key={r.eventId}
                locked={r.locked}
                yes={r.yes}
                waiting={r.waiting}
                eventName={r.eventName}
                href={`${base}/plan/events/${r.eventId}#caterer-heading`}
                testId="budget-drift-note"
              />
            ))}
          </Card>
        </section>
      )}

      {showSummary && (
        <section aria-labelledby="summary" className="space-y-3">
          <h2 id="summary" className="font-serif text-headline-sm">
            Where you stand
          </h2>
          <div className="rounded-card border border-border-hairline bg-surface">
            <dl className="grid grid-cols-2 gap-px bg-border-hairline xl:grid-cols-4 [&>*]:min-w-0 [&>*]:bg-surface [&>*]:p-3 sm:[&>*]:p-4">
              <Figure
                label="Your target"
                value={s.targetMinor === null ? "Not set" : money(s.targetMinor)}
                note={
                  s.targetMinor === null ? (
                    <>
                      Set one in{" "}
                      <Link href={`${base}/settings/event`} className={link}>
                        event settings
                      </Link>{" "}
                      when you&apos;re ready.
                    </>
                  ) : undefined
                }
              />
              <Figure
                label="Forecast"
                value={`${lowerBound}${money(s.forecastMinor)}`}
                note={
                  s.incomplete
                    ? `${s.unknownItemCount} ${s.unknownItemCount === 1 ? "cost has" : "costs have"} no amount yet, so the real total is higher.`
                    : "Planned costs plus your reserve."
                }
              />
              <Figure
                label="Left against your target"
                value={
                  s.headroomMinor === null
                    ? "Needs a target"
                    : s.headroomMinor >= 0
                      ? `${s.incomplete ? "At most " : ""}${money(s.headroomMinor)}`
                      : `Over by ${s.incomplete ? "at least " : ""}${money(-s.headroomMinor)}`
                }
              />
              <Figure
                label="Committed and paid"
                value={`${money(s.committedMinor)} · ${money(s.netPaidMinor)}`}
                note={
                  hasBookings || s.netPaidMinor > 0 ? (
                    <>
                      {money(s.outstandingMinor)} still owed on bookings
                      {s.invoicedUnpaidMinor > 0 &&
                        `, ${money(s.invoicedUnpaidMinor)} of it invoiced and not yet paid`}
                      .{" "}
                      <Link href={`${base}/plan/budget/bookings`} className={link}>
                        Bookings and payments
                      </Link>
                    </>
                  ) : (
                    <>
                      Nothing booked or paid yet.{" "}
                      <Link href={`${base}/plan/budget/bookings`} className={link}>
                        Bookings and payments
                      </Link>
                      .
                    </>
                  )
                }
              />
            </dl>
            <details className="border-t border-border-hairline px-4 pb-1">
              <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                How the forecast is built
              </summary>
              <dl className="grid gap-x-6 gap-y-4 pt-2 sm:grid-cols-2">
                <Figure
                  label="Planned costs"
                  value={`${lowerBound}${money(s.subtotalMinor)}`}
                  note="Before the reserve."
                />
                <Figure
                  label="Reserve"
                  value={money(s.reserveMinor)}
                  note={
                    s.reserveBp === null
                      ? "None planned."
                      : `${reservePercentText(s.reserveBp)}% of planned costs. A plan, not money owed.`
                  }
                />
              </dl>
              {tracked.length > 0 && (
                <p className="pt-3 text-body-md" data-testid="plan-summary">
                  Guest-based costs, plan against replies so far: {money(trackPlan)} planned,{" "}
                  {money(trackActual)} at today&apos;s replies (
                  {trackActual === trackPlan
                    ? "on plan"
                    : `${money(Math.abs(trackActual - trackPlan))} ${trackActual > trackPlan ? "above" : "below"} plan`}
                  ).
                </p>
              )}
              {canEdit && (
                <div className="pt-2">
                  <TrayButton triggerStyle="link" label="Change the reserve" title="Reserve">
                    <ReserveForm
                      workspaceId={access.wedding.id}
                      version={budget.settingsVersion}
                      percent={reservePercentText(budget.reserveBp)}
                    />
                  </TrayButton>
                </div>
              )}
            </details>
          </div>
          {s.allocationExceedsTarget && (
            <p role="status" className="text-body-md text-ink">
              <Badge tone="pending">Check</Badge> Your category targets add up to{" "}
              {money(s.allocatedMinor)}, which is more than your target. That&apos;s allowed, but
              they can&apos;t all be met.
            </p>
          )}
          {guests === null && usesTarget && (
            <p role="status" className="text-body-md text-ink-muted">
              Per-guest costs need a guest count. Add one in{" "}
              <Link href={`${base}/settings/event`} className={link}>
                event settings
              </Link>
              .
            </p>
          )}
          {guests !== null && usesTarget && (
            <p className="text-body-sm text-ink-muted">
              Per-guest costs that count your guest target use {guests}.
            </p>
          )}
        </section>
      )}

      <PossibleCostsCard
        rows={possibleCosts}
        categories={new Map(budget.categories.map((c) => [c.id, c.name]))}
        currency={cur}
        lodgingHref={hasCapability(access, "guests.manage") ? `${base}/plan/lodging` : null}
      />

      {!hasPlan ? (
        <Card>
          <CardTitle>Start with some categories</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">
            Common wedding categories with no amounts. You choose what each one is for, and you can
            rename or remove them.
          </p>
          <div className="mt-4">
            {canEdit ? (
              <SuggestedCategoriesForm
                workspaceId={access.wedding.id}
                label="Add suggested categories"
              />
            ) : (
              <p className="text-body-md text-ink-muted">
                You can view the budget. Ask the workspace owner to set it up.
              </p>
            )}
          </div>
        </Card>
      ) : (
        <section aria-labelledby="cats" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id="cats" className="font-serif text-headline-sm">
              Categories
            </h2>
            <DensityToggle workspaceId={access.wedding.id} density={density} />
          </div>
          <ul className="record-list">
            {s.categories.map((row) => {
              const cat = budget.categories.find((c) => c.id === row.id)!;
              const items = budget.items.filter((i) => i.categoryId === row.id);
              return (
                <li key={row.id}>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-hairline bg-surface-sunken px-3 py-2 sm:px-4">
                    <div className="min-w-0 grow">
                      <h3 className="text-body-md font-semibold wrap-anywhere">{row.name}</h3>
                      <p className="text-body-sm text-ink-muted tabular-nums">
                        {row.allocationMinor === null
                          ? "No target"
                          : `Target ${money(row.allocationMinor)}`}
                        {" · "}
                        {row.unknownItemCount > 0 ? "At least " : ""}
                        {money(row.forecastMinor)} planned
                      </p>
                    </div>
                    {canEdit && (
                      <TrayButton
                        triggerStyle="link"
                        label="Edit category"
                        ariaLabel={`Edit category ${row.name}`}
                        title="Edit category"
                        description={row.name}
                      >
                        <CategoryForm
                          action={updateCategory}
                          workspaceId={access.wedding.id}
                          currency={cur}
                          extraHidden={{ categoryId: cat.id, version: cat.version }}
                          defaults={{
                            name: cat.name,
                            allocation:
                              cat.allocationMinor === null
                                ? ""
                                : minorToMajorInput(cat.allocationMinor, cur),
                          }}
                          submitLabel="Save category"
                          pendingLabel="Saving…"
                        />
                        <ArchiveCategoryForm
                          workspaceId={access.wedding.id}
                          categoryId={cat.id}
                          version={cat.version}
                          name={cat.name}
                        />
                      </TrayButton>
                    )}
                  </div>
                  {row.overAllocationMinor > 0 && (
                    <p
                      role="status"
                      className="border-b border-border-hairline px-3 py-2 text-body-sm sm:px-4"
                    >
                      <Badge tone="pending">Over</Badge> Planned costs are{" "}
                      {row.unknownItemCount > 0 ? "at least " : ""}
                      {money(row.overAllocationMinor)} above this category&apos;s target.
                    </p>
                  )}
                  {items.length === 0 ? (
                    <p className="px-3 py-3 text-body-sm text-ink-muted sm:px-4">
                      No costs in this category yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border-hairline">
                      {items.map((item) => {
                        const figure = figures.get(item.id)!;
                        const drift = itemDriftNote(item, figure, countCtx);
                        const tracking = itemTrackingNote(item, figure, countCtx);
                        return (
                          <li
                            key={item.id}
                            className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-2 sm:gap-x-5 sm:px-4 sm:py-3 compact:py-1 ${canEdit ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_5.5rem]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)]"}`}
                          >
                            <div className="col-span-full min-w-0 space-y-0.5 sm:col-span-1">
                              <p className="text-body-md font-semibold wrap-anywhere">
                                {item.name}
                              </p>
                              <p className="text-body-sm text-ink-muted">
                                {itemBasisLabel(item, figure, countCtx)}
                              </p>
                              {tracking && (
                                <p
                                  className="text-body-sm text-ink-muted"
                                  data-testid="plan-tracking"
                                >
                                  {tracking}
                                </p>
                              )}
                              {drift && <p className="text-body-sm text-ink-muted">{drift}</p>}
                            </div>
                            <p className="min-w-0 text-body-md font-semibold wrap-anywhere tabular-nums sm:text-right">
                              {bookedItems.has(item.id)
                                ? "Booked"
                                : itemAmountLabel(item, figure, cur)}
                            </p>
                            {canEdit && (
                              <TrayButton
                                triggerStyle="link"
                                label="Edit"
                                ariaLabel={`Edit ${item.name}`}
                                title="Edit cost"
                                className="justify-self-end"
                                description={item.name}
                              >
                                <ItemForm
                                  action={updateItem}
                                  workspaceId={access.wedding.id}
                                  currency={cur}
                                  categories={catOptions}
                                  events={events}
                                  idPrefix={`${item.id}-${item.version}`}
                                  extraHidden={{ itemId: item.id, version: item.version }}
                                  defaults={{
                                    name: item.name,
                                    category: item.categoryId,
                                    costMode: item.costMode,
                                    amount:
                                      item.amountMinor === null
                                        ? ""
                                        : minorToMajorInput(item.amountMinor, cur),
                                    quantity: item.quantity === null ? "" : String(item.quantity),
                                    minQty: item.minQty === null ? "" : String(item.minQty),
                                    notes: item.notes ?? "",
                                    countSource: item.countSource ?? "guest_target",
                                    countEvent: item.countEventId ?? "",
                                    countTyped:
                                      item.countTyped === null || item.countTyped === undefined
                                        ? ""
                                        : String(item.countTyped),
                                  }}
                                  submitLabel="Save changes"
                                  pendingLabel="Saving…"
                                />
                                <ArchiveItemForm
                                  workspaceId={access.wedding.id}
                                  itemId={item.id}
                                  version={item.version}
                                  name={item.name}
                                />
                              </TrayButton>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-label-lg text-ink-muted">{label}</dt>
      <dd className="font-serif text-headline-sm wrap-anywhere tabular-nums sm:text-headline-md">
        {value}
      </dd>
      {note && <dd className="text-body-sm text-ink-muted">{note}</dd>}
    </div>
  );
}
