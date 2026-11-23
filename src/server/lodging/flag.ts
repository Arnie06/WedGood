import "server-only";

/**
 * UX-17 lodging release switch. Off unless GUEST_LODGING=on. Off hides the Lodging page, the
 * Budget page's possible-costs card, the website's hotel option and the RSVP question, and makes
 * the actions refuse. Saved hotels, blocks and answers stay in the database untouched; a website
 * already published with hotels keeps them until it is published again.
 */
export function lodgingEnabled(): boolean {
  return process.env.GUEST_LODGING?.trim().toLowerCase() === "on";
}
