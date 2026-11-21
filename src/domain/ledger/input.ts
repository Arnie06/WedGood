import { isDateOnly } from "@/domain/dates/date-only";
import { parseMajorToMinor } from "@/domain/wedding/settings";

export const MAX_LEDGER_MINOR = 100_000_000;
export const MAX_ALLOCATIONS = 10;
export const MAX_INSTALLMENTS = 24;
/** Rows shown in the booking forms. */
export const ALLOCATION_ROWS = 3;
export const INSTALLMENT_ROWS = 6;

const t = (v: string | null | undefined) => (v ?? "").trim();

// ---------------------------------------------------------------- booking and amendment

export type BookingAllocation = { itemId: string; amountMinor: number };
export type BookingInstallment = { dueOn: string; amountMinor: number; label: string | null };
export type BookingInput = {
  title: string;
  amountMinor: number;
  signedOn: string | null;
  allocations: BookingAllocation[];
  installments: BookingInstallment[];
  confirmed: boolean;
};

/** Form fields: title, amount, signedOn, confirm, allocItem{n}/allocAmount{n}, dueOn{n}/instAmount{n}/instLabel{n}. */
export type BookingField = string;
export type BookingParseResult =
  { ok: true; value: BookingInput } | { ok: false; errors: Record<BookingField, string> };

export function bookingFieldNames(): string[] {
  const names = ["title", "amount", "signedOn", "confirm"];
  for (let n = 0; n < ALLOCATION_ROWS; n++) names.push(`allocItem${n}`, `allocAmount${n}`);
  for (let n = 0; n < INSTALLMENT_ROWS; n++)
    names.push(`dueOn${n}`, `instAmount${n}`, `instLabel${n}`);
  return names;
}

function money(text: string, currency: string): number | null | undefined {
  const m = parseMajorToMinor(text, currency);
  if (m === undefined || (m !== null && m > MAX_LEDGER_MINOR)) return undefined;
  return m;
}

export function parseBookingInput(
  raw: Record<string, string | null | undefined>,
  currency: string,
  validItemIds: ReadonlySet<string>,
): BookingParseResult {
  const errors: Record<string, string> = {};
  const title = t(raw.title).replace(/\s+/g, " ");
  if (title === "") errors.title = "Give this booking a short name, like “Venue contract”.";
  else if (title.length > 160) errors.title = "Keep the name under 160 characters.";

  const amount = money(t(raw.amount), currency);
  if (amount === undefined || amount === null || amount <= 0) {
    errors.amount = "Enter the total you're committing to, like 12,000.";
  }

  const signedText = t(raw.signedOn);
  let signedOn: string | null = null;
  if (signedText !== "") {
    if (!isDateOnly(signedText) || signedText < "2000-01-01" || signedText > "2100-12-31") {
      errors.signedOn = "Enter a real date, or leave it blank.";
    } else signedOn = signedText;
  }

  const allocations: BookingAllocation[] = [];
  const seen = new Set<string>();
  for (let n = 0; n < ALLOCATION_ROWS; n++) {
    const item = t(raw[`allocItem${n}`]);
    const amountText = t(raw[`allocAmount${n}`]);
    if (item === "" && amountText === "") continue;
    const key = `allocAmount${n}`;
    if (item === "") {
      errors[`allocItem${n}`] = "Choose which cost this covers.";
      continue;
    }
    if (!validItemIds.has(item)) {
      errors[`allocItem${n}`] = "Choose one of your costs.";
      continue;
    }
    if (seen.has(item)) {
      errors[`allocItem${n}`] = "Each cost can only be listed once.";
      continue;
    }
    seen.add(item);
    // One cost covering the whole booking needs no second entry of the same amount.
    const onlyRow =
      n === 0 && t(raw.allocItem1) === "" && t(raw.allocAmount1) === "" && t(raw.allocItem2) === "";
    const a = onlyRow && amountText === "" ? amount : money(amountText, currency);
    if (a === undefined || a === null || a <= 0) {
      errors[key] = "Enter how much of the booking this cost covers.";
      continue;
    }
    allocations.push({ itemId: item, amountMinor: a });
  }
  if (allocations.length === 0 && !Object.keys(errors).some((k) => k.startsWith("alloc"))) {
    errors.allocItem0 = "Choose at least one cost this booking covers.";
  }
  if (
    amount !== undefined &&
    amount !== null &&
    !Object.keys(errors).some((k) => k.startsWith("alloc"))
  ) {
    const sum = allocations.reduce((s, a) => s + a.amountMinor, 0);
    if (sum !== amount) {
      errors.allocAmount0 = "The costs you list must add up to the total amount.";
    }
  }

  const installments: BookingInstallment[] = [];
  for (let n = 0; n < INSTALLMENT_ROWS; n++) {
    const due = t(raw[`dueOn${n}`]);
    const amountText = t(raw[`instAmount${n}`]);
    const label = t(raw[`instLabel${n}`]).replace(/\s+/g, " ");
    if (due === "" && amountText === "" && label === "") continue;
    if (due === "" || !isDateOnly(due) || due < "2000-01-01" || due > "2100-12-31") {
      errors[`dueOn${n}`] = "Enter the due date.";
      continue;
    }
    const a = money(amountText, currency);
    if (a === undefined || a === null || a <= 0) {
      errors[`instAmount${n}`] = "Enter the amount due on that date.";
      continue;
    }
    if (label.length > 80) {
      errors[`instLabel${n}`] = "Keep the label under 80 characters.";
      continue;
    }
    installments.push({ dueOn: due, amountMinor: a, label: label === "" ? null : label });
  }

  if (t(raw.confirm) !== "yes") {
    errors.confirm = "Confirm that this is signed or agreed, so it's recorded as a commitment.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      amountMinor: amount as number,
      signedOn,
      allocations,
      installments,
      confirmed: true,
    },
  };
}

