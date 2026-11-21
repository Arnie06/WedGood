/** Maps database errors from guest-website RPCs to messages safe to show. */
export function friendlyWebsiteError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "The guest website can only be changed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "The website changed in another window. Reload to see the latest, then try again.";
    case "23505":
      return "That web address is already taken. Choose another.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
