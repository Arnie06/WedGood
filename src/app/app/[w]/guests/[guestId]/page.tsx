import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { TrayButton } from "@/components/ui/tray";
import { ArchiveGuestForm, GuestForm, HouseholdForm } from "@/features/guests/guest-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadGuestPrivateDetails, loadGuests } from "@/server/guests/queries";

export const metadata: Metadata = { title: "Guest" };

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
  const details = canSeePrivate
    ? await loadGuestPrivateDetails(wid, guestId)
    : { dietary: null, accessibility: null, notes: null };
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
                      ["Dietary needs", details.dietary ?? "None noted"],
                      ["Accessibility needs", details.accessibility ?? "None noted"],
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
          )}
        </Card>
        {canSeePrivate && !guest.archived && (
          <p className="text-body-sm text-ink-muted">
            Dietary, accessibility and private notes are only visible to the owner and partner, and
            are left out of exports.
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
