import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProposalForm } from "@/features/quotes/proposal-form";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidate } from "@/server/candidates/queries";
import { createProposal } from "@/server/proposals/actions";

export const metadata: Metadata = { title: "Add a quote" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function NewQuotePage({
  params,
}: {
  params: Promise<{ w: string; candidateId: string }>;
}) {
  const { w, candidateId } = await params;
  const access = await requireWorkspace(w);
  if (!UUID.test(candidateId) || !hasCapability(access, "vendors.manage")) notFound();
  const c = await loadCandidate(access.wedding.id, candidateId);
  if (!c) notFound();
  const base = `/app/${access.wedding.id}`;
  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          Add a quote from {c.name}
        </h1>
        <p className="text-body-md text-ink-muted">
          Start with the basics, then add each cost on the next page. A quote you enter here is only
          a record of what you were told. It doesn&apos;t book anything.
        </p>
      </div>
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
      <p>
        <Link href={`${base}/discover/${c.id}`} className={link}>
          Back to {c.name}
        </Link>
      </p>
    </div>
  );
}
