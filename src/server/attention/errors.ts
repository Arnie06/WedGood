/** Maps database errors from the attention RPCs to messages safe to show. */
export function friendlyAttentionError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "Only the workspace owner or a partner can change this list.";
    case "28000":
      return "Please sign in again to continue.";
    case "22023":
      return "That item can't be hidden. Reload the page and try again.";
    default:
      return "We couldn't save this change. Try again.";
  }
}
