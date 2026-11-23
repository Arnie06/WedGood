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

const linkClass = "font-semibold text-action-emphasis underline underline-offset-4";

function countdown(days: number): string {
  if (days === 0) return "That's today";
  if (days === 1) return "1 day to go";
  if (days > 1) return `${days} days to go`;
  return days === -1 ? "1 day ago" : `${-days} days ago`;
}

export default async function WorkspaceHomePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const canManageGuests = hasCapability(access, "guests.manage");
  const [s, tasks, counts, events, attention, demand, deadlines] = await Promise.all([
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
  const days = date ? daysBetween(todayInZone(s.timezone), date) : null;

  const today = todayInZone(s.timezone);
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

  const attentionCard = (
    <Card as="section" aria-labelledby="home-attention" data-testid="home-attention">
      <CardTitle>
        <span id="home-attention">Needs attention</span>
      </CardTitle>
      <p className="mt-1 text-body-md text-ink-muted">
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
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">{s.name}</h1>
      </header>
      {replyStrip.rows.length > 0 && (
        <ReplyStripCard strip={replyStrip} base={base} canManageGuests={canManageGuests} />
      )}
      {attention.visible.length > 0 && attentionCard}
      {primary && (
        <Card as="section" aria-labelledby="next-up" className="space-y-4">
          <p id="next-up" className="text-label-lg font-semibold text-ink-muted uppercase">
            Next up
          </p>
          <ActionBlock action={primary} base={base} s={s} workspaceId={access.wedding.id} lead />
          {others.length > 0 && (
            <ul className="divide-y divide-border-hairline border-t border-border-hairline">
              {others.map((a) => (
                <li key={a.id} className="py-4 last:pb-0">
                  <ActionBlock action={a} base={base} s={s} workspaceId={access.wedding.id} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {attention.visible.length === 0 && attentionCard}
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
      <Card as="section" aria-labelledby="home-events">
        <CardTitle>
          <span id="home-events">Your events</span>
        </CardTitle>
        {events.length === 0 ? (
          <p className="mt-2 text-body-md text-ink-muted">
            No events yet, such as a ceremony or reception.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {events.slice(0, 4).map((e) => (
              <li key={e.id}>
                <Link
                  href={`${base}/plan/events/${e.id}`}
                  className={`${linkClass} inline-flex min-h-11 items-center`}
                >
                  {e.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          <Link
            href={`${base}/plan/events`}
            className={`${linkClass} inline-flex min-h-11 items-center`}
          >
            {events.length > 4 ? "See all events" : "Open events"}
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
      <Card>
        <CardTitle>People</CardTitle>
        <p className="mt-2 text-body-md text-ink-muted">
          Invite your partner or helpers, and see what has been shared with you.
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
        <ButtonLink
          href={`${base}/${action.path}`}
          variant={lead ? "primary" : "outline"}
          size="sm"
        >
          {action.cta}
        </ButtonLink>
      )}
    </div>
  );
}
