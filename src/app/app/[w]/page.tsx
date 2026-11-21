import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { daysBetween, formatDateOnly, parseDateOnly, todayInZone } from "@/domain/dates/date-only";
import { formatMinor } from "@/domain/money/money";
import { previewReschedule } from "@/domain/tasks/schedule";
import { nextSteps, progress } from "@/domain/tasks/summary";
import { dueLabel } from "@/features/plan/format";
import { toScheduled, toSummary } from "@/features/plan/mappers";
import { loadTasks } from "@/server/plan/queries";
import { ProgressBar } from "@/components/ui/progress-bar";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";

const linkClass = "font-semibold text-action-emphasis underline underline-offset-4";

function countdown(days: number): string {
  if (days === 0) return "That's today";
  if (days === 1) return "1 day to go";
  if (days > 1) return `${days} days to go`;
  return days === -1 ? "1 day ago" : `${-days} days ago`;
}

export default async function WorkspaceHomePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const [s, tasks] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadTasks(access.wedding.id),
  ]);
  const base = `/app/${access.wedding.id}`;

  const date = s.date ? parseDateOnly(s.date) : null;
  const days = date ? daysBetween(todayInZone(s.timezone), date) : null;

  const today = todayInZone(s.timezone);
  const summaries = tasks.map(toSummary);
  const steps = nextSteps(summaries, today, 3);
  const { done, total } = progress(summaries);
  const drift = previewReschedule(s.date, tasks.map(toScheduled)).moves.length;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const canEditPlan = hasCapability(access, "plan.edit");

  // Missing facts become gentle prompts, never defaults.
  const prompts: { text: string; href: string; label: string }[] = [];
  const canEditSettings = hasCapability(access, "settings.edit");
  if (canEditSettings) {
    const settingsHref = `${base}/settings/event`;
    if (!s.date)
      prompts.push({
        text: "Pick a date to give your checklist deadlines.",
        href: settingsHref,
        label: "Add your date",
      });
    if (s.targetBudgetMinor === null)
      prompts.push({
        text: "A budget target is optional, and useful once you start comparing.",
        href: settingsHref,
        label: "Set a budget target",
      });
    if (s.targetGuestCount === null)
      prompts.push({
        text: "A rough guest count helps with venue and catering estimates.",
        href: settingsHref,
        label: "Set a guest target",
      });
  }

  const facts: { label: string; value: string; note?: string }[] = [
    date
      ? { label: "Date", value: formatDateOnly(date), note: countdown(days ?? 0) }
      : { label: "Date", value: "Not set yet", note: "Still deciding is fine." },
    {
      label: "Budget target",
      value:
        s.targetBudgetMinor === null
          ? "Not set yet"
          : formatMinor(s.targetBudgetMinor, s.baseCurrency),
    },
    {
      label: "Guest target",
      value: s.targetGuestCount === null ? "Not set yet" : String(s.targetGuestCount),
    },
    { label: "Location", value: s.location ?? "Not set yet" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-headline-mobile md:text-headline-lg">{s.name}</h1>
      <Card>
        <CardTitle>Event details</CardTitle>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-label-lg text-ink-muted">{f.label}</dt>
              <dd className="text-body-lg">{f.value}</dd>
              {f.note && <dd className="text-body-sm text-ink-muted">{f.note}</dd>}
            </div>
          ))}
        </dl>
        <p className="mt-4">
          <Link href={`${base}/settings/event`} className={linkClass}>
            {hasCapability(access, "settings.edit") ? "Edit event details" : "View event details"}
          </Link>
        </p>
      </Card>
      {drift > 0 && (
        <Card className="border-border-control">
          <CardTitle>Your wedding date changed</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">
            {drift} checklist {drift === 1 ? "date doesn't" : "dates don't"} match it yet. Nothing
            moves until you review.
          </p>
          <p className="mt-3">
            <Link href={`${base}/plan/review-dates`} className={linkClass}>
              Review the new dates
            </Link>
          </p>
        </Card>
      )}
      <Card>
        <CardTitle>Next steps</CardTitle>
        {total === 0 ? (
          <div className="mt-2 space-y-3">
            <p className="text-body-md text-ink-muted">
              {canEditPlan
                ? "Start with a suggested checklist, or add your own first task."
                : "No tasks yet. The owner can start the checklist."}
            </p>
            <p>
              <Link href={`${base}/plan`} className={linkClass}>
                {canEditPlan ? "Start your checklist" : "Open the checklist"}
              </Link>
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <ProgressBar
              label="Checklist"
              value={done}
              max={total}
              valueText={`${done} of ${total} done`}
            />
            {steps.length === 0 ? (
              <p className="text-body-md text-ink-muted">Everything on your checklist is done.</p>
            ) : (
              <ol className="space-y-3">
                {steps.map((step) => (
                  <li key={step.id}>
                    <p className="text-body-lg">{step.title}</p>
                    <p className="text-body-sm text-ink-muted">
                      {dueLabel(byId.get(step.id)?.dueDate ?? null, today)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <p>
              <Link href={`${base}/plan`} className={linkClass}>
                See the full checklist
              </Link>
            </p>
          </div>
        )}
      </Card>
      {prompts.length > 0 && (
        <Card>
          <CardTitle>Still to decide</CardTitle>
          <ul className="mt-3 space-y-3">
            {prompts.map((p) => (
              <li key={p.label}>
                <p className="text-body-md text-ink-muted">{p.text}</p>
                <Link href={p.href} className={linkClass}>
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardTitle>People</CardTitle>
        <p className="mt-2 text-body-md text-ink-muted">
          Budget, vendors and guests arrive in the coming releases.
        </p>
        <p className="mt-4">
          <Link href={`${base}/settings/members`} className={linkClass}>
            {hasCapability(access, "members.manage")
              ? "Manage people and invitations"
              : "See who has access"}
          </Link>
        </p>
        <p className="mt-2">
          <Link href={`${base}/shared`} className={linkClass}>
            Shared choices and comments
          </Link>
        </p>
      </Card>
    </div>
  );
}
