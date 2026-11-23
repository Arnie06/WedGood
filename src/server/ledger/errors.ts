/** Maps database errors from ledger RPCs to messages safe to show. */
export function friendlyLedgerError(error: { code?: string; message?: string }): string {
  const m = error.message ?? "";
  switch (error.code) {
    case "42501":
      return "You don't have permission to change bookings or payments. Ask the workspace owner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Someone changed this while you were looking. Reload to see the latest, then try again.";
    case "23505":
      if (m.includes("invoices_number_idx"))
        return "This booking already has an invoice with that number. Check for a double entry.";
      return "That reference or form was already used with different details. Reload and try again.";
    case "22023":
      if (m.includes("cost already booked"))
        return "One of those costs is already covered by another booking.";
      if (m.includes("cost has payments"))
        return "One of those costs already has payments recorded on its own. Void them first, or record future payments on the booking.";
      if (m.includes("cost is booked"))
        return "That cost is covered by a booking now. Record the payment on the booking instead.";
      if (m.includes("cost not available"))
        return "One of those costs is no longer available. Reload and choose again.";
      if (m.includes("allocations must add up"))
        return "The costs you list must add up to the total amount.";
      if (m.includes("stage not available"))
        return "This venue or vendor can't be booked from its current stage. Reopen it from Passed, or it may already be booked.";
      if (m.includes("quote not available"))
        return "That quote isn't available to book from. Reload and choose again.";
      if (m.includes("invoice not available"))
        return "That invoice isn't available for this booking. Reload and choose again.";
      if (m.includes("invalid invoice"))
        return "Please check the invoice details. The amount must be above zero and the due date can't be before the issue date.";
      if (m.includes("refund exceeds paid"))
        return "A refund can't be more than what's been paid so far.";
      if (m.includes("refunds depend on this payment"))
        return "Later refunds depend on this payment. Void those refunds first.";
      return "Please check the details and try again.";
    case "55006":
      return "The currency can't change once bookings or payments exist.";
    default:
      return "We couldn't save this change. Your details are still here. Try again.";
  }
}
