import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { reservePercentText } from "@/domain/budget/input";
import { summarizeBudget } from "@/domain/budget/summary";
import { formatMinor } from "@/domain/money/money";
import { minorToMajorInput } from "@/domain/wedding/settings";
import {
  ArchiveCategoryForm,
  ArchiveItemForm,
  CategoryForm,
  EMPTY_ITEM,
  ItemForm,
  ReserveForm,
  SuggestedCategoriesForm,
} from "@/features/budget/budget-forms";
import { itemAmountLabel, itemBasisLabel } from "@/features/budget/format";
import { createCategory, createItem, updateCategory, updateItem } from "@/server/budget/actions";
import { loadBudget } from "@/server/budget/queries";
import { loadLedger } from "@/server/ledger/queries";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Budget" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function BudgetPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canEdit = hasCapability(access, "budget.manage");
  const [settings, budget, ledger] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadBudget(access.wedding.id),
    loadLedger(access.wedding.id),
  ]);
  const cur = settings.baseCurrency;
  const money = (n: number) => formatMinor(n, cur);
  const guests = settings.targetGuestCount;
  const s = summarizeBudget({
    targetMinor: settings.targetBudgetMinor,
    reserveBp: budget.reserveBp,
    guestCount: guests,
    categories: budget.categories,
    items: budget.items,
    commitments: ledger.commitments
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, amountMinor: c.amountMinor, status: c.status })),
    allocations: ledger.allocations
      .filter((a) => a.active)
      .map((a) => ({
        commitmentId: a.commitmentId,
        budgetItemId: a.budgetItemId,
        amountMinor: a.amountMinor,
      })),
    payments: ledger.payments
      .filter((p) => !p.voided)
      .map((p) => ({
        id: p.id,
        commitmentId: p.commitmentId,
        budgetItemId: p.budgetItemId,
        kind: p.kind,
        amountMinor: p.amountMinor,
      })),
  });
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
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Budget</h1>
        <p className="text-body-lg text-ink-muted">
          Your target, what you&apos;ve planned, and what you&apos;ve actually committed and paid,
          kept separate. Amounts are in {cur}.
        </p>
      </header>

      {showSummary && (
        <section aria-labelledby="summary" className="space-y-3">
          <h2 id="summary" className="font-serif text-headline-sm">
            Where you stand
          </h2>
          <Card>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
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
                note="Target minus forecast."
              />
              <Figure
                label="Committed and paid"
                value={`${money(s.committedMinor)} · ${money(s.netPaidMinor)}`}
                note={
                  hasBookings || s.netPaidMinor > 0 ? (
                    <>
                      {money(s.outstandingMinor)} still owed on bookings.{" "}
                      <Link href={`${base}/plan/budget/bookings`} className={link}>
                        Bookings and payments
                      </Link>
                    </>
                  ) : (
                    <>
                      Nothing booked or paid yet. Record a booking from a venue or vendor, or see{" "}
                      <Link href={`${base}/plan/budget/bookings`} className={link}>
                        bookings and payments
                      </Link>
                      .
                    </>
                  )
                }
              />
            </dl>
            <details className="mt-4 border-t border-border-hairline pt-2">
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
            </details>
          </Card>
          {s.allocationExceedsTarget && (
            <p role="status" className="text-body-md text-ink">
              <Badge tone="pending">Check</Badge> Your category targets add up to{" "}
              {money(s.allocatedMinor)}, which is more than your target. That&apos;s allowed, but
              they can&apos;t all be met.
            </p>
          )}
          {guests === null && budget.items.some((i) => i.costMode === "per_guest") && (
            <p role="status" className="text-body-md text-ink-muted">
              Per-guest costs need a guest count. Add one in{" "}
              <Link href={`${base}/settings/event`} className={link}>
                event settings
              </Link>
              .
            </p>
          )}
          {guests !== null && (
            <p className="text-body-sm text-ink-muted">
              Per-guest costs use your guest target of {guests}.
            </p>
          )}
        </section>
      )}

      {canEdit && showSummary && (
        <Card>
          <CardTitle>Reserve</CardTitle>
          <div className="mt-4">
            <ReserveForm
              workspaceId={access.wedding.id}
              version={budget.settingsVersion}
              percent={reservePercentText(budget.reserveBp)}
            />
          </div>
        </Card>
      )}

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
          <h2 id="cats" className="font-serif text-headline-sm">
            Categories
          </h2>
          <ul className="space-y-4">
            {s.categories.map((row) => {
              const cat = budget.categories.find((c) => c.id === row.id)!;
              const items = budget.items.filter((i) => i.categoryId === row.id);
              return (
                <Card as="li" key={row.id} className="space-y-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 className="font-serif text-headline-sm">{row.name}</h3>
                    <p className="text-body-md text-ink-muted">
                      {row.allocationMinor === null
                        ? "No target"
                        : `Target ${money(row.allocationMinor)}`}
                      {" · "}
                      {row.unknownItemCount > 0 ? "At least " : ""}
                      {money(row.forecastMinor)} planned
                    </p>
                  </div>
                  {row.overAllocationMinor > 0 && (
                    <p role="status" className="text-body-md">
                      <Badge tone="pending">Over</Badge> Planned costs are{" "}
                      {row.unknownItemCount > 0 ? "at least " : ""}
                      {money(row.overAllocationMinor)} above this category&apos;s target.
                    </p>
                  )}
                  {items.length === 0 ? (
                    <p className="text-body-md text-ink-muted">No costs in this category yet.</p>
                  ) : (
                    <ul className="divide-y divide-border-hairline">
                      {items.map((item) => (
                        <li key={item.id} className="space-y-2 py-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                            <p className="text-body-lg">{item.name}</p>
                            <p className="text-body-lg font-semibold">
                              {bookedItems.has(item.id)
                                ? "Booked"
                                : itemAmountLabel(item, guests, cur)}
                            </p>
                          </div>
                          <p className="text-body-sm text-ink-muted">
                            {itemBasisLabel(item, guests, cur)}
                          </p>
                          {canEdit && (
                            <details>
                              <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                                Edit {item.name}
                              </summary>
                              <div className="mt-3 space-y-4">
                                <ItemForm
                                  action={updateItem}
                                  workspaceId={access.wedding.id}
                                  currency={cur}
                                  categories={catOptions}
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
                              </div>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canEdit && (
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                        Edit {row.name} category
                      </summary>
                      <div className="mt-3 space-y-4">
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
                      </div>
                    </details>
                  )}
                </Card>
              );
            })}
          </ul>
        </section>
      )}

      {canEdit && hasPlan && (
        <Card>
          <CardTitle>Add a cost</CardTitle>
          <div className="mt-4">
            <ItemForm
              action={createItem}
              rotateKey
              workspaceId={access.wedding.id}
              currency={cur}
              categories={catOptions}
              defaults={EMPTY_ITEM}
              submitLabel="Add cost"
              pendingLabel="Adding…"
            />
          </div>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardTitle>Add a category</CardTitle>
          <div className="mt-4">
            <CategoryForm
              action={createCategory}
              rotateKey
              workspaceId={access.wedding.id}
              currency={cur}
              defaults={{ name: "", allocation: "" }}
              submitLabel="Add category"
              pendingLabel="Adding…"
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-label-lg text-ink-muted">{label}</dt>
      <dd className="text-headline-sm font-serif">{value}</dd>
      {note && <dd className="text-body-sm text-ink-muted">{note}</dd>}
    </div>
  );
}
