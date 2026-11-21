import { describe, expect, it } from "vitest";
import { addDays, parseDateOnly } from "@/domain/dates/date-only";
import { parseTaskInput } from "./input";
import { previewReschedule, relativeDueDate, type ScheduledTask } from "./schedule";
import { bucketFor, groupTasks, nextSteps, progress, type SummaryTask } from "./summary";
import { CHECKLIST_TEMPLATE, MAX_OFFSET_DAYS, PHASES } from "./templates";

describe("addDays", () => {
  it("crosses month, year and leap-day boundaries without host-zone drift", () => {
    expect(addDays(parseDateOnly("2027-03-01"), -1)).toBe("2027-02-28");
    expect(addDays(parseDateOnly("2028-03-01"), -1)).toBe("2028-02-29");
    expect(addDays(parseDateOnly("2027-12-31"), 1)).toBe("2028-01-01");
    expect(addDays(parseDateOnly("2027-06-15"), 0)).toBe("2027-06-15");
  });
  it("rejects fractional days", () => {
    expect(() => addDays(parseDateOnly("2027-06-15"), 1.5)).toThrow(RangeError);
  });
});

describe("checklist template", () => {
  it("has unique stable keys, bounded offsets and known phases", () => {
    const keys = CHECKLIST_TEMPLATE.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const phases = new Set(PHASES.map((p) => p.key));
    for (const t of CHECKLIST_TEMPLATE) {
      expect(t.key).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(phases.has(t.phase)).toBe(true);
      expect(Math.abs(t.offsetDays)).toBeLessThanOrEqual(MAX_OFFSET_DAYS);
      expect(t.title.length).toBeGreaterThan(0);
    }
  });
  it("is ordered from earliest to latest", () => {
    const offsets = CHECKLIST_TEMPLATE.map((t) => t.offsetDays);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});

describe("relativeDueDate", () => {
  it("is unscheduled when the wedding date is unknown", () => {
    expect(relativeDueDate(null, -30)).toBeNull();
  });
  it("counts back from the wedding date", () => {
    expect(relativeDueDate("2027-06-12", -30)).toBe("2027-05-13");
  });
});

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t",
    title: "T",
    status: "open",
    dateKind: "relative",
    offsetDays: -30,
    dueDate: "2027-05-13",
    version: 1,
    ...over,
  };
}

describe("previewReschedule (T13)", () => {
  it("moves open relative tasks and leaves fixed and completed tasks alone", () => {
    const p = previewReschedule("2027-07-12", [
      task({ id: "a" }),
      task({ id: "fixed", dateKind: "fixed", offsetDays: null, dueDate: "2027-05-13" }),
      task({ id: "done", status: "done" }),
    ]);
    expect(p.moves.map((m) => [m.task.id, m.from, m.to])).toEqual([
      ["a", "2027-05-13", "2027-06-12"],
    ]);
    expect(p.unchanged).toEqual({ fixed: 1, completed: 1, alreadyCurrent: 0 });
  });
  it("reports tasks already on the right date as unchanged", () => {
    const p = previewReschedule("2027-06-12", [task({})]);
    expect(p.moves).toEqual([]);
    expect(p.unchanged.alreadyCurrent).toBe(1);
  });
  it("proposes dates for unscheduled tasks once a date is set, and unschedules when cleared", () => {
    const set = previewReschedule("2027-06-12", [task({ dueDate: null })]);
    expect(set.moves[0]?.to).toBe("2027-05-13");
    const cleared = previewReschedule(null, [task({})]);
    expect(cleared.moves[0]?.to).toBeNull();
  });
});

function s(over: Partial<SummaryTask>): SummaryTask {
  return { id: "x", title: "X", status: "open", dueDate: null, order: 0, ...over };
}
const today = parseDateOnly("2027-01-10");

describe("task summary", () => {
  it("buckets by status and date; undated is never overdue", () => {
    expect(bucketFor(s({ dueDate: "2027-01-09" }), today)).toBe("overdue");
    expect(bucketFor(s({ dueDate: "2027-01-10" }), today)).toBe("upcoming");
    expect(bucketFor(s({ dueDate: null }), today)).toBe("unscheduled");
    expect(bucketFor(s({ status: "done", dueDate: "2020-01-01" }), today)).toBe("done");
  });
  it("orders next steps: overdue, then soonest, then undated in template order", () => {
    const tasks = [
      s({ id: "u2", order: 2 }),
      s({ id: "later", dueDate: "2027-03-01" }),
      s({ id: "late", dueDate: "2026-12-01" }),
      s({ id: "u1", order: 1 }),
      s({ id: "soon", dueDate: "2027-01-20" }),
      s({ id: "d", status: "done" }),
    ];
    expect(nextSteps(tasks, today, 10).map((t) => t.id)).toEqual([
      "late",
      "soon",
      "later",
      "u1",
      "u2",
    ]);
    expect(nextSteps(tasks, today, 3)).toHaveLength(3);
    expect(nextSteps(tasks, today, 0)).toEqual([]);
  });
  it("counts progress", () => {
    expect(progress([s({ status: "done" }), s({}), s({})])).toEqual({ done: 1, total: 3 });
    expect(progress([])).toEqual({ done: 0, total: 0 });
  });
  it("groups every task exactly once", () => {
    const g = groupTasks(
      [s({ id: "a" }), s({ id: "b", status: "done" }), s({ id: "c", dueDate: "2027-02-01" })],
      today,
    );
    expect(Object.values(g).flat()).toHaveLength(3);
  });
});

describe("parseTaskInput", () => {
  it("trims, nulls blanks and accepts a valid date", () => {
    expect(parseTaskInput({ title: "  Call florist ", notes: " ", dueDate: "" })).toEqual({
      ok: true,
      value: { title: "Call florist", notes: null, dueDate: null },
    });
    expect(parseTaskInput({ title: "A", dueDate: "2027-02-28" })).toMatchObject({ ok: true });
  });
  it("reports field errors", () => {
    const r = parseTaskInput({ title: " ", dueDate: "2027-02-30", notes: "x".repeat(2001) });
    expect(r).toEqual({
      ok: false,
      errors: expect.objectContaining({
        title: expect.any(String),
        dueDate: expect.any(String),
        notes: expect.any(String),
      }),
    });
    expect(parseTaskInput({ title: "x".repeat(161) }).ok).toBe(false);
  });
});
