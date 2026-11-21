/**
 * "Next best actions" for the workspace home. Pure and deterministic: it only
 * orders prompts from facts the workspace already has, never invents a
 * default value or a deadline. Early on it guides setup; once the basics
 * exist, slipping tasks come first. Overdue work is never hidden during setup.
 */
export type HomeFacts = {
  hasDate: boolean;
  hasBudgetTarget: boolean;
  hasGuestTarget: boolean;
  checklistTotal: number;
  overdueCount: number;
  venueCount: number;
  guestCount: number;
  can: { settings: boolean; plan: boolean; guests: boolean; vendors: boolean };
};

export type HomeActionId =
  | "set-date"
  | "start-checklist"
  | "set-budget"
  | "set-guest-target"
  | "add-venue"
  | "add-guests"
  | "overdue";

export type HomeAction = {
  id: HomeActionId;
  title: string;
  reason: string;
  /** Link label; specific so it makes sense out of context. */
  cta: string;
  /** Path under the workspace base. */
  path: string;
  /** Quick actions are set inline on the home page instead of navigating. */
  inline?: "budget" | "guests";
};

export const MAX_HOME_ACTIONS = 3;

/** Setup is complete once the date, a budget target and some guest or venue information exist. */
export function isSetupStage(f: HomeFacts): boolean {
  const basics = f.hasDate && f.hasBudgetTarget && (f.hasGuestTarget || f.guestCount > 0);
  return !basics || f.checklistTotal === 0;
}

export function nextActions(f: HomeFacts): HomeAction[] {
  const setup: HomeAction[] = [];
  if (!f.hasDate && f.can.settings)
    setup.push({
      id: "set-date",
      cta: "Add your date",
      title: "Pick your wedding date",
      reason: "It gives your checklist real deadlines. Still deciding is fine, so skip it for now.",
      path: "settings/event",
    });
  if (f.checklistTotal === 0 && f.can.plan)
    setup.push({
      id: "start-checklist",
      cta: "Start the checklist",
      title: "Start your checklist",
      reason: "Begin with a suggested list, or add your own first task.",
      path: "plan",
    });
  if (!f.hasBudgetTarget && f.can.settings)
    setup.push({
      id: "set-budget",
      cta: "Set a budget target",
      title: "Set a budget target",
      reason: "Optional, and useful once you start comparing venues and quotes.",
      path: "settings/event",
      inline: "budget",
    });
  if (!f.hasGuestTarget && f.guestCount === 0 && f.can.settings)
    setup.push({
      id: "set-guest-target",
      cta: "Set a guest target",
      title: "Set a rough guest count",
      reason: "It helps with venue and catering estimates.",
      path: "settings/event",
      inline: "guests",
    });
  if (f.venueCount === 0 && f.can.vendors)
    setup.push({
      id: "add-venue",
      cta: "Save a venue",
      title: "Save a venue you love",
      reason: "Add a link or enter the details yourself. Nothing is checked for you.",
      path: "discover?addVenue=1",
    });
  if (f.guestCount === 0 && f.can.guests)
    setup.push({
      id: "add-guests",
      cta: "Add guests",
      title: "Start your guest list",
      reason: "Add people one at a time or import a spreadsheet. Nothing is sent to anyone.",
      path: "guests",
    });

  const overdue: HomeAction[] =
    f.overdueCount > 0
      ? [
          {
            id: "overdue",
            cta: "Review overdue items",
            title:
              f.overdueCount === 1
                ? "1 checklist item is overdue"
                : `${f.overdueCount} checklist items are overdue`,
            reason: "Do it, move it or mark it done.",
            path: "plan",
          },
        ]
      : [];

  const ordered = isSetupStage(f)
    ? [...setup.slice(0, 1), ...overdue, ...setup.slice(1)]
    : [...overdue, ...setup];
  return ordered.slice(0, MAX_HOME_ACTIONS);
}