// ---------------------------------------------------------------- payments

export type PaymentKind = "charge" | "refund";
export type PaymentField = "kind" | "amount" | "paidOn" | "method" | "note" | "externalRef";
export type PaymentInput = {
  kind: PaymentKind;
  amountMinor: number;
  paidOn: string;
  method: string | null;
  note: string | null;
  externalRef: string | null;
};
export type PaymentParseResult =
  { ok: true; value: PaymentInput } | { ok: false; errors: Partial<Record<PaymentField, string>> };

/** `today` is the wedding's today, so a payment can't be dated in the future. */
export function parsePaymentInput(
  raw: Partial<Record<PaymentField, string | null | undefined>>,
  currency: string,
  today: string,
): PaymentParseResult {
  const errors: Partial<Record<PaymentField, string>> = {};
  const kindText = t(raw.kind) || "charge";
  const kind: PaymentKind = kindText === "refund" ? "refund" : "charge";
  if (kindText !== "charge" && kindText !== "refund") errors.kind = "Choose payment or refund.";

  const amount = money(t(raw.amount), currency);
  if (amount === undefined || amount === null || amount <= 0) {
    errors.amount = "Enter an amount greater than zero, like 2,500.";
  }
  const paidOn = t(raw.paidOn);
  if (!isDateOnly(paidOn) || paidOn < "2000-01-01") {
    errors.paidOn = "Enter the date the money moved.";
  } else if (paidOn > today) {
    errors.paidOn = "Only record money that has already moved. Use a due date for future payments.";
  }
  const method = t(raw.method).replace(/\s+/g, " ");
  if (method.length > 60) errors.method = "Keep this under 60 characters.";
  const note = t(raw.note);
  if (note.length > 500) errors.note = "Keep notes under 500 characters.";
  const externalRef = t(raw.externalRef);
  if (externalRef.length > 120) errors.externalRef = "Keep the reference under 120 characters.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      amountMinor: amount as number,
      paidOn,
      method: method === "" ? null : method,
      note: note === "" ? null : note,
      externalRef: externalRef === "" ? null : externalRef,
    },
  };
}

/** The most that can still be refunded on a target (net paid). Never negative. */
export function refundableMinor(netPaidMinor: number): number {
  return Math.max(netPaidMinor, 0);
}
