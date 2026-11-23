import { describe, expect, it } from "vitest";
import {
  addOption,
  addQuestion,
  answerText,
  canonical,
  cleanAnswers,
  definitionProblems,
  EMPTY_FORM,
  FORM_LIMITS,
  lockedTypes,
  missingRequired,
  moveQuestion,
  newKey,
  parseDefinition,
  publishChanges,
  removeOption,
  removeQuestion,
  sameDefinition,
  summarizeAnswers,
  updateOption,
  updateQuestion,
  type FormDefinition,
  type FormQuestion,
} from "./rsvp-form";

/** Deterministic "random" so generated keys are predictable. */
function seq(start = 0) {
  let i = start;
  return () => {
    i += 1;
    return ((i * 7) % 36) / 36;
  };
}

const text: FormQuestion = {
  key: "q_song0001",
  type: "text",
  label: "Song request?",
  help: null,
  required: false,
  options: [],
};
const shuttle: FormQuestion = {
  key: "q_shuttle1",
  type: "yes_no",
  label: "Need the shuttle?",
  help: "From the hotel",
  required: true,
  options: [],
};
const arrival: FormQuestion = {
  key: "q_arrive01",
  type: "choice",
  label: "When do you arrive?",
  help: null,
  required: false,
  options: [
    { key: "o_friday", label: "Friday" },
    { key: "o_satday", label: "Saturday" },
  ],
};
const form: FormDefinition = { questions: [text, shuttle, arrival] };

describe("keys", () => {
  it("makes keys the database accepts", () => {
    expect(newKey("q", seq())).toMatch(/^q_[a-z0-9]{8}$/);
    expect(newKey("o", seq())).toMatch(/^o_[a-z0-9]{6}$/);
  });
});

describe("editing", () => {
  it("adds questions up to the limit, choice questions with two empty choices", () => {
    let d = addQuestion(EMPTY_FORM, "choice", seq());
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]!.options).toHaveLength(2);
    expect(d.questions[0]!.required).toBe(false);
    for (let i = 0; i < 20; i += 1) d = addQuestion(d, "text", seq(i * 3));
    expect(d.questions).toHaveLength(FORM_LIMITS.questions);
    expect(new Set(d.questions.map((q) => q.key)).size).toBe(FORM_LIMITS.questions);
  });

  it("never reuses a key already in the form", () => {
    const same = () => 0;
    const once = addQuestion(EMPTY_FORM, "text", same);
    let calls = 0;
    const twice = addQuestion(once, "text", () => (calls++ < 8 ? 0 : 0.5));
    expect(twice.questions[0]!.key).not.toBe(twice.questions[1]!.key);
  });

  it("updates, moves and removes without touching the original", () => {
    const moved = moveQuestion(form, arrival.key, -1);
    expect(moved.questions.map((q) => q.key)).toEqual([text.key, arrival.key, shuttle.key]);
    expect(form.questions[1]).toBe(shuttle);
    expect(moveQuestion(form, text.key, -1)).toBe(form);
    expect(moveQuestion(form, arrival.key, 1)).toBe(form);
    expect(updateQuestion(form, text.key, { required: true }).questions[0]!.required).toBe(true);
    expect(removeQuestion(form, shuttle.key).questions).toHaveLength(2);
  });

  it("edits choices", () => {
    let d = addOption(form, arrival.key, seq());
    const added = d.questions[2]!.options[2]!;
    expect(added.label).toBe("");
    d = updateOption(d, arrival.key, added.key, "Sunday");
    expect(d.questions[2]!.options.map((o) => o.label)).toEqual(["Friday", "Saturday", "Sunday"]);
    d = removeOption(d, arrival.key, "o_friday");
    expect(d.questions[2]!.options.map((o) => o.label)).toEqual(["Saturday", "Sunday"]);
    // Choices only on choice questions.
    expect(addOption(form, text.key, seq())).toEqual(form);
  });
});

describe("definitionProblems", () => {
  it("accepts a good form", () => {
    expect(definitionProblems(form)).toEqual([]);
  });

  it("reports blank and long labels, long help and bad choices", () => {
    const bad: FormDefinition = {
      questions: [
        { ...text, label: "   " },
        { ...shuttle, label: "x".repeat(201), help: "y".repeat(301) },
        { ...arrival, options: [{ key: "o_aaaaaa", label: "Only" }] },
        {
          ...arrival,
          key: "q_arrive02",
          options: [
            { key: "o_aaaaaa", label: "Same" },
            { key: "o_bbbbbb", label: " same " },
          ],
        },
        {
          ...arrival,
          key: "q_arrive03",
          options: [
            { key: "o_aaaaaa", label: "One" },
            { key: "o_bbbbbb", label: "Two" },
            { key: "o_cccccc", label: "" },
          ],
        },
      ],
    };
    expect(definitionProblems(bad).map((p) => [p.key, p.field])).toEqual([
      [text.key, "label"],
      [shuttle.key, "label"],
      [shuttle.key, "help"],
      [arrival.key, "options"],
      ["q_arrive02", "options"],
      ["q_arrive03", "options"],
    ]);
  });
});

describe("canonical and comparison", () => {
  it("trims, collapses spaces, nulls blank help and drops options off non-choice questions", () => {
    const messy: FormDefinition = {
      questions: [
        {
          ...text,
          label: "  Song   request? ",
          help: "  ",
          options: [{ key: "o_zzzzzz", label: "x" }],
        },
        {
          ...arrival,
          options: [{ key: "o_friday", label: " Friday  night " }, arrival.options[1]!],
        },
      ],
    };
    const c = canonical(messy);
    expect(c.questions[0]).toEqual({ ...text, label: "Song request?" });
    expect(c.questions[1]!.options[0]!.label).toBe("Friday night");
    expect(sameDefinition(messy, c)).toBe(true);
    expect(sameDefinition(null, null)).toBe(true);
    expect(sameDefinition(form, null)).toBe(false);
  });
});

