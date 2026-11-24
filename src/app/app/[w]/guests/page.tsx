import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import { ButtonLink } from "@/components/ui/button";
import { TrayButton } from "@/components/ui/tray";
import { Card } from "@/components/ui/card";
import { DensityToggle } from "@/components/ui/density-toggle";
import { nameKey } from "@/domain/guests/import";
import {
  ANSWER_LABELS,
  answerOf,
  describeSeat,
  isReplyFilter,
  matchesReply,
  needsMeal,
  needsSeat,
  replyTotals,
  type GuestReplies,
  type GuestReply,
} from "@/domain/guests/replies";
import { GuestFilters } from "@/features/guests/guest-filters";
import { GuestForm } from "@/features/guests/guest-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadEventRecords } from "@/server/events/queries";
import { loadGuests, type GuestRecord } from "@/server/guests/queries";
import { loadGuestReplies } from "@/server/guests/replies";
import { guestEmailEnabled } from "@/server/rsvp/flags";
import { readDensity } from "@/server/display/density";

export const metadata: Metadata = { title: "Guest list" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

type Query = {
  q?: string;
  age?: string;
  tag?: string;
  view?: string;
  event?: string;
  reply?: string;
};

export default async function GuestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ w: string }>;
  searchParams: Promise<Query>;
}) {
  const { w } = await params;
  const query = await searchParams;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  const density = await readDensity(wid, access.membership.role);

  if (!hasCapability(access, "guests.manage")) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest list</h1>
        <Card>
          <p className="text-body-md">
            The guest list holds private contact details, so it is limited to the workspace owner
            and partner. Ask them if you need a guest&apos;s details.
          </p>
        </Card>
      </div>
    );
  }

  const [data, events] = await Promise.all([loadGuests(wid), loadEventRecords(wid)]);
  const showArchived = query.view === "archived";
  // Replies follow event_demand, which leaves archived guests out, so the archived view has none.
  const event = showArchived ? undefined : events.find((e) => e.id === query.event);
  const replies = event ? await loadGuestReplies(wid, event.id) : null;
  const reply =
    replies && isReplyFilter(query.reply) && (replies.asksMeal || query.reply !== "no_meal")
      ? query.reply
      : "";
  const active = data.guests.filter((g) => !g.archived);
  const archivedCount = data.guests.length - active.length;
  const allTags = [...new Set(active.flatMap((g) => g.tags))].sort((a, b) => a.localeCompare(b));

  const q = (query.q ?? "").trim().slice(0, 100);
  const qKey = nameKey(q);
  const age = query.age === "adult" || query.age === "child" ? query.age : "";
  const tag = allTags.includes(query.tag ?? "") ? (query.tag ?? "") : "";
  const filtering = q !== "" || age !== "" || tag !== "" || reply !== "";
  const matches = (g: GuestRecord) =>
    (qKey === "" ||
      nameKey(g.fullName).includes(qKey) ||
      (g.email ?? "").toLowerCase().includes(q.toLowerCase())) &&
    (age === "" || g.ageGroup === age) &&
    (tag === "" || g.tags.includes(tag)) &&
    (replies === null || matchesReply(replies.byGuest.get(g.id), reply));
  const visible = data.guests.filter((g) => g.archived === showArchived).filter(matches);

  const households = new Map(data.households.map((h) => [h.id, h]));
  const activeHouseholds = new Set(active.flatMap((g) => (g.householdId ? [g.householdId] : [])))
    .size;
  const groups = new Map<string, GuestRecord[]>();
  for (const g of visible) {
    const key = g.householdId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return (households.get(a)?.name ?? "").localeCompare(households.get(b)?.name ?? "");
  });
  const adults = active.filter((g) => g.ageGroup === "adult").length;
  const children = active.filter((g) => g.ageGroup === "child").length;
  const canSeePrivate = hasCapability(access, "guests.sensitive.read");
  const totals = replies
    ? replyTotals(
        active.map((g) => g.id),
        replies,
      )
    : null;
  const replyHref = (f: string) => `${base}/guests?event=${event?.id ?? ""}&reply=${f}`;

  return (
    <div className="space-y-6">
      <WorkspacePageHeading
        title="Guest list"
        description={
          active.length > 0 && (
            <>
              {active.length} {active.length === 1 ? "guest" : "guests"} · {activeHouseholds}{" "}
              {activeHouseholds === 1 ? "household" : "households"} · {adults}{" "}
              {adults === 1 ? "adult" : "adults"} · {children}{" "}
              {children === 1 ? "child" : "children"}
              {active.length - adults - children > 0 &&
                ` · ${active.length - adults - children} age unspecified`}
            </>
          )
        }
        actions={
          <>
            <TrayButton
              label="Add a guest"
              title="Add a guest"
              openOnParam="add"
              description="Just a name is enough. This stays open so you can keep adding."
            >
              <GuestForm
                quick
                workspaceId={wid}
                householdNames={data.households.map((h) => h.name)}
                showPrivate={canSeePrivate}
                submitLabel="Add guest"
              />
            </TrayButton>
            <ButtonLink href={`${base}/guests/import`} variant="outline">
              Import a spreadsheet
            </ButtonLink>
          </>
        }
      />
      <nav aria-label="Guest tools" className="tool-nav">
        <Link href={`${base}/plan/events`} className="tool-link">
          Events
        </Link>
        <Link href={`${base}/guests/invitations`} className="tool-link">
          Invitations
        </Link>
        {guestEmailEnabled() && (
          <Link href={`${base}/guests/messages`} className="tool-link">
            Guest emails
          </Link>
        )}
        {hasCapability(access, "seating.manage") && (
          <Link href={`${base}/seating`} className="tool-link">
            Seating
          </Link>
        )}
        <Link href={`${base}/website`} className="tool-link">
          Guest website
        </Link>
      </nav>

      <section aria-labelledby="list" className="space-y-4">
        {data.guests.length > 0 && (
          <>
            <GuestFilters
              base={base}
              q={q}
              age={age}
              tag={tag}
              allTags={allTags}
              events={showArchived ? [] : events.map((e) => ({ id: e.id, name: e.name }))}
              event={event?.id ?? ""}
              reply={reply}
              asksMeal={replies?.asksMeal ?? false}
              showArchived={showArchived}
              filtering={filtering || event !== undefined}
            />

            {event && totals && (
              <div className="space-y-1 text-body-sm">
                <p className="text-ink-muted">
                  {event.name}: {totals.yes} attending · {totals.waiting} waiting · {totals.no} not
                  attending · {totals.not_invited} not invited
                </p>
                {(totals.not_seated > 0 || (replies?.asksMeal && totals.no_meal > 0)) && (
                  <ul className="flex flex-wrap gap-x-4">
                    {replies?.asksMeal && totals.no_meal > 0 && reply !== "no_meal" && (
                      <li>
                        <Link
                          href={replyHref("no_meal")}
                          className={`${link} inline-flex min-h-11 items-center`}
                        >
                          {totals.no_meal} attending without a meal
                        </Link>
                      </li>
                    )}
                    {totals.not_seated > 0 && reply !== "not_seated" && (
                      <li>
                        <Link
                          href={replyHref("not_seated")}
                          className={`${link} inline-flex min-h-11 items-center`}
                        >
                          {totals.not_seated} attending, not seated
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div>
            <h2 id="list" className="font-serif text-headline-sm">
              {showArchived ? "Archived guests" : "Your guests"}
            </h2>
            {data.guests.length > 0 && (
              <p role="status" className="text-body-sm text-ink-muted">
                Showing {visible.length} {visible.length === 1 ? "guest" : "guests"}
                {filtering ? " that match" : ""}.
              </p>
            )}
          </div>
          {data.guests.length > 0 && <DensityToggle workspaceId={wid} density={density} />}
        </div>

        {ordered.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              {data.guests.length === 0
                ? "No guests yet. Use Add a guest above, or import a spreadsheet."
                : "No guests match. Try clearing the filters."}
            </p>
          </Card>
        ) : (
          <div className="rounded-card border border-border-hairline bg-surface">
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 border-b border-border-hairline px-4 py-2 text-label-md font-semibold text-ink-muted lg:grid"
            >
              <span>Guest</span>
              {replies ? (
                <div className="grid grid-cols-3 gap-3">
                  <span>Answer</span>
                  <span>Meal</span>
                  <span>Seat</span>
                </div>
              ) : (
                <span>Age and tags</span>
              )}
            </div>
            <ul className="divide-y divide-border-hairline">
              {ordered.map(([hid, members]) => {
                const h = households.get(hid);
                return (
                  <li key={hid || "none"}>
                    <h3 className="bg-surface-sunken px-3 py-2 text-body-sm font-semibold wrap-anywhere text-ink-muted sm:px-4">
                      {h ? h.name : "Individual guests"}
                    </h3>
                    <ul className="divide-y divide-border-hairline">
                      {members.map((g) => (
                        <li
                          key={g.id}
                          data-testid="guest-row"
                          className="grid min-w-0 gap-x-4 gap-y-1 px-3 py-1.5 sm:px-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-center compact:py-0"
                        >
                          <div className={replies ? "min-w-0" : "contents"}>
                            <Link
                              href={`${base}/guests/${g.id}`}
                              className={`${link} inline-flex min-h-11 items-center rounded-hairline wrap-anywhere`}
                            >
                              <span className="min-w-0">{g.fullName}</span>
                            </Link>
                            {(g.ageGroup || g.tags.length > 0) && (
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5 pb-2 lg:pb-0">
                                {g.ageGroup && (
                                  <span className="text-body-sm text-ink-muted">
                                    {g.ageGroup === "adult" ? "Adult" : "Child"}
                                  </span>
                                )}
                                {g.tags.map((t) => (
                                  <span
                                    key={t}
                                    className="max-w-full rounded-full bg-status-neutral-bg px-2 py-0.5 text-body-sm wrap-anywhere text-status-neutral-fg"
                                  >
                                    {t}
                                  </span>
                                ))}
                              </span>
                            )}
                          </div>
                          {replies && (
                            <ReplyCells reply={replies.byGuest.get(g.id)} replies={replies} />
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 text-body-sm">
          <a href={`${base}/guests/export`} className={`${link} inline-flex min-h-11 items-center`}>
            Download the list as CSV
          </a>
          {showArchived ? (
            <Link href={`${base}/guests`} className={link}>
              Back to your guests
            </Link>
          ) : archivedCount > 0 ? (
            <Link href={`${base}/guests?view=archived`} className={link}>
              View {archivedCount} archived {archivedCount === 1 ? "guest" : "guests"}
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Flag({ children }: { children: string }) {
  return (
    <span className="inline-flex items-start gap-1 font-semibold text-status-pending-fg">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </span>
  );
}

/** Answer, meal and seat for the chosen event. Individual labels keep each row readable on narrow screens. */
function ReplyCells({ reply, replies }: { reply: GuestReply | undefined; replies: GuestReplies }) {
  const answer = answerOf(reply);
  const meal = !reply || reply.answer !== "yes" ? "—" : !replies.asksMeal ? "Not asked" : null;
  const seat = reply?.seat ? describeSeat(reply.seat) : null;
  return (
    <dl className="grid grid-cols-3 gap-x-3 pb-2 text-body-sm lg:pb-0">
      <div className="min-w-0">
        <dt className="text-label-md text-ink-muted lg:sr-only">Answer</dt>
        <dd className="wrap-anywhere">
          {ANSWER_LABELS[answer]}
          {reply?.isPlusOne && " (plus-one)"}
          {reply?.replyClosed && <span className="block text-ink-muted">Reply date passed</span>}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-label-md text-ink-muted lg:sr-only">Meal</dt>
        <dd className="wrap-anywhere">
          {meal ?? (needsMeal(reply) ? <Flag>Not chosen</Flag> : reply?.meal)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-label-md text-ink-muted lg:sr-only">Seat</dt>
        <dd className="wrap-anywhere">
          {needsSeat(reply) ? (
            <Flag>{seat ? `Not confirmed (${seat})` : "Not seated"}</Flag>
          ) : (
            (seat ?? "—")
          )}
        </dd>
      </div>
    </dl>
  );
}
