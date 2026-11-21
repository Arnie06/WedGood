import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { listTimeZones } from "@/domain/wedding/settings";
import { SettingsForm } from "@/features/workspace/settings-form";
import { requireSessionUser } from "@/server/auth/session";
import { createWorkspace } from "@/server/workspace/actions";

export const metadata: Metadata = {
  title: "Start your wedding workspace",
  robots: { index: false, follow: false },
};

export default async function OnboardingPage() {
  await requireSessionUser("/app/onboarding");
  return (
    <AuthFrame
      title="Let's start your wedding workspace"
      intro="Only the name is required. Everything else can wait until you're ready."
    >
      <SettingsForm
        action={createWorkspace}
        timeZones={listTimeZones()}
        detectTimeZone
        submitLabel="Create workspace"
        pendingLabel="Creating…"
        // One key per page load: a double click or retry can't create a second workspace.
        hidden={{ idempotencyKey: randomUUID() }}
        defaults={{
          name: "",
          date: "",
          timezone: "America/New_York",
          baseCurrency: "USD",
          targetBudget: "",
          targetGuestCount: "",
          location: "",
        }}
      />
      <p>
        <Link
          href="/app"
          className="font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to your workspaces
        </Link>
      </p>
    </AuthFrame>
  );
}
