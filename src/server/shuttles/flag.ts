import "server-only";

/**
 * UX-17 release switch. Guest shuttles are off unless GUEST_SHUTTLES=on. Off hides the page, the
 * event card and the export, and makes the actions refuse. Runs and riders already saved stay in
 * the database untouched, and replies keep releasing rides either way (the database does that).
 */
export function shuttlesEnabled(): boolean {
  return process.env.GUEST_SHUTTLES?.trim().toLowerCase() === "on";
}
