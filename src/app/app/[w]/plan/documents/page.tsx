import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import {
  ALLOWED_MIME_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  formatBytes,
  isDocumentKind,
  parseLinkTarget,
} from "@/domain/documents/validate";
import { formatMinor } from "@/domain/money/money";
import {
  ArchiveDocumentForm,
  AttachDocumentForm,
  DetachButton,
  EditDocumentForm,
  UploadForm,
  type LinkOption,
} from "@/features/documents/document-forms";
import { linksFor, type TargetLabels } from "@/features/documents/view";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadCandidates } from "@/server/candidates/queries";
import { loadDocuments } from "@/server/documents/queries";
import { loadLedger } from "@/server/ledger/queries";
import { createAdminClient, unscannedDownloadsAllowed } from "@/server/supabase/admin";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Documents" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<{ kind?: string; link?: string }>;
}) {
  const { w } = await params;
  const query = await searchParams;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;

  if (!hasCapability(access, "budget.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Documents</h1>
        <Card>
          <p className="text-body-md">
            Contracts and receipts are private to the workspace owner and partner. Ask them if you
            need something shared with you.
          </p>
        </Card>
      </div>
    );
  }

  const [data, ledger, candidates, settings] = await Promise.all([
    loadDocuments(wid),
    loadLedger(wid),
    loadCandidates(wid),
    loadWeddingSettings(wid),
  ]);
  const money = (n: number) => formatMinor(n, settings.baseCurrency);
  const bookingTitle = new Map(ledger.commitments.map((c) => [c.id, c.title]));

  const options: LinkOption[] = [
    ...ledger.commitments
      .filter((c) => c.status === "active")
      .map((c) => ({ value: `commitment:${c.id}`, label: c.title, group: "Bookings" })),
    ...ledger.payments
      .filter((p) => !p.voided)
      .map((p) => ({
        value: `payment:${p.id}`,
        label: `${p.kind === "refund" ? "Refund" : "Payment"} of ${money(p.amountMinor)} on ${p.paidOn}${
          p.commitmentId ? ` (${bookingTitle.get(p.commitmentId) ?? "booking"})` : ""
        }`,
        group: "Payments and refunds",
      })),
    ...candidates.map((c) => ({
      value: `candidate:${c.id}`,
      label: c.name,
      group: "Venues and vendors",
    })),
  ];
  const labels: TargetLabels = new Map(
    options.map((o) => [o.value, o.group === "Bookings" ? `Booking: ${o.label}` : o.label]),
  );

  const kindFilter = isDocumentKind(query.kind) ? query.kind : null;
  const defaultLink = parseLinkTarget(query.link ?? "") ? (query.link ?? "") : "";
  const visible = data.documents.filter(
    (d) => !d.archived && (!kindFilter || d.kind === kindFilter),
  );
  const archivedCount = data.documents.filter((d) => d.archived).length;
  const canStore = createAdminClient() !== null;
  const canDownload = unscannedDownloadsAllowed();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Documents</h1>
        <p className="text-body-lg text-ink-muted">
          Keep contracts, quotes and receipts private, and attach them to the booking, payment or
          vendor they belong to.
        </p>
        <p className="text-body-md">
          <Link href={`${base}/plan/budget/bookings`} className={link}>
            Bookings and payments
          </Link>
        </p>
      </header>

      <Card>
        <p role="status" className="text-body-md">
          <Badge tone="pending">Not virus-scanned</Badge> Files are checked for type, size and
          obvious active content, but no malware scanner is set up yet.{" "}
          {canDownload
            ? "Downloads are enabled on this server for local use. Open files only if you trust where they came from."
            : "Downloads stay off until a scanner is configured."}
        </p>
      </Card>

      <section aria-labelledby="upload" className="space-y-3">
        <h2 id="upload" className="font-serif text-headline-sm">
          Add a document
        </h2>
        {canStore ? (
          <Card>
            <UploadForm
              workspaceId={wid}
              options={options}
              defaultLink={defaultLink}
              accept={ALLOWED_MIME_TYPES.join(",")}
            />
          </Card>
        ) : (
          <Card>
            <p role="status" className="text-body-md">
              <Badge tone="neutral">Not available yet</Badge> Private file storage isn&apos;t set up
              on this server, so uploads are turned off. Nothing is saved.
            </p>
          </Card>
        )}
      </section>

      <section aria-labelledby="list" className="space-y-3">
        <h2 id="list" className="font-serif text-headline-sm">
          Your documents
        </h2>
        <nav aria-label="Filter by kind" className="flex flex-wrap gap-2">
          {[null, ...DOCUMENT_KINDS].map((k) => (
            <Link
              key={k ?? "all"}
              href={k ? `${base}/plan/documents?kind=${k}` : `${base}/plan/documents`}
              aria-current={k === kindFilter ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-control border px-4 text-label-lg font-semibold ${
                k === kindFilter
                  ? "border-action-emphasis bg-action-emphasis text-on-action-emphasis"
                  : "border-border-control text-ink"
              }`}
            >
              {k ? DOCUMENT_KIND_LABELS[k] : "All"}
            </Link>
          ))}
        </nav>
        {visible.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              {data.documents.length === 0
                ? "No documents yet. Add your first contract or receipt above."
                : "No documents match this filter."}
            </p>
          </Card>
        ) : (
          <ul className="record-list">
            {visible.map((d) => {
              const attached = linksFor(d.id, data.links, labels);
              const attachedKeys = new Set(attached.map((a) => a.key));
              return (
                <li key={d.id} className="space-y-2 px-4 py-3">
                  <div className="space-y-1">
                    <CardTitle as="h3" className="wrap-anywhere">
                      {d.title}
                    </CardTitle>
                    <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
                      <Badge tone="neutral">{DOCUMENT_KIND_LABELS[d.kind]}</Badge>
                      <Badge tone="pending">Not virus-scanned</Badge>
                      <span>
                        {formatBytes(d.bytes)} · added {dateFmt.format(new Date(d.createdAt))}
                      </span>
                    </p>
                  </div>
                  <div>
                    {canDownload ? (
                      <a
                        href={`${base}/plan/documents/${d.id}/download`}
                        className={`${link} inline-flex min-h-11 items-center`}
                      >
                        Download {d.title}
                      </a>
                    ) : (
                      <p className="text-body-sm text-ink-muted">
                        Download is off until a malware scanner is configured.
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-label-lg font-semibold">Attached to</h3>
                    {attached.length === 0 ? (
                      <p className="text-body-sm text-ink-muted">Nothing yet.</p>
                    ) : (
                      <ul className="divide-y divide-border-hairline">
                        {attached.map((a) => (
                          <li
                            key={a.key}
                            className="flex flex-wrap items-center justify-between gap-2 py-1"
                          >
                            <span className="break-words">{a.label}</span>
                            <DetachButton
                              workspaceId={wid}
                              documentId={d.id}
                              link={a.key}
                              label={a.label}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <details className="group">
                    <summary className="min-h-11 cursor-pointer py-2 text-label-lg font-semibold text-action-emphasis">
                      Attach, rename or archive
                    </summary>
                    <div className="space-y-6 pt-3">
                      <AttachDocumentForm
                        workspaceId={wid}
                        documentId={d.id}
                        options={options.filter((o) => !attachedKeys.has(o.value))}
                      />
                      <EditDocumentForm
                        workspaceId={wid}
                        documentId={d.id}
                        version={d.version}
                        title={d.title}
                        kind={d.kind}
                      />
                      <ArchiveDocumentForm
                        workspaceId={wid}
                        documentId={d.id}
                        version={d.version}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {archivedCount > 0 && (
          <p className="text-body-sm text-ink-muted">
            {archivedCount} archived {archivedCount === 1 ? "document is" : "documents are"} kept
            but hidden.
          </p>
        )}
      </section>
    </div>
  );
}
