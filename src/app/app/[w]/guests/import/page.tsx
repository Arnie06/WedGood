import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { ImportWizard } from "@/features/guests/import-wizard";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";

export const metadata: Metadata = { title: "Import guests" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function ImportGuestsPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Import guests</h1>
        <Card>
          <p className="text-body-md">
            Importing guests is limited to the workspace owner and partner.
          </p>
        </Card>
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="text-body-md">
          <Link href={`${base}/guests`} className={`${link} inline-flex min-h-11 items-center`}>
            Back to the guest list
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Import guests</h1>
        <p className="text-body-lg text-ink-muted">
          Choose a CSV file, match its columns, and review every row before anything is saved.
          Spreadsheet formulas are treated as plain text.
        </p>
      </header>
      <ImportWizard workspaceId={wid} listHref={`${base}/guests`} />
    </div>
  );
}
