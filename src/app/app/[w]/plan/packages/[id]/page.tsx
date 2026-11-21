import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { presetDef, sectionDef } from "@/domain/packages/catalog";
import { PackageDocumentView } from "@/features/packages/package-document-view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadPackage, packageFreshness } from "@/server/packages/queries";

export const metadata: Metadata = { title: "Package" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PackagePage({
  params,
}: {
  params: Promise<{ w: string; id: string }>;
}) {
  const { w, id } = await params;
  const access = await requireWorkspace(w);
  if (!hasCapability(access, "exports.create") || !UUID.test(id)) notFound();
  const pkg = await loadPackage(access.wedding.id, id);
  if (!pkg) notFound();
  const base = `/app/${access.wedding.id}`;
  const state = (await packageFreshness(access.wedding.id, [pkg])).get(pkg.id) ?? "unknown";
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(pkg.generatedAt));

  const redo = new URLSearchParams({
    preset: pkg.preset,
    customized: "1",
    preview: "1",
    title: pkg.title,
    recipient: pkg.recipient,
    paper: pkg.paper,
    orientation: pkg.orientation,
  });
  pkg.sections.forEach((s) => redo.append("sections", s));
  pkg.formats.forEach((f) => redo.append("formats", f));
  if (pkg.options.includeContacts) redo.set("includeContacts", "on");
  if (pkg.options.includeNotes) redo.set("includeNotes", "on");

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="text-body-md">
          <Link href={`${base}/plan/packages`} className={link}>
            All packages
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{pkg.title}</h1>
        <p className="text-body-lg text-ink-muted">
          {presetDef(pkg.preset).label}
          {pkg.recipient ? ` · prepared for ${pkg.recipient}` : ""}
        </p>
      </header>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Snapshot</CardTitle>
          {state === "current" ? (
            <Badge tone="confirmed">Matches your plan</Badge>
          ) : state === "stale" ? (
            <Badge tone="pending">Plan has changed</Badge>
          ) : (
            <Badge>Not checked</Badge>
          )}
        </div>
        <p role="status" className="text-body-md">
          {state === "current"
            ? "Your plan still matches this package."
            : state === "stale"
              ? "Something in these sections has changed since this was made. The files below are unchanged and show the plan as it was."
              : "We couldn't compare this with your current plan right now."}
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-body-md sm:grid-cols-[12rem_1fr]">
          <dt className="font-semibold text-ink-muted">Generated</dt>
          <dd>{when} UTC</dd>
          <dt className="font-semibold text-ink-muted">Plan revision</dt>
          <dd>{pkg.revision}</dd>
          <dt className="font-semibold text-ink-muted">Sections</dt>
          <dd>{pkg.sections.map((s) => sectionDef(s).label).join(", ")}</dd>
          <dt className="font-semibold text-ink-muted">Private details</dt>
          <dd>
            Contacts {pkg.options.includeContacts ? "included" : "not included"}; notes{" "}
            {pkg.options.includeNotes ? "included" : "not included"}
          </dd>
          <dt className="font-semibold text-ink-muted">Reference</dt>
          <dd className="break-all">{pkg.digest.slice(0, 16)}</dd>
        </dl>
        <p className="flex flex-wrap gap-3">
          {pkg.artifacts.map((a) => (
            <ButtonLink
              key={a.format}
              href={`${base}/plan/packages/${pkg.id}/download?format=${a.format}`}
              variant={a.format === "pdf" ? "primary" : "outline"}
              prefetch={false}
            >
              Download {a.format.toUpperCase()} ({Math.max(1, Math.round(a.bytes / 1024))} KB)
            </ButtonLink>
          ))}
        </p>
        <p className="text-body-sm text-ink-muted">
          A downloaded file can&apos;t be taken back once you share it.
        </p>
        {state === "stale" && (
          <p>
            <Link href={`${base}/plan/packages/new?${redo.toString()}`} className={link}>
              Preview an updated version
            </Link>
          </p>
        )}
      </Card>

      <section aria-labelledby="contents" className="space-y-4">
        <h2 id="contents" className="font-serif text-headline-sm">
          What it contains
        </h2>
        {pkg.document ? (
          <div className="rounded-card border border-border-hairline bg-surface p-4 sm:p-6">
            <PackageDocumentView doc={pkg.document} />
          </div>
        ) : (
          <Card>
            <p className="text-body-md">
              This snapshot can&apos;t be displayed. The files are unaffected.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