describe("parseDefinition", () => {
  it("reads a stored definition", () => {
    expect(parseDefinition(JSON.parse(JSON.stringify(form)))).toEqual(form);
    expect(parseDefinition({ questions: [] })).toEqual(EMPTY_FORM);
  });

  it.each([
    ["not an object", "x"],
    ["no questions", {}],
    ["bad key", { questions: [{ ...text, key: "song" }] }],
    ["duplicate key", { questions: [text, text] }],
    ["bad type", { questions: [{ ...text, type: "number" }] }],
    ["required not boolean", { questions: [{ ...text, required: "yes" }] }],
    ["bad option key", { questions: [{ ...arrival, options: [{ key: "friday", label: "F" }] }] }],
    [
      "too many",
      {
        questions: Array.from({ length: 11 }, (_, i) => ({
          ...text,
          key: `q_${String(i).padStart(8, "0")}`,
        })),
      },
    ],
  ])("refuses %s", (_name, raw) => {
    expect(parseDefinition(raw)).toBeNull();
  });
});

describe("publishChanges", () => {
  it("lists added, removed, edited and reordered questions", () => {
    expect(publishChanges(null, form).map((c) => c.kind)).toEqual(["added", "added", "added"]);
    expect(publishChanges(form, form)).toEqual([]);
    const next: FormDefinition = {
      questions: [arrival, { ...text, label: "Song you'd love to hear?" }],
    };
    expect(publishChanges(form, next)).toEqual([
      { kind: "edited", label: "Song you'd love to hear?" },
      { kind: "removed", label: "Need the shuttle?" },
      { kind: "reordered" },
    ]);
    // Whitespace-only edits are not changes.
    expect(
      publishChanges(form, {
        questions: [{ ...text, label: ` ${text.label} ` }, shuttle, arrival],
      }),
    ).toEqual([]);
  });
});

describe("lockedTypes", () => {
  it("keeps the first type a published key had", () => {
    const locked = lockedTypes([
      { questions: [text] },
      { questions: [{ ...text, type: "yes_no" }, shuttle] },
    ]);
    expect(locked.get(text.key)).toBe("text");
    expect(locked.get(shuttle.key)).toBe("yes_no");
    expect(locked.has(arrival.key)).toBe(false);
  });
});

describe("guest answers", () => {
  it("keeps only non-blank, valid answers to questions in the form", () => {
    expect(
      cleanAnswers(form, {
        [text.key]: "  Dancing Queen ",
        [shuttle.key]: "maybe",
        [arrival.key]: "o_friday",
        q_unknown1: "x",
      }),
    ).toEqual({ [text.key]: "Dancing Queen", [arrival.key]: "o_friday" });
    expect(cleanAnswers(form, { [text.key]: "x".repeat(600) })[text.key]).toHaveLength(500);
    expect(cleanAnswers(form, { [arrival.key]: "o_nope00" })).toEqual({});
    expect(cleanAnswers(form, undefined)).toEqual({});
  });

  it("counts a required question as done when typed now or stored earlier", () => {
    expect(missingRequired(form, {}, []).map((q) => q.key)).toEqual([shuttle.key]);
    expect(missingRequired(form, { [shuttle.key]: "no" }, [])).toEqual([]);
    expect(missingRequired(form, {}, [shuttle.key])).toEqual([]);
    expect(missingRequired(form, { [shuttle.key]: " " }, []).map((q) => q.key)).toEqual([
      shuttle.key,
    ]);
  });

  it("reads answers back as words", () => {
    expect(answerText(shuttle, "yes")).toBe("Yes");
    expect(answerText(arrival, "o_satday")).toBe("Saturday");
    expect(answerText(arrival, "o_gone00")).toBe("A choice no longer offered");
    expect(answerText(text, "Hi")).toBe("Hi");
  });
});

describe("summarizeAnswers", () => {
  it("tallies choices and lists text answers by name", () => {
    const rows = [
      { questionKey: shuttle.key, value: "yes", guestName: "Bo" },
      { questionKey: shuttle.key, value: "yes", guestName: "Ada" },
      { questionKey: shuttle.key, value: "no", guestName: "Cy" },
      { questionKey: arrival.key, value: "o_satday", guestName: "Ada" },
      { questionKey: arrival.key, value: "o_retired", guestName: "Bo" },
      { questionKey: text.key, value: "Song B", guestName: "Bo" },
      { questionKey: text.key, value: "Song A", guestName: "Ada" },
      { questionKey: "q_oldq0001", value: "ignored", guestName: "Ada" },
    ];
    const [t, s, a] = summarizeAnswers(form, rows);
    expect(t!.texts).toEqual([
      { name: "Ada", text: "Song A" },
      { name: "Bo", text: "Song B" },
    ]);
    expect(t!.tallies).toEqual([]);
    expect(s!.tallies).toEqual([
      { label: "Yes", count: 2 },
      { label: "No", count: 1 },
    ]);
    expect(a!.tallies).toEqual([
      { label: "Friday", count: 0 },
      { label: "Saturday", count: 1 },
      { label: "A choice no longer offered", count: 1 },
    ]);
    expect([t!.answered, s!.answered, a!.answered]).toEqual([2, 3, 2]);
  });
});
