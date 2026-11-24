import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WorkspacePageHeading } from "@/components/shell/workspace-page-heading";
import type { Capability } from "@/domain/permissions";
import { getNavGroup } from "@/components/shell/nav-groups";
import { hasCapability, requireWorkspace } from "@/server/auth/workspace-guard";

export const metadata: Metadata = { title: "More" };

type MoreLink = {
  name: string;
  description: string;
  href: string;
  /** Hidden (not just disabled) when the member lacks it; the page re-checks anyway. */
  capability?: Capability;
};

const sections: ReadonlyArray<{ id: string; title: string; links: readonly MoreLink[] }> = [
  {
    id: "plan-share",
    title: "Plan and share",
    links: [
      {
        name: "Packages",
        description: "Preview and create recipient-specific PDF and CSV handoffs.",
        href: "plan/packages",
        capability: "exports.create",
      },
      {
        name: "Wedding day",
        description: "An ordered timeline with owners and contacts.",
        href: "plan/day-of",
      },
      {
        name: "Documents",
        description: "Private contracts and proposals, linked where they matter.",
        href: "plan/documents",
        capability: "budget.manage",
      },
      {
        name: "Design",
        description: "Palettes, saved images and notes linked to vendors.",
        href: "design",
      },
      {
        name: "Shared with you",
        description: "Choices and comments others have asked you to look at.",
        href: "shared",
      },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    links: [
      {
        name: "Event details",
        description: "Your date, location, budget and guest targets.",
        href: "settings/event",
      },
      {
        name: "People and access",
        description: "Invite your partner and helpers, and choose what each can do.",
        href: "settings/members",
        capability: "members.view",
      },
      {
        name: "All workspaces",
        description: "Switch weddings or start a new workspace.",
        href: "/app?all=1",
      },
    ],
  },
];

export default async function MorePage({ params }: { params: Promise<{ w: string }> }) {
  const access = await requireWorkspace((await params).w);
  const base = `/app/${access.wedding.id}`;
  const group = getNavGroup("more");

  return (
    <div className="space-y-8">
      <WorkspacePageHeading title={group.label} />
      <div className="grid items-start gap-5 md:grid-cols-2">
        {sections.map((section) => {
          const links = section.links.filter(
            (link) => !link.capability || hasCapability(access, link.capability),
          );
          if (links.length === 0) return null;
          return (
            <section
              key={section.title}
              aria-labelledby={`more-${section.id}`}
              className="space-y-3"
            >
              <h2 id={`more-${section.id}`} className="font-serif text-headline-sm">
                {section.title}
              </h2>
              <ul className="record-list">
                {links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href.startsWith("/") ? link.href : `${base}/${link.href}`}
                      className="flex min-h-16 items-center justify-between gap-4 rounded-card px-4 py-3 hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 space-y-1">
                        <span className="block text-body-md font-semibold text-action-emphasis">
                          {link.name}
                        </span>
                        <span className="block text-body-sm text-ink-muted">
                          {link.description}
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-ink-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
