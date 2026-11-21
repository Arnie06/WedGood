/** Maps database errors from seating RPCs to messages safe to show. */
export function friendlySeatingError(error: { code?: string }): string {
  switch (error.code) {
    case "42501":
      return "Seating can only be managed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "The plan changed since you opened it. Reload to see the latest, then try again.";
    case "SE409":
      return "That table doesn't have room. Choose another table, add one, or make this one larger.";
    case "SE422":
      return "That guest can't be seated right now. Only guests who are attending can be seated, and waiting guests only when tentative seating is on.";
    case "23505":
      return "That table name is already used, or that numbered seat is taken.";
    case "54000":
      return "You have reached the limit of 100 tables for this event.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Try again.";
  }
}
