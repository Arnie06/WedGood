/** Maps database errors from guest RPCs to messages safe to show. */
export function friendlyGuestError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "Guests can only be managed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This guest or household changed or is no longer available. Reload to see the latest.";
    case "54000":
      return "Your guest list is at its limit of 2,000 active guests. Archive some to add more.";
    case "23505":
      return "A household with that name already exists, or this request was already used for different details.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
