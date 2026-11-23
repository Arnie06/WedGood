/** Maps database errors from shuttle RPCs to messages safe to show. */
export function friendlyShuttleError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have access to arrange shuttles in this wedding.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This shuttle changed since you opened it. Reload to see the latest, then try again.";
    case "SH409":
      return "There aren't enough seats. Choose fewer guests, use another shuttle, or add seats to this one.";
    case "SH422":
      return "Only guests who are attending this event can ride. Someone you chose has declined, hasn't answered, or was removed.";
    case "23505":
      return "You already have a shuttle with that name for this event.";
    case "54000":
      return "You have reached a limit: 30 shuttles per event, or 20 guests at a time.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Try again.";
  }
}
