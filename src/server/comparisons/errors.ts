/** Maps database errors from comparison RPCs to messages safe to show. */
export function friendlyComparisonError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to change comparisons. Ask the workspace owner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone changed this while you were looking. Reload to see the latest, then try again.";
    case "23505":
      return "This form was already used with different details. Reload and try again.";
    case "54000":
      return "That's the most this page can hold. Remove something before adding more.";
    case "22023":
    case "23514":
      return "Please check the details and try again. Quotes that were passed on or removed can't be compared.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
