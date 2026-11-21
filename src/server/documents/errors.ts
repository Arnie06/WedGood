/** Maps database errors from document RPCs to messages safe to show. */
export function friendlyDocumentError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "Documents can only be managed by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "This document changed or is no longer available. Reload to see the latest.";
    case "54000":
      return "There are too many uploads in progress or stored. Wait a little or archive some documents.";
    case "22023":
      return "Please check the details and try again.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
