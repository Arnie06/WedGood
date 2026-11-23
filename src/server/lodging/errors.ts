/** Maps database errors from lodging RPCs to messages safe to show. */
export function friendlyLodgingError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have access to lodging in this wedding, or something you chose is no longer available.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This changed since you opened it. Reload to see the latest, then try again.";
    case "LG409":
      return "The hotel's pickup report is more than the room-nights this block holds. Check the rooms and dates, or update the report first.";
    case "54000":
      return "You have reached a limit: 30 hotels, 10 blocks per hotel, or 20 guests at a time.";
    case "23514":
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Try again.";
  }
}
