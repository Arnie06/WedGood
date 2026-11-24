import { ChevronRight, ClipboardList, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { daysBetween, formatDateOnly, parseDateOnly, todayInZone } from "@/domain/dates/date-only";
import { formatMinor } from "@/domain/money/money";
import { nextActions, type HomeAction } from "@/domain/home/next-actions";
import { QuickSetForm } from "@/features/workspace/quick-set-form";
import { previewReschedule } from "@/domain/tasks/schedule";
import { groupTasks, nextSteps, progress } from "@/domain/tasks/summary";
import { dueLabel } from "@/features/plan/format";
import { toScheduled, toSummary } from "@/features/plan/mappers";
import { loadTasks } from "@/server/plan/queries";
import { ProgressBar } from "@/components/ui/progress-bar";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventLabels } from "@/server/timeline/queries";
import { loadHomeCounts, loadWeddingSettings } from "@/server/workspace/queries";
import { loadAttention } from "@/server/attention/queries";
import { AttentionList, SeeAllLink } from "@/features/attention/attention-list";
import { attentionSummary } from "@/domain/attention/attention";
import { buildReplyStrip } from "@/domain/home/reply-strip";
import { ReplyStripCard } from "@/features/home/reply-strip-card";
import { loadEventDemand } from "@/server/events/demand";
import { loadReplyDeadlines } from "@/server/events/reply-dates";
import { loadBudgetInputs, summarizeBudgetInputs } from "@/server/budget/view";
import {
  DashboardHero,
  DashboardMetric,
  DashboardMetrics,
} from "@/features/home/dashboard-overview";

const linkClass =
  "inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4";

