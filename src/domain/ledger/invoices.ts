import { isDateOnly } from "@/domain/dates/date-only";
import { assertMinorUnits } from "@/domain/money/money";
import { parseMajorToMinor } from "@/domain/wedding/settings";

/**
 * Invoices (REL-09, ADR-031). An invoice is a vendor's request for money on one booking. It is not
 * the contract and it is not a payment: it never changes the committed amount or the budget
 * forecast, and it is only "paid" by recorded payments that name it. A booking reads as a ladder:
 * contract, invoiced, paid, still to pay.
 */

export const MAX_INVOICE_MINOR = 100_000_000;

export type InvoiceRecord = {
  id: string;
  commitmentId: string;
  number: string | null;
  amountMinor: number;
  issuedOn: string | null;
  dueOn: string | null;
  note: string | null;
  voided: boolean;
  voidReason: string | null;
};

/** The part of a payment that matters here. Only charges can name an invoice. */
export type InvoicePayment = {
  invoiceId: string | null;
  kind: "charge" | "refund";
  amountMinor: number;
  voided: boolean;
};

export type InvoiceStatus = "paid" | "overdue" | "partly_paid" | "unpaid" | "void";

export type InvoiceRow = InvoiceRecord & {
  /** Charges that name this invoice. Refunds cannot name an invoice. */
  paidMinor: number;
  /** Still to pay on this invoice. Zero when void or paid. */
  unpaidMinor: number;
  overpaidMinor: number;
  status: InvoiceStatus;
};

/** What each invoice has been paid, by the recorded payments that name it. */
export function invoiceRows(
  invoices: readonly InvoiceRecord[],
  payments: readonly InvoicePayment[],
  today: string,
): InvoiceRow[] {
  const paidBy = new Map<string, number>();
  for (const p of payments) {
    if (p.voided || p.invoiceId === null || p.kind !== "charge") continue;
    assertMinorUnits(p.amountMinor);
    paidBy.set(p.invoiceId, (paidBy.get(p.invoiceId) ?? 0) + p.amountMinor);
  }
  return invoices.map((inv) => {
    assertMinorUnits(inv.amountMinor);
    const paid = paidBy.get(inv.id) ?? 0;
    const unpaid = inv.voided ? 0 : Math.max(inv.amountMinor - paid, 0);
    let status: InvoiceStatus;
    if (inv.voided) status = "void";
    else if (paid >= inv.amountMinor) status = "paid";
    else if (inv.dueOn !== null && inv.dueOn < today) status = "overdue";
    else if (paid > 0) status = "partly_paid";
    else status = "unpaid";
    return {
      ...inv,
      paidMinor: paid,
      unpaidMinor: unpaid,
      overpaidMinor: inv.voided ? 0 : Math.max(paid - inv.amountMinor, 0),
      status,
    };
  });
}

export type Ladder = {
  /** What the booking commits to. Only an amendment changes it. */
  contractMinor: number;
  /** Invoices that are not void, added up. */
  invoicedMinor: number;
  /** Net paid on the booking: payments minus refunds, whether or not they name an invoice. */
  paidMinor: number;
  /** Contract minus net paid, never negative. Not reduced by invoices. */
  stillToPayMinor: number;
  /** What the open invoices still ask for after the payments that name them. */
  invoicedUnpaidMinor: number;
  /** Contract not yet invoiced. Zero when the invoices reach or pass the contract. */
  notYetInvoicedMinor: number;
  /** Invoices added up beyond the contract: a vendor billing for something not in the contract. */
  invoicedOverContractMinor: number;
  /** Net paid that no invoice names. */
  paidWithoutInvoiceMinor: number;
};

export function bookingLadder(
  contractMinor: number,
  netPaidMinor: number,
  rows: readonly InvoiceRow[],
): Ladder {
  assertMinorUnits(contractMinor);
  const live = rows.filter((r) => r.status !== "void");
  const invoiced = live.reduce((s, r) => s + r.amountMinor, 0);
  const onInvoices = live.reduce((s, r) => s + r.paidMinor, 0);
  return {
    contractMinor,
    invoicedMinor: invoiced,
    paidMinor: netPaidMinor,
    stillToPayMinor: Math.max(contractMinor - netPaidMinor, 0),
    invoicedUnpaidMinor: live.reduce((s, r) => s + r.unpaidMinor, 0),
    notYetInvoicedMinor: Math.max(contractMinor - invoiced, 0),
    invoicedOverContractMinor: Math.max(invoiced - contractMinor, 0),
    paidWithoutInvoiceMinor: Math.max(netPaidMinor - onInvoices, 0),
  };
}

/** A calm sentence when invoices add up to more than the contract, or null. */
export function invoiceWarning(ladder: Ladder, money: (n: number) => string): string | null {
  if (ladder.invoicedOverContractMinor <= 0) return null;
  return `Invoices add up to ${money(ladder.invoicedOverContractMinor)} more than the contract. If the vendor is billing for extras, amend the booking so your budget includes them.`;
}

// ---------------------------------------------------------------- input

export type InvoiceField = "number" | "amount" | "issuedOn" | "dueOn" | "note";
export type InvoiceInput = {
  number: string | null;
  amountMinor: number;
  issuedOn: string | null;
  dueOn: string | null;
  note: string | null;
};
export type InvoiceParseResult =
  { ok: true; value: InvoiceInput } | { ok: false; errors: Partial<Record<InvoiceField, string>> };

const t = (v: string | null | undefined) => (v ?? "").trim();
const validDate = (v: string) => isDateOnly(v) && v >= "2000-01-01" && v <= "2100-12-31";

export function parseInvoiceInput(
  raw: Partial<Record<InvoiceField, string | null | undefined>>,
  currency: string,
): InvoiceParseResult {
  const errors: Partial<Record<InvoiceField, string>> = {};
  const number = t(raw.number).replace(/\s+/g, " ");
  if (number.length > 60) errors.number = "Keep the invoice number under 60 characters.";

  const amount = parseMajorToMinor(t(raw.amount), currency);
  if (amount === undefined || amount === null || amount <= 0 || amount > MAX_INVOICE_MINOR) {
    errors.amount = "Enter the amount on the invoice, like 6,000.";
  }

  const issuedText = t(raw.issuedOn);
  const dueText = t(raw.dueOn);
  if (issuedText !== "" && !validDate(issuedText)) {
    errors.issuedOn = "Enter a real date, or leave it blank.";
  }
  if (dueText !== "" && !validDate(dueText)) {
    errors.dueOn = "Enter a real date, or leave it blank.";
  }
  if (
    errors.issuedOn === undefined &&
    errors.dueOn === undefined &&
    issuedText !== "" &&
    dueText !== "" &&
    dueText < issuedText
  ) {
    errors.dueOn = "The due date can't be before the date it was issued.";
  }
  const note = t(raw.note);
  if (note.length > 500) errors.note = "Keep notes under 500 characters.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      number: number === "" ? null : number,
      amountMinor: amount as number,
      issuedOn: issuedText === "" ? null : issuedText,
      dueOn: dueText === "" ? null : dueText,
      note: note === "" ? null : note,
    },
  };
}
