import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { ZonedDate } from "@/features/events/zoned-date";
import { ConsequencesPanel } from "@/features/guests/consequences-panel";
import { ArchiveGuestForm, GuestForm, HouseholdForm } from "@/features/guests/guest-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadGuestConsequences } from "@/server/guests/consequences";
import {
  NO_PRIVATE_DETAILS,
  loadGuestPrivateDetails,
  loadGuestReplyHistory,
  loadGuests,
} from "@/server/guests/queries";
import {
  describeReplyChange,
  describeReplySource,
  groupReplyChanges,
} from "@/domain/guests/history";

export const metadata: Metadata = { title: "Guest" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

const link = "font-semibold text-action-emphasis underline underline-offset-4";

export default async function GuestPage({
  params,
}: {
  params: Promise<{ w: string; guestId: string }>;
}) {
  const { w, guestId } = await params;
  const access = await requireWorkspace(w);
  const wid = access.wedding.id;
  const base = `/app/${wid}`;
  if (!hasCapability(access, "guests.manage")) notFound();

  const data = await loadGuests(wid);
  const guest = data.guests.find((g) => g.id === guestId);
  if (!guest) notFound();
  const canSeePrivate = hasCapability(access, "guests.sensitive.read");
  const details = canSeePrivate ? await loadGuestPrivateDetails(wid, guestId) : NO_PRIVATE_DETAILS;
  const [history, consequences] = await Promise.all([
    loadGuestReplyHistory(wid, guestId),
    loadGuestConsequences(wid, guestId, access.wedding.timezone),
  ]);
  const replyGroups = groupReplyChanges(history.changes);
  const household = data.households.find((h) => h.id === guest.householdId);
  const housemates = household
    ? data.guests.filter((g) => g.householdId === household.id && g.id !== guest.id && !g.archived)
    : [];

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="text-body-md">
          <Link href={`${base}/guests`} className={`${link} inline-flex min-h-11 items-center`}>
            Back to the guest list
          </Link>
        </p>
        <h1 className="font-serif text-headline-mobile break-words md:text-headline-lg">
          {guest.fullName}
        </h1>
        {guest.archived && <Badge tone="pending">Archived</Badge>}
      </header>

      <section aria-labelledby="details" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="details" className="font-serif text-headline-sm">
            Details
          </h2>
          {guest.archived ? null : (
            <TrayButton
              label="Edit guest"
              variant="outline"
              size="sm"
              title="Edit guest"
              description={guest.fullName}
            >
              <GuestForm
                workspaceId={wid}
                householdNames={data.households.map((h) => h.name)}
                guest={{ id: guest.id, version: guest.version }}
                showPrivate={canSeePrivate}
                submitLabel="Save guest"
                initial={{
                  fullName: guest.fullName,
                  email: guest.email ?? "",
                  phone: guest.phone ?? "",
                  household: household?.name ?? "",
                  tags: guest.tags.join(", "),
                  ageGroup: guest.ageGroup ?? "",
                  dietary: details.dietary ?? "",
                  accessibility: details.accessibility ?? "",
                  notes: details.notes ?? "",
                }}
              />
            </TrayButton>
          )}
        </div>
        <Card>
          {guest.archived ? (
            <p className="text-body-md text-ink-muted">Restore this guest to edit their details.</p>
          ) : (
            <div className="space-y-4">
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {[
                  ["Household", household?.name ?? "None"],
                  [
                    "Adult or child",
                    guest.ageGroup === "adult"
                      ? "Adult"
                      : guest.ageGroup === "child"
                        ? "Child"
                        : "Not set",
                  ],
                  ["Email", guest.email ?? "Not set"],
                  ["Phone", guest.phone ?? "Not set"],
                  ["Tags", guest.tags.length > 0 ? guest.tags.join(", ") : "None"],
                  ...(canSeePrivate
                    ? [
                        ["Dietary needs (your notes)", details.dietary ?? "None noted"],
                        ...(details.guestDietary
                          ? [["Dietary needs (from the guest)", details.guestDietary]]
                          : []),
                        ["Accessibility needs (your notes)", details.accessibility ?? "None noted"],
                        ...(details.guestAccessibility
                          ? [["Accessibility needs (from the guest)", details.guestAccessibility]]
                          : []),
                        ["Private notes", details.notes ?? "None"],
                      ]
                    : []),
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-label-lg text-ink-muted">{label}</dt>
                    <dd className="text-body-lg break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              {canSeePrivate && details.guestAnsweredAt && (
                <p className="text-body-sm text-ink-muted">
                  The guest last added notes through their RSVP link on{" "}
                  <ZonedDate iso={details.guestAnsweredAt} timeZone={access.wedding.timezone} />.
                  Their words are kept as they wrote them; editing your notes never changes them.
                </p>
              )}
            </div>
          )}
        </Card>
        {canSeePrivate && !guest.archived && (
          <p className="text-body-sm text-ink-muted">
            Dietary, accessibility and private notes are only visible to people with access to
            private details (the owner and partner by default), and are left out of exports.
          </p>
        )}
      </section>

      {household && !guest.archived && (
        <section aria-labelledby="household" className="space-y-3">
          <h2 id="household" className="font-serif text-headline-sm">
            Household
          </h2>
          <Card>
            <CardTitle as="h3">{household.name}</CardTitle>
            {housemates.length > 0 && (
              <p className="text-body-md">
                Also in this household:{" "}
                {housemates.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && ", "}
                    <Link href={`${base}/guests/${m.id}`} className={link}>
                      {m.fullName}
                    </Link>
                  </span>
                ))}
                .
              </p>
            )}
            <div className="mt-4">
              <TrayButton
                label="Edit household"
                variant="outline"
                size="sm"
                title="Edit household"
                description={household.name}
              >
                <HouseholdForm
                  workspaceId={wid}
                  household={{
                    id: household.id,
                    version: household.version,
                    name: household.name,
                    address: household.address ?? "",
                    notes: household.notes ?? "",
                  }}
                />
              </TrayButton>
            </div>
          </Card>
        </section>
      )}

      {consequences.length > 0 && (
        <section aria-labelledby="consequences" className="space-y-3">
          <div className="space-y-1">
            <h2 id="consequences" className="font-serif text-headline-sm">
              What the latest changes affected
            </h2>
            <p className="text-body-md text-ink-muted">
              For each event, the most recent change to this guest&apos;s answer or meal, with
              totals as they stand now.
            </p>
          </div>
          <ConsequencesPanel base={base} items={consequences} when={when} />
        </section>
      )}

      <section aria-labelledby="replies" className="space-y-3">
        <h2 id="replies" className="font-serif text-headline-sm">
          Reply history
        </h2>
        {replyGroups.length === 0 ? (
          <p className="text-body-md text-ink-muted">
            No answers have changed yet. Each time this guest&apos;s answer or meal changes, it is
            recorded here.
          </p>
        ) : (
          replyGroups.map((group) => (
            <Card key={group.eventId} className="space-y-2">
              <CardTitle as="h3">{history.eventNames[group.eventId] ?? "Event"}</CardTitle>
              <ol className="divide-y divide-border-hairline">
                {group.changes.map((c) => (
                  <li key={c.id} className="space-y-1 py-2">
                    <p className="text-body-md font-semibold">{describeReplyChange(c)}</p>
                    <p className="text-body-sm text-ink-muted">
                      {when(c.occurredAt)}. {describeReplySource(c)}.
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          ))
        )}
      </section>

      <section aria-labelledby="archive" className="border-t border-border-hairline pt-6">
        <h2 id="archive" className="sr-only">
          {guest.archived ? "Restore" : "Archive"}
        </h2>
        <TrayButton
          label={guest.archived ? "Restore this guest" : "Archive this guest"}
          variant="outline"
          title={guest.archived ? "Restore this guest" : "Archive this guest"}
        >
          <ArchiveGuestForm
            workspaceId={wid}
            guestId={guest.id}
            version={guest.version}
            archived={guest.archived}
            name={guest.fullName}
          />
        </TrayButton>
      </section>
    </div>
  );
}
