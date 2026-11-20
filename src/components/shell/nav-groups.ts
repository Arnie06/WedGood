/**
 * R1 navigation groups (docs/04-UX-FLOWS.md). Paths are relative to the
 * workspace base path so the same shell serves /preview now and /app/[w] later.
 */
export type NavGroupKey = "home" | "discover" | "plan" | "guests" | "more";

export type NavTool = { name: string; description: string };

export type NavGroup = {
  key: NavGroupKey;
  label: string;
  segment: string;
  summary: string;
  tools: readonly NavTool[];
};

export const navGroups: readonly NavGroup[] = [
  {
    key: "home",
    label: "Home",
    segment: "",
    summary: "Your next steps and an overview of the plan.",
    tools: [],
  },
  {
    key: "discover",
    label: "Discover",
    segment: "discover",
    summary: "Gather venues and vendors you love, then compare them fairly.",
    tools: [
      {
        name: "Venues & vendors",
        description: "Save candidates with their source link, capacity and pricing details.",
      },
      {
        name: "Compare",
        description:
          "Line up two to four proposals on the same guest count, with unknown costs kept visible.",
      },
    ],
  },
  {
    key: "plan",
    label: "Plan",
    segment: "plan",
    summary: "Tasks, money, vendors and the day itself, all in one place.",
    tools: [
      {
        name: "Tasks & calendar",
        description: "A date-aware checklist and agenda you can adjust.",
      },
      {
        name: "Budget",
        description: "Targets, estimates, commitments and recorded payments, kept distinct.",
      },
      { name: "Vendor pipeline", description: "Track each vendor from first contact to booked." },
      { name: "Design", description: "Palettes, saved images and notes linked to vendors." },
      {
        name: "Documents",
        description: "Private contracts and proposals, linked where they matter.",
      },
      { name: "Wedding day", description: "An ordered timeline with owners and contacts." },
    ],
  },
  {
    key: "guests",
    label: "Guests",
    segment: "guests",
    summary: "Households, invitations, responses and seating.",
    tools: [
      { name: "Guest list", description: "People and households, with private details protected." },
      {
        name: "Invitations & RSVPs",
        description: "Event-specific invitations guests answer without an account.",
      },
      {
        name: "Seating",
        description: "Tables within capacity, with meal counts that stay current.",
      },
      { name: "Guest website", description: "Share only the details you choose to publish." },
    ],
  },
  {
    key: "more",
    label: "More",
    segment: "more",
    summary: "Packages for the people helping you, and workspace settings.",
    tools: [
      {
        name: "Packages",
        description: "Preview and create recipient-specific PDF and CSV handoffs.",
      },
      { name: "Settings", description: "Wedding details, collaborators and data export." },
    ],
  },
];

export function navHref(basePath: string, group: NavGroup): string {
  return group.segment ? `${basePath}/${group.segment}` : basePath;
}

export function getNavGroup(key: NavGroupKey): NavGroup {
  const group = navGroups.find((candidate) => candidate.key === key);
  if (!group) throw new Error(`Unknown navigation group ${key}`);
  return group;
}
