import { CalendarClock, CircleCheck, ClipboardList, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatDateOnly } from "@/domain/dates/date-only";
import { formatMinor } from "@/domain/money/money";
import {
  DashboardHero,
  DashboardMetric,
  DashboardMetrics,
} from "@/features/home/dashboard-overview";
import { buildHomeSummary } from "@/features/preview/home-summary";
import { sampleWorkspace } from "@/features/preview/sample-workspace";

export const metadata: Metadata = { title: "Home" };

export default function PreviewHomePage() {
  const workspace = sampleWorkspace;
  const summary = buildHomeSummary(workspace);
  const money = (minor: number) => formatMinor(minor, workspace.currency);
  const committedPercent = Math.round(
    (summary.budget.committedMinor * 100) / summary.budget.targetMinor,
  );
  const { responses, meals } = summary.primaryEvent;

  return (
    <div className="space-y-6">
      <DashboardHero
        name={workspace.name}
        date={formatDateOnly(workspace.weddingDate, "en-US", { dateStyle: "full" })}
        days={summary.daysToGo}
      />
      <DashboardMetrics>
        <DashboardMetric
          icon={ClipboardList}
          label="Tasks completed"
          value={`${summary.tasks.done} / ${summary.tasks.total}`}
        />
        <DashboardMetric
          icon={Wallet}
          label="Budget target"
          value={money(summary.budget.targetMinor)}
        />
        <DashboardMetric
          icon={Users}
          label="Attending"
          value={String(responses.accepted)}
          note={summary.primaryEvent.name}
        />
      </DashboardMetrics>

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-5">
          <Card as="section" aria-labelledby="next-steps" className="space-y-4">
            <CardTitle id="next-steps">Your next steps</CardTitle>
            <ol className="divide-y divide-border-hairline border-y border-border-hairline">
              {summary.tasks.next.map((task) => (
                <li key={task.id} className="flex items-start gap-3 py-2.5">
                  <CalendarClock
                    aria-hidden="true"
                    className="mt-0.5 size-5 shrink-0 text-action-secondary"
                    strokeWidth={1.5}
                  />
                  <div>
                    <p className="text-body-md text-ink">{task.title}</p>
                    <p className="text-body-sm text-ink-muted">
                      {task.dueDate
                        ? `Due ${formatDateOnly(task.dueDate, "en-US", { dateStyle: "medium" })}`
                        : "No date yet"}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <ProgressBar
              label="Planning progress"
              value={summary.tasks.done}
              max={summary.tasks.total}
              valueText={`${summary.tasks.done} of ${summary.tasks.total} tasks complete`}
            />
          </Card>

          <Card as="section" aria-labelledby="budget" className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <CardTitle id="budget">Budget</CardTitle>
            </div>
            <dl className="divide-y divide-border-hairline">
              {(
                [
                  ["Committed", summary.budget.committedMinor],
                  ["Paid", summary.budget.netPaidMinor],
                  ["Still owed", summary.budget.outstandingMinor],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 py-2"
                >
                  <dt className="text-label-md font-semibold text-ink-muted uppercase">{label}</dt>
                  <dd className="text-body-lg font-semibold text-ink tabular-nums">
                    {money(value)}
                  </dd>
                </div>
              ))}
            </dl>
            <ProgressBar
              label="Committed of target"
              value={summary.budget.committedMinor}
              max={summary.budget.targetMinor}
              valueText={`${committedPercent}% of target committed`}
            />
            <p className="text-body-sm text-ink-muted">
              Payments are records you add. They don&apos;t send money. A full forecast isn&apos;t
              calculated in this preview.
            </p>
          </Card>
        </div>
        <Card as="section" aria-labelledby="guests" className="space-y-5">
          <div className="space-y-1">
            <CardTitle id="guests">Guests</CardTitle>
            <p className="text-body-sm text-ink-muted">{summary.primaryEvent.name}</p>
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Responses">
            <li>
              <Badge tone="confirmed">{responses.accepted} accepted</Badge>
            </li>
            <li>
              <Badge tone="pending">{responses.pending} pending</Badge>
            </li>
            <li>
              <Badge tone="neutral">{responses.declined} declined</Badge>
            </li>
          </ul>
          <div className="space-y-2">
            <h3 className="text-label-md font-semibold text-ink-muted uppercase">
              Meals for accepted guests
            </h3>
            <ul className="divide-y divide-border-hairline">
              {meals.map((meal) => (
                <li key={meal.name} className="flex items-center justify-between py-2 text-body-md">
                  <span>{meal.name}</span>
                  <span className="font-semibold tabular-nums">{meal.count}</span>
                </li>
              ))}
            </ul>
            {responses.acceptedWithoutMeal === 0 && (
              <p className="flex items-center gap-1.5 text-body-sm text-ink-muted">
                <CircleCheck aria-hidden="true" className="size-4 text-action-secondary" />
                Every accepted guest has chosen a meal.
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
