import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
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
        <h2 id="details" className="font-serif text-headline-sm">
          Details
        </h2>
        <Card>
          {guest.archived ? (
            <p className="text-body-md text-ink-muted">Restore this guest to edit their details.</p>
          ) : (
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
          )}
        </Card>
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
            </div>
          </Card>
        </section>
      )}

      <section aria-labelledby="archive" className="space-y-3">
        <h2 id="archive" className="font-serif text-headline-sm">
          {guest.archived ? "Restore" : "Archive"}
        </h2>
        <Card>
          <ArchiveGuestForm
            workspaceId={wid}
            guestId={guest.id}
            version={guest.version}
            archived={guest.archived}
            name={guest.fullName}
          />
        </Card>
      </section>
    </div>
  );
}
