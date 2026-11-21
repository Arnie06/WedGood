import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { TrayButton } from "@/components/ui/tray";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { VENDOR_CATEGORIES } from "@/domain/candidates/categories";
import { filterCandidates, parseFilters } from "@/domain/candidates/filter";
import { MOVABLE_STAGES, PIPELINE_STAGES, isPipelineStage } from "@/domain/proposals/stages";
import { parseMajorToMinor } from "@/domain/wedding/settings";
import { CandidateCard } from "@/features/discover/candidate-card";
import { CandidateForm } from "@/features/discover/candidate-form";
import { createCandidate } from "@/server/candidates/actions";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidates } from "@/server/candidates/queries";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Venues & vendors" };

const EMPTY_CANDIDATE = {
  name: "",
  category: "",
  sourceUrl: "",
  sourceCheckedOn: "",
  location: "",
  pricingDisplay: "",
  price: "",
  priceBasis: "",
  notes: "",
  seatedCapacity: "",
  ceremonyCapacity: "",
};

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const checkbox = "flex min-h-11 items-center gap-3 text-body-md";

export default async function DiscoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canManage = hasCapability(access, "vendors.manage");
  const [settings, all, query] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadCandidates(access.wedding.id),
    searchParams,
  ]);
  const currency = settings.baseCurrency;
  const { filters, errors } = parseFilters(query, currency, parseMajorToMinor);
  const stageParam = typeof query.stage === "string" ? query.stage : "";
  const stage = isPipelineStage(stageParam) ? stageParam : "all";
  const inStage = stage === "all" ? all : all.filter((c) => c.stage === stage);
  const { matches, hiddenUnknown } = filterCandidates(inStage, filters, currency);
  const filtered =
    filters.q !== "" ||
    filters.category !== "all" ||
    filters.minSeated !== null ||
    filters.maxPriceMinor !== null ||
    filters.favoritesOnly ||
    stage !== "all";
  const numeric = filters.minSeated !== null || filters.maxPriceMinor !== null;
  const showMore =
    numeric ||
    stage !== "all" ||
    filters.category !== "all" ||
    filters.favoritesOnly ||
    filters.includeUnknown;

  // Keep every active filter when offering to include unknowns.
  const withUnknown = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined && k !== "unknown") withUnknown.set(k, value);
  }
  withUnknown.set("unknown", "1");

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Venues &amp; vendors
        </h1>
        <p className="text-body-lg text-ink-muted">
          Save the places and people you&apos;re considering, with where you found them. This is
          your own list: nothing here is checked, confirmed available or booked.
        </p>
      </header>

      {canManage && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <TrayButton
            label="Add a venue"
            title="Add a venue"
            description="Only the name is required. Anything you leave blank stays unknown."
            openOnParam="addVenue"
          >
            <CandidateForm
              action={createCandidate}
              kind="venue"
              currency={currency}
              defaults={EMPTY_CANDIDATE}
              lookupWorkspaceId={access.wedding.id}
              hidden={{ workspaceId: access.wedding.id, idempotencyKey: randomUUID() }}
              submitLabel="Save"
              pendingLabel="Saving…"
            />
          </TrayButton>
          <TrayButton
            label="Add a vendor"
            variant="outline"
            title="Add a vendor"
            description="Only the name and what they do are required."
            openOnParam="addVendor"
          >
            <CandidateForm
              action={createCandidate}
              kind="vendor"
              currency={currency}
              defaults={EMPTY_CANDIDATE}
              lookupWorkspaceId={access.wedding.id}
              hidden={{ workspaceId: access.wedding.id, idempotencyKey: randomUUID() }}
              submitLabel="Save"
              pendingLabel="Saving…"
            />
          </TrayButton>
        </div>
      )}
      <p>
        <Link href={`${base}/discover/compare`} className={link}>
          Compare quotes
        </Link>
      </p>

      {all.length > 0 && (
        <form
          method="get"
          className="space-y-4"
          role="search"
          aria-label="Filter saved venues and vendors"
        >
          <TextField
            label="Search"
            name="q"
            type="search"
            autoComplete="off"
            placeholder="Name, place or note"
            defaultValue={filters.q}
          />
          <details open={showMore} className="space-y-4">
            <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold">
              More filters
            </summary>
            <div className="mt-3 space-y-4">
              <SelectField label="Type" name="category" defaultValue={filters.category}>
                <option value="all">Everything</option>
                <option value="venue">Venues</option>
                {VENDOR_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Progress" name="stage" defaultValue={stage}>
                <option value="all">Any stage</option>
                {PIPELINE_STAGES.filter((s) => MOVABLE_STAGES.includes(s.value)).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </SelectField>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Seats at least"
                  hint="Venues only."
                  name="seated"
                  inputMode="numeric"
                  autoComplete="off"
                  defaultValue={filters.minSeated?.toString() ?? ""}
                  error={errors.minSeated}
                />
                <TextField
                  label={`Costs at most (${currency})`}
                  hint="Compares prices quoted for the whole event."
                  name="price"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={typeof query.price === "string" ? query.price : ""}
                  error={errors.maxPrice}
                />
              </div>
              <label className={checkbox}>
                <input
                  type="checkbox"
                  name="favorites"
                  value="1"
                  defaultChecked={filters.favoritesOnly}
                  className="size-5"
                />
                Favorites only
              </label>
              <label className={checkbox}>
                <input
                  type="checkbox"
                  name="unknown"
                  value="1"
                  defaultChecked={filters.includeUnknown}
                  className="size-5"
                />
                Also show ones where the price or capacity isn&apos;t known
              </label>
            </div>
          </details>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button type="submit" className={buttonClasses({ variant: "secondary" })}>
              Apply filters
            </button>
            {filtered && (
              <a href={`${base}/discover`} className={link}>
                Clear filters
              </a>
            )}
          </div>
        </form>
      )}

      {all.length === 0 ? (
        <Card>
          <CardTitle>Save a venue or vendor you love</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">
            Add a link or enter the details yourself. We don&apos;t list or rate businesses, so
            everything here comes from you.
          </p>
          {!canManage && (
            <p className="mt-3 text-body-md text-ink-muted">
              You can view this list. Ask the workspace owner to add venues and vendors.
            </p>
          )}
        </Card>
      ) : (
        <section aria-labelledby="results-heading" className="space-y-3">
          <h2 id="results-heading" className="font-serif text-headline-sm">
            {filtered ? "Matching" : "Saved"}{" "}
            <span className="text-body-md text-ink-muted" data-testid="result-count">
              ({matches.length})
            </span>
          </h2>
          <div aria-live="polite">
            {hiddenUnknown > 0 && (
              <p className="text-body-md text-ink-muted">
                {hiddenUnknown} more {hiddenUnknown === 1 ? "has" : "have"} no price or capacity to
                compare yet, so {hiddenUnknown === 1 ? "it isn't" : "they aren't"} shown.{" "}
                <a href={`${base}/discover?${withUnknown.toString()}`} className={link}>
                  Show {hiddenUnknown === 1 ? "it" : "them"} anyway
                </a>
              </p>
            )}
          </div>
          {matches.length === 0 ? (
            <Card>
              <p className="text-body-md">Nothing matches those filters.</p>
              <p className="mt-2">
                <a href={`${base}/discover`} className={link}>
                  Clear filters
                </a>
              </p>
            </Card>
          ) : (
            <ul className="space-y-3">
              {matches.map((c) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  workspaceId={access.wedding.id}
                  base={base}
                  currency={currency}
                  canManage={canManage}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
