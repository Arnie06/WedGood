/** Maps database errors from budget RPCs to messages safe to show. */
export function friendlyBudgetError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to change the budget. Ask the workspace owner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone changed this while you were looking. Reload to see the latest, then try again.";
    case "23505":
      return "This form was already used with different details. Reload and try again.";
    case "54000":
      return "You've reached the limit for this budget. Remove something you no longer need first.";
    case "22023":
      if (error.message?.includes("category name in use")) {
        return "You already have a category with that name.";
      }
      if (error.message?.includes("category still has costs")) {
        return "Move or remove the costs in this category first, so nothing drops out of your forecast.";
      }
      if (error.message?.includes("event not available")) {
        return "That event isn't available. Reload and choose another.";
      }
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
