/** Maps database errors from plan RPCs to messages safe to show. */
export function friendlyPlanError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to change the plan. Ask the workspace owner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone changed this while you were looking. Reload to see the latest, then try again.";
    case "23505":
      return "This form was already used with different details. Reload and try again.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
