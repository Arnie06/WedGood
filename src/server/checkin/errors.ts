/** Maps database errors from check-in RPCs to messages safe to show. */
export function friendlyCheckInError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have access to check people in for this wedding.";
    case "28000":
      return "Please sign in again to continue.";
    case "CI422":
      return "That guest isn't invited to this event any more, so they can't be checked in. Reload to see the latest list.";
    case "CI423":
      return "That vendor isn't linked to this event any more. Reload to see the latest list.";
    case "54000":
      return "Check in up to 20 guests at a time.";
    case "22023":
      return "Choose at least one guest.";
    default:
      return "We couldn't save that. Try again.";
  }
}
