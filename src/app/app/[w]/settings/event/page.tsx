import type { Metadata } from "next";
import Link from "next/link";
import { listTimeZones, minorToMajorInput } from "@/domain/wedding/settings";
import { SettingsForm } from "@/features/workspace/settings-form";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";
import { updateWorkspaceSettings } from "@/server/workspace/actions";

export const metadata: Metadata = { title: "Event details" };

export default async function EventSettingsPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const s = await loadWeddingSettings(access.wedding.id);
  const zones = listTimeZones();
  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Event details</h1>
        <p className="text-body-lg text-ink-muted">
          The date, budget and guest targets here feed the rest of your plan. Leave anything blank
          until you know it.
        </p>
      </div>
      <SettingsForm
        action={updateWorkspaceSettings}
        timeZones={zones.includes(s.timezone) ? zones : [...zones, s.timezone]}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        readOnly={!hasCapability(access, "settings.edit")}
        hidden={{ workspaceId: s.id, version: String(s.version) }}
        defaults={{
          name: s.name,
          date: s.date ?? "",
          timezone: s.timezone,
          baseCurrency: s.baseCurrency,
          targetBudget: minorToMajorInput(s.targetBudgetMinor, s.baseCurrency),
          targetGuestCount: s.targetGuestCount === null ? "" : String(s.targetGuestCount),
          location: s.location ?? "",
        }}
      />
      <p>
        <Link
          href={`/app/${access.wedding.id}`}
          className="font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to home
        </Link>
      </p>
    </div>
  );
}
