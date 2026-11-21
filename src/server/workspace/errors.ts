/** Maps database errors from workspace RPCs to messages safe to show. */
export function friendlyWorkspaceError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to change these details. Ask the workspace owner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone updated these details while you were editing. Reload to see the latest version, then re-apply your change.";
    case "23505":
      return "This form was already used with different details. Go back to your workspaces to find it.";
    case "55006":
      return "The currency can't change while your budget has amounts, because they would silently be read in a different currency. Remove or re-enter the budget amounts first.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
