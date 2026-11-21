/** Maps database errors from comment RPCs to messages safe to show. */
export function friendlyCommentError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "You can't do that with this comment.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This comment or the item it belongs to changed or is gone. Reload and try again.";
    case "54000":
      return "That's a lot of comments in a short time. Wait a moment and try again.";
    case "23505":
      return "This form was already used with different text. Reload and try again.";
    case "22023":
      return "Please check the comment and try again.";
    default:
      return "We couldn't save that. Your text is still here. Try again.";
  }
}
