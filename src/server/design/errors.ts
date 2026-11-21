/** Maps database errors from design-board RPCs to messages safe to show. */
export function friendlyDesignError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "Design boards can only be changed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This board or item changed, or is no longer available. Reload to see the latest, then try again.";
    case "54000":
      return "There are too many boards, items or uploads in progress. Remove some or wait a little.";
    case "23503":
      return "That vendor is no longer available. Reload and choose again.";
    case "23505":
      return "This form was already used with different details. Reload and try again.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
