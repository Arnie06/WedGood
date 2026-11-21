import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/domain/dates/date-only";
import { isOverdue } from "./format";

const today = parseDateOnly("2027-03-10");

describe("isOverdue", () => {
  it("is true only for an open task dated before today", () => {
    expect(isOverdue("2027-03-09", today)).toBe(true);
    expect(isOverdue("2020-01-01", today)).toBe(true);
  });

  it("is false for today, the future, and undated tasks (unknown is not overdue)", () => {
    expect(isOverdue("2027-03-10", today)).toBe(false);
    expect(isOverdue("2027-03-11", today)).toBe(false);
    expect(isOverdue(null, today)).toBe(false);
  });

  it("is false once the task is done", () => {
    expect(isOverdue("2027-03-09", today, true)).toBe(false);
  });
});
