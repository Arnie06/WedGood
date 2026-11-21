import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { previewReschedule } from "@/domain/tasks/schedule";
import { shortDate } from "@/features/plan/format";
import { toScheduled } from "@/features/plan/mappers";
import { ApplyRescheduleForm } from "@/features/plan/plan-actions";
import { loadTasks } from "@/server/plan/queries";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadWeddingSettings } from "@/server/workspace/queries";

export const metadata: Metadata = { title: "Review checklist dates" };

export default async function ReviewDatesPage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const canEdit = hasCapability(access, "plan.edit");
  const [settings, tasks] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadTasks(access.wedding.id),
  ]);
  const { moves, unchanged } = previewReschedule(settings.date, tasks.map(toScheduled));

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">
          Review checklist dates
        </h1>
        <p className="text-body-lg text-ink-muted">
          {settings.date
            ? `Flexible tasks follow your wedding date, ${shortDate(settings.date)}.`
            : "Your wedding date isn't set, so flexible tasks would become undated."}{" "}
          Nothing changes until you confirm.
        </p>
      </header>

      {moves.length === 0 ? (
        <Card>
          <CardTitle>Everything is up to date</CardTitle>
          <p className="mt-2 text-body-md text-ink-muted">No flexible task needs a new date.</p>
        </Card>
      ) : (
        <>
          <ul className="space-y-3" aria-label="Proposed date changes">
            {moves.map((m) => (
              <Card as="li" key={m.task.id} className="space-y-1 p-4 sm:p-4">
                <p className="text-body-lg">{m.task.title}</p>
                <p className="text-body-sm text-ink-muted">
                  {m.from ? shortDate(m.from) : "No date"} <span aria-hidden="true">→</span>
                  <span className="sr-only"> changes to </span>{" "}
                  <strong className="font-semibold text-ink">
                    {m.to ? shortDate(m.to) : "No date"}
                  </strong>
                </p>
              </Card>
            ))}
          </ul>
          {canEdit ? (
            <ApplyRescheduleForm
              workspaceId={access.wedding.id}
              moves={moves.map((m) => ({ id: m.task.id, version: m.task.version }))}
            />
          ) : (
            <p className="text-body-md text-ink-muted">
              Only an owner or partner can apply these changes.
            </p>
          )}
        </>
      )}

      <p className="text-body-md text-ink-muted">
        Not moving: {unchanged.fixed} {unchanged.fixed === 1 ? "task" : "tasks"} with a date you
        chose, {unchanged.completed} completed.
      </p>
      <p>
        <Link
          href={`${base}/plan`}
          className="font-semibold text-action-emphasis underline underline-offset-4"
        >
          Back to the checklist
        </Link>
      </p>
    </div>
  );
}
