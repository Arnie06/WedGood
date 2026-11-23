import "server-only";

/**
 * UX-06 release switch. Party links are on unless RSVP_PARTY_LINKS=off. Off hides "One link for
 * all events" from planners and makes party links show the generic "isn't working" message;
 * per-event links are unaffected either way. Nothing in the database depends on this switch.
 */
export function partyLinksEnabled(): boolean {
  return process.env.RSVP_PARTY_LINKS?.trim().toLowerCase() !== "off";
}

/**
 * UX-07 release switch. The dietary and accessibility questions are asked unless
 * RSVP_GUEST_DETAILS=off. Off hides the step and makes the actions drop any such text; answers
 * already saved stay where they are, and the database does not depend on this switch.
 */
export function guestDetailsEnabled(): boolean {
  return process.env.RSVP_GUEST_DETAILS?.trim().toLowerCase() !== "off";
}

/**
 * UX-11 release switch. The couple's own RSVP questions are off unless RSVP_FORM_BUILDER=on. Off
 * hides the builder and the answers from planners, hides the questions from guests and makes the
 * actions send no answers and no form version (the database then accepts the reply as before).
 * Forms and answers already saved stay; the database does not depend on this switch.
 */
export function formBuilderEnabled(): boolean {
  return process.env.RSVP_FORM_BUILDER?.trim().toLowerCase() === "on";
}

/**
 * UX-16 release switch. Guests see "Add to calendar" on their confirmation unless
 * RSVP_ADD_TO_CALENDAR=off. The file is built in the guest's browser; nothing is stored.
 */
export function addToCalendarEnabled(): boolean {
  return process.env.RSVP_ADD_TO_CALENDAR?.trim().toLowerCase() !== "off";
}

/**
 * UX-16 release switch. The couple's guest email outbox (prepare, review, approve and send) is off
 * unless GUEST_EMAIL=on. Off hides the page and makes its actions refuse; messages already prepared
 * stay in the database untouched. Even when on, nothing reaches a guest unless a mail provider is
 * set up and the owner approves each message.
 */
export function guestEmailEnabled(): boolean {
  return process.env.GUEST_EMAIL?.trim().toLowerCase() === "on";
}
