/** Maps database errors from membership RPCs to messages safe to show. */
export function friendlyMemberError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to do that.";
    case "28000":
      return "Please sign in again to continue.";
    case "23514":
      return "A wedding must keep at least one owner. Make someone else an owner first.";
    case "23505":
      return error.message?.includes("already a member")
        ? "That person is already a member of this wedding."
        : "An invitation for that email is already waiting. Revoke it first to send a new one.";
    case "55000":
      if (error.message?.includes("reload")) {
        return "This member changed while you were looking. Reload and try again.";
      }
      return "That change isn't possible right now.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "Something went wrong. Nothing was changed. Please try again.";
  }
}
