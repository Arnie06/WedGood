import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CandidateForm } from "@/features/discover/candidate-form";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { createCandidate } from "@/server/candidates/actions";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Add to your list" };

const EMPTY = {
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

export default async function NewCandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const access = await requireWorkspace((await params).w);
  const { kind: kindParam } = await searchParams;
  const kind = kindParam === "vendor" ? "vendor" : "venue";
  const base = `/app/${access.wedding.id}`;
  if (!hasCapability(access, "vendors.manage")) notFound();
  const settings = await loadWeddingSettings(access.wedding.id);

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          {kind === "venue" ? "Add a venue" : "Add a vendor"}
        </h1>
        <p className="text-body-md text-ink-muted">
          Only the name is required. Anything you leave blank stays unknown.{" "}
          {kind === "venue" ? (
            <Link
              href={`${base}/discover/new?kind=vendor`}
              className="font-semibold text-action-emphasis underline underline-offset-4"
            >
              Adding a vendor instead?
            </Link>
          ) : (
            <Link
              href={`${base}/discover/new?kind=venue`}
              className="font-semibold text-action-emphasis underline underline-offset-4"
            >
              Adding a venue instead?
            </Link>
          )}
        </p>
      </div>
      <CandidateForm
        key={kind}
        action={createCandidate}
        kind={kind}
        currency={settings.baseCurrency}
        submitLabel="Save"
        pendingLabel="Saving…"
        defaults={EMPTY}
        hidden={{ workspaceId: access.wedding.id, idempotencyKey: randomUUID() }}
      />
      <p>
        <Link
          href={`${base}/discover`}
          className="font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to your list
        </Link>
      </p>
    </div>
  );
}
