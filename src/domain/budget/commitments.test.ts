import { describe, expect, it } from "vitest";
import { summarizeCommitments } from "./commitments";

const venue = { id: "c1", amountMinor: 1_000_000, status: "active" as const };

describe("summarizeCommitments", () => {
  it("T04: book $10k, pay $2.5k, refund $500", () => {
    const summary = summarizeCommitments(
      [venue],
      [
        { id: "p1", commitmentId: "c1", kind: "charge", amountMinor: 250_000 },
        { id: "p2", commitmentId: "c1", kind: "refund", amountMinor: 50_000 },
      ],
    );
    expect(summary).toEqual({
      committedMinor: 1_000_000,
      netPaidMinor: 200_000,
      outstandingMinor: 800_000,
      overpaidMinor: 0,
    });
  });

  it("returns zeros with no commitments", () => {
    expect(summarizeCommitments([], [])).toEqual({
      committedMinor: 0,
      netPaidMinor: 0,
      outstandingMinor: 0,
      overpaidMinor: 0,
    });
  });

  it("flags overpayment separately instead of a negative balance", () => {
    const summary = summarizeCommitments(
      [venue],
      [{ id: "p1", commitmentId: "c1", kind: "charge", amountMinor: 1_100_000 }],
    );
    expect(summary.outstandingMinor).toBe(0);
    expect(summary.overpaidMinor).toBe(100_000);
  });

  it("excludes superseded and cancelled commitments from totals", () => {
    const summary = summarizeCommitments(
      [venue, { id: "c0", amountMinor: 900_000, status: "superseded" }],
      [],
    );
    expect(summary.committedMinor).toBe(1_000_000);
  });

  it("rejects refunds above the paid amount and invalid amounts", () => {
    expect(() =>
      summarizeCommitments(
        [venue],
        [{ id: "r", commitmentId: "c1", kind: "refund", amountMinor: 1 }],
      ),
    ).toThrow(/exceed/);
    expect(() =>
      summarizeCommitments(
        [venue],
        [{ id: "p", commitmentId: "c1", kind: "charge", amountMinor: 0 }],
      ),
    ).toThrow(/positive/);
    expect(() => summarizeCommitments([{ ...venue, amountMinor: 1.5 }], [])).toThrow(RangeError);
  });
});
