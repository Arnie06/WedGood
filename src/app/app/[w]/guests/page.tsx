import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { TrayButton } from "@/components/ui/tray";
import { Card, CardTitle } from "@/components/ui/card";
import { nameKey } from "@/domain/guests/import";
import { GuestFilters } from "@/features/guests/guest-filters";
import { GuestForm } from "@/features/guests/guest-forms";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";
import { loadGuests, type GuestRecord } from "@/server/guests/queries";

export const metadata: Metadata = { title: "Guest list" };

const link = "font-semibold text-action-emphasis underline underline-offset-4";

type Query = { q?: string; age?: string; tag?: string; view?: string };

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

  const data = await loadGuests(wid);
  const showArchived = query.view === "archived";
  const active = data.guests.filter((g) => !g.archived);
  const archivedCount = data.guests.length - active.length;
  const allTags = [...new Set(active.flatMap((g) => g.tags))].sort((a, b) => a.localeCompare(b));

  const q = (query.q ?? "").trim().slice(0, 100);
  const qKey = nameKey(q);
  const age = query.age === "adult" || query.age === "child" ? query.age : "";
  const tag = allTags.includes(query.tag ?? "") ? (query.tag ?? "") : "";
  const filtering = q !== "" || age !== "" || tag !== "";
  const matches = (g: GuestRecord) =>
    (qKey === "" ||
      nameKey(g.fullName).includes(qKey) ||
      (g.email ?? "").toLowerCase().includes(q.toLowerCase())) &&
    (age === "" || g.ageGroup === age) &&
    (tag === "" || g.tags.includes(tag));
  const visible = data.guests.filter((g) => g.archived === showArchived).filter(matches);

  const households = new Map(data.households.map((h) => [h.id, h]));
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

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-3">
        <h1 className="font-serif text-headline-mobile md:text-headline-lg">Guest list</h1>
        <p className="text-body-lg text-ink-muted">
          Everyone you may invite, grouped by household. Nothing is sent to anyone from here.
        </p>
        {active.length > 0 && (
          <p className="text-body-md text-ink-muted">
            {active.length} {active.length === 1 ? "guest" : "guests"} ·{" "}
            {new Set(active.map((g) => g.householdId).filter(Boolean)).size} households · {adults}{" "}
            {adults === 1 ? "adult" : "adults"} · {children} {children === 1 ? "child" : "children"}
            {active.length - adults - children > 0 &&
              ` · ${active.length - adults - children} not yet marked adult or child`}
          </p>
        )}
        <nav aria-label="Guest tools" className="flex flex-wrap gap-2">
          {[
            ["Invitations", `${base}/guests/invitations`],
            ["Seating", `${base}/seating`],
            ["Guest website", `${base}/website`],
          ].map(([label, href]) => (
            <Link
              key={href}
              href={href!}
              className={`${buttonClasses({ variant: "outline", size: "sm" })}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <section aria-label="Add guests" className="flex flex-wrap gap-3">
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
      </section>

      <section aria-labelledby="list" className="space-y-4">
        <h2 id="list" className="font-serif text-headline-sm">
          {showArchived ? "Archived guests" : "Your guests"}
        </h2>
        {data.guests.length > 0 && (
          <>
            <GuestFilters
              base={base}
              q={q}
              age={age}
              tag={tag}
              allTags={allTags}
              showArchived={showArchived}
              filtering={filtering}
            />

            <p role="status" className="text-body-sm text-ink-muted">
              Showing {visible.length} {visible.length === 1 ? "guest" : "guests"}
              {filtering ? " that match" : ""}.
            </p>
          </>
        )}

        {ordered.length === 0 ? (
          <Card>
            <p className="text-body-md text-ink-muted">
              {data.guests.length === 0
                ? "No guests yet. Use Add a guest above, or import a spreadsheet."
                : "No guests match. Try clearing the filters."}
            </p>
          </Card>
        ) : (
          <ul className="space-y-4">
            {ordered.map(([hid, members]) => {
              const h = households.get(hid);
              return (
                <li key={hid || "none"}>
                  <Card>
                    <CardTitle as="h3">{h ? h.name : "Individual guests"}</CardTitle>
                    {h && (
                      <p className="text-body-sm text-ink-muted">
                        {members.length} {members.length === 1 ? "person" : "people"} shown
                      </p>
                    )}
                    <ul className="mt-2 divide-y divide-border-hairline">
                      {members.map((g) => (
                        <li
                          key={g.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-1"
                        >
                          <Link
                            href={`${base}/guests/${g.id}`}
                            className={`${link} inline-flex min-h-11 items-center break-words`}
                          >
                            {g.fullName}
                          </Link>
                          <span className="flex flex-wrap items-center gap-2">
                            {g.ageGroup && (
                              <Badge tone="neutral">
                                {g.ageGroup === "adult" ? "Adult" : "Child"}
                              </Badge>
                            )}
                            {g.tags.map((t) => (
                              <Badge key={t} tone="ceremony">
                                {t}
                              </Badge>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-body-sm">
          <a href={`${base}/guests/export`} className={`${link} inline-flex min-h-11 items-center`}>
            Download the list as CSV
          </a>
        </p>
        <p className="text-body-sm text-ink-muted">
          {showArchived ? (
            <Link href={`${base}/guests`} className={link}>
              Back to your guests
            </Link>
          ) : archivedCount > 0 ? (
            <Link href={`${base}/guests?view=archived`} className={link}>
              View {archivedCount} archived {archivedCount === 1 ? "guest" : "guests"}
            </Link>
          ) : null}
        </p>
      </section>
    </div>
  );
}
