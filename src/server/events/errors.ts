/** Maps database errors from event and invitation RPCs to messages safe to show. */
export function friendlyEventError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "Events and invitations can only be managed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This changed or is no longer available. Reload to see the latest.";
    case "54000":
      return "You have reached a limit (12 events, 20 meal options per event, or 2,000 guests).";
    case "23505":
      return "That name is already used, a chosen guest is already invited to this event, or this request was already used for different details.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}

/** Public RSVP errors. Wording never says why a link failed. */
export function friendlyRsvpError(error: { code?: string }): string {
  switch (error.code) {
    case "55000":
      return "This invitation was updated since you opened it. We've loaded the latest. Please check your answers and send again.";
    case "RS410":
      return "The response deadline has passed. Please contact the couple to change an answer.";
    case "RS422":
      return "This invitation has no plus-one left to add.";
    case "RS429":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "54000":
      return "We couldn't add another guest right now. Please contact the couple.";
    case "22023":
      return "Please check your answers and try again.";
    default:
      return "We couldn't save your response. Please try again.";
  }
}
