/** Maps database errors from timeline RPCs to messages safe to show. */
export function friendlyTimelineError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "The wedding-day agenda can only be changed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone changed this item, or the event's time zone, while you were looking. Reload to see the latest, then try again.";
    case "23503":
      return "That vendor or person is no longer available. Reload and choose again.";
    case "23505":
      return "This form was already used with different details. Reload and try again.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
