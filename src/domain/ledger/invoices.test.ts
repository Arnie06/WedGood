import { describe, expect, it } from "vitest";
import { summarizeBudget, type BudgetInput } from "@/domain/budget/summary";
import {
  bookingLadder,
  invoiceRows,
  invoiceWarning,
  parseInvoiceInput,
  type InvoicePayment,
  type InvoiceRecord,
} from "./invoices";

const inv = (
  over: Partial<InvoiceRecord> & Pick<InvoiceRecord, "id" | "amountMinor">,
): InvoiceRecord => ({
  commitmentId: "k1",
  number: null,
  issuedOn: null,
  dueOn: null,
  note: null,
  voided: false,
  voidReason: null,
  ...over,
});
const pay = (
  invoiceId: string | null,
  amountMinor: number,
  over: Partial<InvoicePayment> = {},
): InvoicePayment => ({ invoiceId, kind: "charge", amountMinor, voided: false, ...over });
const money = (n: number) => `$${n / 100}`;

describe("invoiceRows", () => {
  it("is unpaid, partly paid, paid and overpaid from the payments that name it", () => {
    const rows = invoiceRows(
      [
        inv({ id: "a", amountMinor: 600_000 }),
        inv({ id: "b", amountMinor: 600_000 }),
        inv({ id: "c", amountMinor: 600_000 }),
        inv({ id: "d", amountMinor: 600_000 }),
      ],
      [pay("b", 200_000), pay("c", 600_000), pay("d", 700_000), pay(null, 900_000)],
      "2027-01-01",
    );
    expect(rows.map((r) => [r.id, r.status, r.paidMinor, r.unpaidMinor, r.overpaidMinor])).toEqual([
      ["a", "unpaid", 0, 600_000, 0],
      ["b", "partly_paid", 200_000, 400_000, 0],
      ["c", "paid", 600_000, 0, 0],
      ["d", "paid", 700_000, 0, 100_000],
    ]);
  });

  it("ignores voided payments, and a payment that names no invoice", () => {
    const [a] = invoiceRows(
      [inv({ id: "a", amountMinor: 100_000 })],
      [pay("a", 100_000, { voided: true }), pay(null, 100_000)],
      "2027-01-01",
    );
    expect(a?.paidMinor).toBe(0);
    expect(a?.status).toBe("unpaid");
  });

  it("is overdue only when due before today and not fully paid", () => {
    const rows = invoiceRows(
      [
        inv({ id: "late", amountMinor: 100_000, dueOn: "2026-12-31" }),
        inv({ id: "today", amountMinor: 100_000, dueOn: "2027-01-01" }),
        inv({ id: "paid", amountMinor: 100_000, dueOn: "2026-12-31" }),
      ],
      [pay("paid", 100_000)],
      "2027-01-01",
    );
    expect(rows.map((r) => r.status)).toEqual(["overdue", "unpaid", "paid"]);
  });

  it("a void invoice asks for nothing", () => {
    const [v] = invoiceRows(
      [inv({ id: "v", amountMinor: 100_000, voided: true, dueOn: "2020-01-01" })],
      [],
      "2027-01-01",
    );
    expect(v).toMatchObject({ status: "void", unpaidMinor: 0, overpaidMinor: 0 });
  });

  it("refunds never reduce what an invoice has been paid", () => {
    const [a] = invoiceRows(
      [inv({ id: "a", amountMinor: 100_000 })],
      [pay("a", 100_000), pay("a", 50_000, { kind: "refund" })],
      "2027-01-01",
    );
    expect(a?.paidMinor).toBe(100_000);
  });
});

describe("bookingLadder (PDF section 8 test 5)", () => {
  const rows = invoiceRows(
    [
      inv({ id: "a", amountMinor: 600_000 }),
      inv({ id: "gone", amountMinor: 999_000, voided: true }),
    ],
    [pay("a", 400_000)],
    "2027-01-01",
  );

  it("reads contract, invoiced, paid, still to pay", () => {
    const l = bookingLadder(1_200_000, 400_000, rows);
    expect(l).toEqual({
      contractMinor: 1_200_000,
      invoicedMinor: 600_000,
      paidMinor: 400_000,
      stillToPayMinor: 800_000,
      invoicedUnpaidMinor: 200_000,
      notYetInvoicedMinor: 600_000,
      invoicedOverContractMinor: 0,
      paidWithoutInvoiceMinor: 0,
    });
  });

  it("an invoice does not change what is still to pay", () => {
    const none = bookingLadder(1_200_000, 400_000, []);
    const some = bookingLadder(1_200_000, 400_000, rows);
    expect(some.stillToPayMinor).toBe(none.stillToPayMinor);
    expect(some.contractMinor).toBe(none.contractMinor);
  });

  it("counts money paid that no invoice names", () => {
    const l = bookingLadder(1_200_000, 700_000, rows);
    expect(l.paidWithoutInvoiceMinor).toBe(300_000);
  });

  it("flags invoices that add up to more than the contract, and says nothing otherwise", () => {
    const big = invoiceRows([inv({ id: "x", amountMinor: 1_500_000 })], [], "2027-01-01");
    const l = bookingLadder(1_200_000, 0, big);
    expect(l.invoicedOverContractMinor).toBe(300_000);
    expect(l.notYetInvoicedMinor).toBe(0);
    expect(invoiceWarning(l, money)).toContain("$3000 more than the contract");
    expect(invoiceWarning(bookingLadder(1_200_000, 0, rows), money)).toBeNull();
  });
});

