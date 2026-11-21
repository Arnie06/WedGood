/**
 * Suggested planning checklist. Every item has a stable `key` (never reuse or
 * rename one: it is how regeneration avoids duplicates) and a signed day offset
 * from the wedding date (negative = before). Generic starting points only, not
 * advice about any particular venue, vendor or contract.
 */
export type TemplatePhase =
  | "twelve-plus"
  | "nine-to-twelve"
  | "six-to-nine"
  | "three-to-six"
  | "final-weeks"
  | "wedding-week";

export type TemplateTask = {
  key: string;
  title: string;
  notes?: string;
  phase: TemplatePhase;
  /** Days relative to the wedding date; negative means before. */
  offsetDays: number;
};

export const PHASES: readonly { key: TemplatePhase; label: string }[] = [
  { key: "twelve-plus", label: "12 or more months out" },
  { key: "nine-to-twelve", label: "9 to 12 months out" },
  { key: "six-to-nine", label: "6 to 9 months out" },
  { key: "three-to-six", label: "3 to 6 months out" },
  { key: "final-weeks", label: "The final weeks" },
  { key: "wedding-week", label: "Wedding week" },
];

export const MAX_OFFSET_DAYS = 1500;

export const CHECKLIST_TEMPLATE: readonly TemplateTask[] = [
  {
    key: "decide-budget",
    title: "Talk through your budget and priorities",
    phase: "twelve-plus",
    offsetDays: -400,
  },
  {
    key: "draft-guest-list",
    title: "Draft a first guest list",
    notes: "A rough headcount is enough for now.",
    phase: "twelve-plus",
    offsetDays: -390,
  },
  {
    key: "choose-season-and-dates",
    title: "Shortlist possible dates",
    phase: "twelve-plus",
    offsetDays: -380,
  },
  { key: "tour-venues", title: "Visit and compare venues", phase: "twelve-plus", offsetDays: -365 },
  {
    key: "book-venue",
    title: "Decide on a venue",
    notes: "Record the booking once you have signed.",
    phase: "nine-to-twelve",
    offsetDays: -330,
  },
  {
    key: "shortlist-photographer",
    title: "Shortlist photographers and videographers",
    phase: "nine-to-twelve",
    offsetDays: -300,
  },
  {
    key: "shortlist-caterer",
    title: "Shortlist caterers or confirm the venue's catering",
    phase: "nine-to-twelve",
    offsetDays: -290,
  },
  {
    key: "choose-officiant",
    title: "Choose an officiant",
    phase: "nine-to-twelve",
    offsetDays: -280,
  },
  { key: "book-music", title: "Look into a band or DJ", phase: "six-to-nine", offsetDays: -240 },
  { key: "plan-attire", title: "Start looking at attire", phase: "six-to-nine", offsetDays: -230 },
  {
    key: "plan-florals-decor",
    title: "Gather florals and decor ideas",
    phase: "six-to-nine",
    offsetDays: -210,
  },
  {
    key: "plan-accommodation",
    title: "Arrange a room block or lodging ideas for guests",
    phase: "six-to-nine",
    offsetDays: -200,
  },
  {
    key: "plan-honeymoon",
    title: "Sketch out honeymoon plans",
    phase: "six-to-nine",
    offsetDays: -190,
  },
  {
    key: "finalize-guest-list",
    title: "Finalize the guest list and collect addresses",
    phase: "three-to-six",
    offsetDays: -150,
  },
  {
    key: "send-save-the-dates",
    title: "Send save-the-dates",
    phase: "three-to-six",
    offsetDays: -140,
  },
  {
    key: "order-invitations",
    title: "Design and order invitations",
    phase: "three-to-six",
    offsetDays: -120,
  },
  {
    key: "marriage-license",
    title: "Check marriage license requirements",
    notes: "Rules and timing vary by location. Confirm with the issuing office.",
    phase: "three-to-six",
    offsetDays: -100,
  },
  {
    key: "menu-tasting",
    title: "Schedule a menu tasting and confirm meal options",
    phase: "three-to-six",
    offsetDays: -90,
  },
  { key: "send-invitations", title: "Send invitations", phase: "final-weeks", offsetDays: -60 },
  {
    key: "plan-ceremony",
    title: "Outline the ceremony and write vows",
    phase: "final-weeks",
    offsetDays: -45,
  },
  {
    key: "rsvp-deadline",
    title: "Follow up on outstanding RSVPs",
    phase: "final-weeks",
    offsetDays: -28,
  },
  { key: "seating-plan", title: "Draft the seating plan", phase: "final-weeks", offsetDays: -21 },
  {
    key: "final-counts",
    title: "Give final headcounts to your vendors",
    phase: "final-weeks",
    offsetDays: -14,
  },
  {
    key: "share-day-of-timeline",
    title: "Share the day-of timeline with everyone helping",
    phase: "wedding-week",
    offsetDays: -7,
  },
  {
    key: "pack-for-the-day",
    title: "Pack your day-of essentials",
    phase: "wedding-week",
    offsetDays: -2,
  },
];

export function templateByKey(key: string): TemplateTask | undefined {
  return CHECKLIST_TEMPLATE.find((t) => t.key === key);
}

export function phaseLabel(phase: string): string {
  return PHASES.find((p) => p.key === phase)?.label ?? "Other";
}
