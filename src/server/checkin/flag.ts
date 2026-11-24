import "server-only";

/**
 * UX-17 release switch. Day-of check-in is off unless DAY_OF_CHECKIN=on. Off hides the page, its
 * links and the export, and makes the actions refuse. Arrivals already recorded stay in the
 * database untouched.
 */
export function checkInEnabled(): boolean {
  return process.env.DAY_OF_CHECKIN?.trim().toLowerCase() === "on";
}