export default async function WorkspaceHomePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const canManageGuests = hasCapability(access, "guests.manage");
  const [s, tasks, counts, events, attention, demand, deadlines, budgetInputs] = await Promise.all([
    loadWeddingSettings(access.wedding.id),
    loadTasks(access.wedding.id),
    loadHomeCounts(access.wedding.id),
    loadEventLabels(access.wedding.id),
    loadAttention(access, access.wedding.timezone),
    // Counts only through event_demand's gate: owner/partner, or anyone once totals are shared.
    loadEventDemand(access.wedding.id, {
      canManageGuests,
      shareGuestTotals: access.wedding.shareGuestTotals,
    }),
    // Invitations are owner/partner only; collaborators see counts without reply dates.
    canManageGuests ? loadReplyDeadlines(access.wedding.id) : new Map<string, string[]>(),
    loadBudgetInputs(access.wedding.id),
  ]);
  const ATTENTION_SHOWN = 3;
  const replyStrip = buildReplyStrip(
    events.map((e) => ({
      id: e.id,
      name: e.name,
      localDate: e.localDate,
      timeZone: e.effectiveTimeZone,
    })),
    demand.byEvent,
    deadlines,
    new Date(),
  );
  const base = `/app/${access.wedding.id}`;

  const date = s.date ? parseDateOnly(s.date) : null;
  const today = todayInZone(s.timezone);
  const days = date ? daysBetween(today, date) : null;
  const summaries = tasks.map(toSummary);
  const steps = nextSteps(summaries, today, 3);
  const { done, total } = progress(summaries);
  const drift = previewReschedule(s.date, tasks.map(toScheduled)).moves.length;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const canEditPlan = hasCapability(access, "plan.edit");

  // Missing facts become gentle, ordered prompts, never defaults (src/domain/home).
  const actions = nextActions({
    hasDate: s.date !== null,
    hasBudgetTarget: s.targetBudgetMinor !== null,
    hasGuestTarget: s.targetGuestCount !== null,
    checklistTotal: total,
    overdueCount: groupTasks(summaries, today).overdue.length,
    venueCount: counts.venueCount,
    guestCount: counts.guestCount,
    can: {
      settings: hasCapability(access, "settings.edit"),
      plan: canEditPlan,
      guests: canManageGuests,
      vendors: hasCapability(access, "vendors.manage"),
    },
  });
  const [primary, ...others] = actions;

  const budget = summarizeBudgetInputs(budgetInputs, s);
  const money = (minor: number) => formatMinor(minor, s.baseCurrency);
  const hasForecast = budget.items.length > 0 || budget.committedMinor > 0;
  const budgetTarget = s.targetBudgetMinor === null ? null : money(s.targetBudgetMinor);
  const forecast = hasForecast
    ? `${budget.incomplete ? "At least " : ""}${money(budget.forecastMinor)}`
    : null;
  const guestTarget = s.targetGuestCount;
  const guestCount = canManageGuests ? counts.guestCount : null;
  const eventSettings = `${base}/settings/event`;
  const planHref = `${base}/plan`;

  const nextUp = primary && (
    <Card as="section" aria-labelledby="next-up">
      <CardTitle id="next-up">Next up</CardTitle>
      <div className="mt-3">
        <ActionBlock action={primary} base={base} s={s} workspaceId={access.wedding.id} lead />
      </div>
      {others.length > 0 && (
        <ul className="mt-3 divide-y divide-border-hairline border-t border-border-hairline">
          {others.map((a) => (
            <li key={a.id} className="py-2 last:pb-0">
              <ActionBlock action={a} base={base} s={s} workspaceId={access.wedding.id} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className="space-y-6">
      <DashboardHero
        name={s.name}
        date={date ? formatDateOnly(date) : null}
        location={s.location}
        days={days}
        settings={{
          href: eventSettings,
          label: hasCapability(access, "settings.edit")
            ? "Edit event details"
            : "View event details",
        }}
      />
      <DashboardMetrics>
        <DashboardMetric
          icon={ClipboardList}
          label="Tasks completed"
          value={total > 0 ? `${done} / ${total}` : "No tasks yet"}
          href={planHref}
        />
        <DashboardMetric
          icon={Wallet}
          label={forecast ? "Budget forecast" : "Budget target"}
          value={forecast ?? budgetTarget ?? "To be set"}
          note={forecast && budgetTarget ? `Target ${budgetTarget}` : undefined}
          href={`${planHref}/budget`}
        />
        <DashboardMetric
          icon={Users}
          label={guestCount !== null ? "Guests on your list" : "Guest target"}
          value={guestCount !== null ? String(guestCount) : String(guestTarget ?? "To be set")}
          note={guestCount !== null && guestTarget !== null ? `Target ${guestTarget}` : undefined}
          href={canManageGuests ? `${base}/guests` : eventSettings}
        />
      </DashboardMetrics>

      {drift > 0 && (
        <section
          aria-labelledby="home-date-change"
          className="flex flex-wrap items-center justify-between gap-x-5 rounded-card border border-border-hairline bg-surface px-4 py-2"
        >
          <div>
            <h2 id="home-date-change" className="text-body-md font-semibold">
              Your wedding date changed
            </h2>
            <p className="text-body-sm text-ink-muted">
              {drift} checklist {drift === 1 ? "date needs" : "dates need"} review.
            </p>
          </div>
          <Link href={`${planHref}/review-dates`} className={linkClass}>
            Review the new dates
          </Link>
        </section>
      )}

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-5">
          {total === 0 && nextUp}
          <Card as="section" aria-labelledby="home-next-steps">
            <div className="flex flex-wrap items-center justify-between gap-x-4">
              <CardTitle id="home-next-steps">Next steps</CardTitle>
              <Link href={planHref} className={linkClass}>
                {total === 0 && canEditPlan ? "Start your checklist" : "Open checklist"}
              </Link>
            </div>
            {total === 0 ? (
              <p className="mt-2 text-body-md text-ink-muted">No tasks yet.</p>
            ) : (
              <div className="mt-3 space-y-4">
                <ProgressBar
                  label="Checklist progress"
                  value={done}
                  max={total}
                  valueText={`${done} of ${total} done`}
                />
                {steps.length === 0 ? (
                  <p className="text-body-md text-ink-muted">
                    Everything on your checklist is done.
                  </p>
                ) : (
                  <ol className="divide-y divide-border-hairline border-t border-border-hairline">
                    {steps.map((step) => (
                      <li key={step.id}>
                        <Link
                          href={`${planHref}#task-${step.id}`}
                          className="flex min-h-11 items-center gap-3 rounded-hairline py-2 hover:text-action-emphasis"
                        >
                          <span className="min-w-0 grow">
                            <span className="block text-body-md font-semibold wrap-anywhere">
                              {step.title}
                            </span>
                            <span className="block text-body-sm text-ink-muted">
                              {dueLabel(byId.get(step.id)?.dueDate ?? null, today)}
                            </span>
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="size-4 shrink-0 text-action-emphasis"
                          />
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </Card>
          {replyStrip.rows.length > 0 && (
            <ReplyStripCard strip={replyStrip} base={base} canManageGuests={canManageGuests} />
          )}
        </div>

        <div className="min-w-0 space-y-5">
          {total > 0 && nextUp}
          <Card as="section" aria-labelledby="home-attention" data-testid="home-attention">
            <CardTitle id="home-attention">Needs attention</CardTitle>
            <p className="mt-1 text-body-sm text-ink-muted">
              {attentionSummary(attention.visible.length)}
            </p>
            {attention.visible.length > 0 && (
              <div className="mt-3">
                <AttentionList
                  items={attention.visible.slice(0, ATTENTION_SHOWN)}
                  base={base}
                  workspaceId={access.wedding.id}
                  canAct={attention.canAct}
                />
              </div>
            )}
            <SeeAllLink
              base={base}
              total={attention.visible.length}
              shown={ATTENTION_SHOWN}
              hidden={attention.canAct ? attention.dismissed.length : 0}
            />
          </Card>
          <Card as="section" aria-labelledby="home-events">
            <div className="flex flex-wrap items-center justify-between gap-x-3">
              <CardTitle id="home-events">Your events</CardTitle>
              <Link href={`${planHref}/events`} className={linkClass}>
                {events.length > 4 ? "See all events" : "Open events"}
              </Link>
            </div>
            {events.length === 0 ? (
              <p className="mt-2 text-body-sm text-ink-muted">No events yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-border-hairline border-t border-border-hairline">
                {events.slice(0, 4).map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`${planHref}/events/${e.id}`}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-hairline py-2 text-body-md hover:text-action-emphasis"
                    >
                      <span className="min-w-0 wrap-anywhere">{e.name}</span>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-action-emphasis"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <nav aria-label="People and sharing" className="flex flex-wrap gap-x-4 px-1">
            <Link href={`${base}/settings/members`} className="tool-link">
              {hasCapability(access, "members.manage")
                ? "Manage people and invitations"
                : "See who has access"}
            </Link>
            <Link href={`${base}/shared`} className="tool-link">
              Shared choices and comments
            </Link>
          </nav>
        </div>
      </div>
    </div>
  );
}

function ActionBlock({
  action,
  base,
  s,
  workspaceId,
  lead = false,
}: {
  action: HomeAction;
  base: string;
  s: Awaited<ReturnType<typeof loadWeddingSettings>>;
  workspaceId: string;
  lead?: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className={lead ? "font-serif text-headline-sm" : "text-body-lg font-semibold"}>
        {action.title}
      </p>
      <p className="text-body-md text-ink-muted">{action.reason}</p>
      {action.inline === "budget" ? (
        <QuickSetForm
          which="targetBudget"
          workspaceId={workspaceId}
          version={s.version}
          label={`Budget target (${s.baseCurrency})`}
          hint="A rough number is fine. You can change it any time."
          inputMode="decimal"
          currency={s.baseCurrency}
        />
      ) : action.inline === "guests" ? (
        <QuickSetForm
          which="targetGuestCount"
          workspaceId={workspaceId}
          version={s.version}
          label="Guest count target"
          hint="A rough number is fine."
          inputMode="numeric"
        />
      ) : (
        <ButtonLink href={`${base}/${action.path}`} variant={lead ? "primary" : "quiet"} size="sm">
          {action.cta}
        </ButtonLink>
      )}
    </div>
  );
}