describe("invoices leave the budget forecast alone", () => {
  const base: BudgetInput = {
    targetMinor: 5_000_000,
    reserveBp: 1000,
    guestCount: 100,
    categories: [{ id: "c", name: "c", allocationMinor: null }],
    items: [
      {
        id: "venue",
        categoryId: "c",
        name: "Venue",
        costMode: "fixed",
        amountMinor: 1_000_000,
        quantity: null,
        minQty: null,
      },
    ],
    commitments: [{ id: "k1", amountMinor: 1_200_000, status: "active" }],
    allocations: [{ commitmentId: "k1", budgetItemId: "venue", amountMinor: 1_200_000 }],
    payments: [
      {
        id: "p1",
        commitmentId: "k1",
        budgetItemId: null,
        kind: "charge",
        amountMinor: 400_000,
        invoiceId: "a",
      },
    ],
  };
  const invoices = [
    { id: "a", commitmentId: "k1", amountMinor: 600_000, voided: false },
    { id: "old", commitmentId: "k1", amountMinor: 900_000, voided: true },
    { id: "other", commitmentId: "gone", amountMinor: 700_000, voided: false },
  ];

  it("changes only invoicedUnpaidMinor: open invoices on active bookings after their payments", () => {
    const without = summarizeBudget(base);
    const withInv = summarizeBudget({ ...base, invoices });
    expect(withInv.invoicedUnpaidMinor).toBe(200_000);
    expect({ ...withInv, invoicedUnpaidMinor: 0 }).toEqual({ ...without, invoicedUnpaidMinor: 0 });
    expect(without.invoicedUnpaidMinor).toBe(0);
  });

  it("a forecast change (guest count) moves neither invoices nor payments", () => {
    const a = summarizeBudget({ ...base, invoices, guestCount: 80 });
    const b = summarizeBudget({ ...base, invoices, guestCount: 140 });
    expect(a.committedMinor).toBe(b.committedMinor);
    expect(a.netPaidMinor).toBe(b.netPaidMinor);
    expect(a.invoicedUnpaidMinor).toBe(b.invoicedUnpaidMinor);
  });
});

describe("parseInvoiceInput", () => {
  it("parses into minor units and trims", () => {
    expect(
      parseInvoiceInput(
        {
          number: "  INV  101 ",
          amount: "6,000",
          issuedOn: "2027-01-05",
          dueOn: "2027-02-05",
          note: " ",
        },
        "USD",
      ),
    ).toEqual({
      ok: true,
      value: {
        number: "INV 101",
        amountMinor: 600_000,
        issuedOn: "2027-01-05",
        dueOn: "2027-02-05",
        note: null,
      },
    });
  });

  it("needs only an amount", () => {
    const r = parseInvoiceInput({ amount: "10" }, "USD");
    expect(r).toMatchObject({ ok: true, value: { number: null, issuedOn: null, dueOn: null } });
  });

  it.each([["0"], [""], ["abc"], ["-5"], ["2000000"]])("refuses amount %j", (amount) => {
    expect(parseInvoiceInput({ amount }, "USD").ok).toBe(false);
  });

  it("refuses a due date before the issue date, and impossible dates", () => {
    expect(
      parseInvoiceInput({ amount: "5", issuedOn: "2027-02-05", dueOn: "2027-02-04" }, "USD"),
    ).toMatchObject({ ok: false, errors: { dueOn: expect.any(String) } });
    expect(parseInvoiceInput({ amount: "5", dueOn: "2027-02-30" }, "USD")).toMatchObject({
      ok: false,
      errors: { dueOn: expect.any(String) },
    });
  });

  it("refuses a long number and a long note", () => {
    const r = parseInvoiceInput(
      { amount: "5", number: "x".repeat(61), note: "n".repeat(501) },
      "USD",
    );
    expect(r).toMatchObject({
      ok: false,
      errors: { number: expect.any(String), note: expect.any(String) },
    });
  });
});
