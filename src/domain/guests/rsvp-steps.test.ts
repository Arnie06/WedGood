import { describe, expect, it } from "vitest";
import {
  applicableSteps,
  buildSubmission,
  cleanDetails,
  DETAILS_MAX,
  draftFromFacts,
  initialStep,
  nextStep,
  plusOnePlaces,
  previousStep,
  NEW_PLUS_ONE,
  questionPeople,
  removedPlusOnes,
  reviewLines,
  SAVED_ANSWERS,
  SAVED_NOTES,
  skippedNotes,
  validateStep,
  type RsvpDraft,
  type RsvpFacts,
} from "./rsvp-steps";

const yesPlusOne = { bringing: true, name: "", mealOptionId: null, dietary: "", accessibility: "" };

const ada = {
  id: "a",
  name: "Ada",
  isPlusOne: false,
  status: "pending" as const,
  mealOptionId: null,
};
const bo = {
  id: "b",
  name: "Bo",
  isPlusOne: false,
  status: "pending" as const,
  mealOptionId: null,
};

function facts(over: Partial<RsvpFacts> = {}): RsvpFacts {
  return {
    members: [ada, bo],
    mealOptions: [
      { id: "fish", name: "Fish" },
      { id: "veg", name: "Vegetarian" },
    ],
    plusOneRemaining: 1,
    closed: false,
    ...over,
  };
}

function withAnswers(
  f: RsvpFacts,
  answers: RsvpDraft["answers"],
  plusOne?: Partial<RsvpDraft["plusOne"]>,
): RsvpDraft {
  const d = draftFromFacts(f);
  return { ...d, answers: { ...d.answers, ...answers }, plusOne: { ...d.plusOne, ...plusOne } };
}

describe("applicableSteps", () => {
  it("asks about meals and a plus-one only when someone attends", () => {
    const f = facts();
    expect(applicableSteps(f, draftFromFacts(f))).toEqual(["attendance", "review"]);
    const yes = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(applicableSteps(f, yes)).toEqual(["attendance", "meals", "plusOne", "review"]);
    const no = withAnswers(f, {
      a: { status: "declined", mealOptionId: null },
      b: { status: "declined", mealOptionId: null },
    });
    expect(applicableSteps(f, no)).toEqual(["attendance", "review"]);
  });

  it("leaves out steps the event does not offer", () => {
    const f = facts({ mealOptions: [], plusOneRemaining: 0 });
    const yes = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(applicableSteps(f, yes)).toEqual(["attendance", "review"]);
  });

  it("moves forward and back over the steps that apply", () => {
    const f = facts({ plusOneRemaining: 0 });
    const yes = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(nextStep(f, yes, "attendance")).toBe("meals");
    expect(nextStep(f, yes, "meals")).toBe("review");
    expect(previousStep(f, yes, "review")).toBe("meals");
    expect(previousStep(f, yes, "attendance")).toBe("attendance");
    const none = draftFromFacts(f);
    expect(nextStep(f, none, "attendance")).toBe("review");
  });
});

describe("initialStep", () => {
  it("opens Review for a returning guest and the summary after the deadline", () => {
    expect(initialStep(facts())).toBe("attendance");
    expect(initialStep(facts({ members: [{ ...ada, status: "declined" }, bo] }))).toBe("review");
    expect(initialStep(facts({ closed: true }))).toBe("closed");
  });
});

describe("skippedNotes", () => {
  it("explains skipped steps only when nobody attends", () => {
    const f = facts();
    expect(
      skippedNotes(f, withAnswers(f, { a: { status: "accepted", mealOptionId: null } })),
    ).toEqual([]);
    expect(
      skippedNotes(f, withAnswers(f, { a: { status: "declined", mealOptionId: null } })),
    ).toHaveLength(2);
    const plain = facts({ mealOptions: [], plusOneRemaining: 0 });
    expect(skippedNotes(plain, draftFromFacts(plain))).toEqual([]);
  });
});

describe("validateStep", () => {
  it("needs at least one answer and a name for a plus-one", () => {
    const f = facts();
    expect(validateStep(f, draftFromFacts(f), "attendance")?.field).toBe("attendance");
    const yes = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(validateStep(f, yes, "attendance")).toBeNull();
    expect(
      validateStep(f, { ...yes, plusOne: { ...yesPlusOne, bringing: true, name: "  " } }, "plusOne")
        ?.field,
    ).toBe("plusOneName");
    expect(
      validateStep(
        f,
        { ...yes, plusOne: { ...yesPlusOne, bringing: true, name: "x".repeat(121) } },
        "plusOne",
      ),
    ).not.toBeNull();
    expect(
      validateStep(f, { ...yes, plusOne: { ...yesPlusOne, bringing: false, name: "" } }, "plusOne"),
    ).toBeNull();
  });
});

describe("buildSubmission", () => {
  it("drops meals for declines, leaves unanswered people out and sends one plus-one", () => {
    const f = facts();
    const d = withAnswers(
      f,
      {
        a: { status: "accepted", mealOptionId: "fish" },
        b: { status: "declined", mealOptionId: "veg" },
      },
      { bringing: true, name: "  Cy   Example ", mealOptionId: "veg" },
    );
    expect(buildSubmission(f, d)).toEqual({
      responses: [
        { memberId: "a", status: "accepted", mealOptionId: "fish" },
        { memberId: "b", status: "declined", mealOptionId: null },
      ],
      plusOne: { name: "Cy Example", mealOptionId: "veg" },
      formVersionId: null,
    });
    const partial = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(buildSubmission(f, partial).responses).toHaveLength(1);
  });

  it("drops a plus-one entered earlier once nobody attends", () => {
    const f = facts();
    const d = withAnswers(
      f,
      { a: { status: "declined", mealOptionId: null } },
      { bringing: true, name: "Cy", mealOptionId: null },
    );
    expect(buildSubmission(f, d).plusOne).toBeNull();
    expect(
      buildSubmission(f, { ...d, plusOne: { ...yesPlusOne, bringing: false, name: "Cy" } }).plusOne,
    ).toBeNull();
  });

  it("sends no meal when the event has no meal choices", () => {
    const f = facts({ mealOptions: [] });
    const d = withAnswers(f, { a: { status: "accepted", mealOptionId: "fish" } });
    expect(buildSubmission(f, d).responses[0]?.mealOptionId).toBeNull();
  });
});

describe("draftFromFacts and reviewLines", () => {
  it("starts from saved answers and does not carry a retired meal", () => {
    const f = facts({
      members: [
        { ...ada, status: "accepted", mealOptionId: "fish" },
        { ...bo, status: "accepted", mealOptionId: "retired" },
      ],
    });
    const d = draftFromFacts(f);
    expect(d.answers.a).toEqual({ status: "accepted", mealOptionId: "fish" });
    expect(d.answers.b).toEqual({ status: "accepted", mealOptionId: null });
  });

  it("reads back each person and the new guest", () => {
    const f = facts({
      members: [
        ada,
        bo,
        { id: "p", name: "Di", isPlusOne: true, status: "declined", mealOptionId: null },
      ],
    });
    const d = withAnswers(
      f,
      { a: { status: "accepted", mealOptionId: "fish" } },
      { bringing: true, name: "Cy", mealOptionId: null },
    );
    expect(reviewLines(f, d)).toEqual([
      { key: "a", name: "Ada", answer: "Attending", meal: "Fish" },
      { key: "b", name: "Bo", answer: "No answer yet", meal: null },
      { key: "p", name: "Di (plus-one)", answer: "Will be removed", meal: null },
      {
        key: "new-plus-one",
        name: "Cy (your guest)",
        answer: "Attending",
        meal: "Meal not chosen yet",
      },
    ]);
  });
});

describe("dietary and accessibility notes (UX-07)", () => {
  const asking = (over: Partial<RsvpFacts> = {}) => facts({ askDetails: true, ...over });
  const typed = (
    f: RsvpFacts,
    notes: Record<string, { dietary: string; accessibility: string }>,
  ) => ({
    ...withAnswers(f, {
      a: { status: "accepted", mealOptionId: "fish" },
      b: { status: "declined", mealOptionId: null },
    }),
    details: notes,
  });

  it("adds a notes step between meals and the plus-one only when asked and someone attends", () => {
    const f = asking();
    expect(applicableSteps(f, draftFromFacts(f))).toEqual(["attendance", "review"]);
    expect(applicableSteps(f, typed(f, {}))).toEqual([
      "attendance",
      "meals",
      "details",
      "plusOne",
      "review",
    ]);
    // Switched off (or never offered): the steps are exactly what UX-03 had.
    const off = facts();
    expect(applicableSteps(off, typed(off, {}))).toEqual([
      "attendance",
      "meals",
      "plusOne",
      "review",
    ]);
    // Nobody attending: nothing to ask.
    const no = withAnswers(f, { a: { status: "declined", mealOptionId: null } });
    expect(applicableSteps(f, no)).toEqual(["attendance", "review"]);
  });

  it("sends trimmed notes for attending people only, and leaves blanks out", () => {
    const f = asking();
    const d = typed(f, {
      a: { dietary: "  No peanuts  ", accessibility: "   " },
      // Typed, then changed to not attending: nothing is sent for a decline.
      b: { dietary: "Vegan", accessibility: "Step-free access" },
    });
    expect(buildSubmission(f, d).responses).toEqual([
      { memberId: "a", status: "accepted", mealOptionId: "fish", dietary: "No peanuts" },
      { memberId: "b", status: "declined", mealOptionId: null },
    ]);
  });

  it("sends no notes at all when the questions are off", () => {
    const f = facts();
    const d = typed(f, { a: { dietary: "No peanuts", accessibility: "Hearing loop" } });
    expect(buildSubmission(f, d).responses[0]).toEqual({
      memberId: "a",
      status: "accepted",
      mealOptionId: "fish",
    });
  });

  it("carries the new guest's notes with their name", () => {
    const f = asking();
    const d = withAnswers(
      f,
      { a: { status: "accepted", mealOptionId: null } },
      { bringing: true, name: " Cy ", dietary: "Gluten free", accessibility: "" },
    );
    expect(buildSubmission(f, d).plusOne).toEqual({
      name: "Cy",
      mealOptionId: null,
      dietary: "Gluten free",
    });
    const off = facts();
    expect(buildSubmission(off, { ...d, plusOne: { ...d.plusOne } }).plusOne).toEqual({
      name: "Cy",
      mealOptionId: null,
    });
  });

  it("cuts text at the stored limit", () => {
    const long = "x".repeat(DETAILS_MAX + 40);
    expect(cleanDetails({ dietary: long, accessibility: "" }).dietary).toHaveLength(DETAILS_MAX);
  });

  it("reads back what is about to be sent, and only says 'saved' for what was saved earlier", () => {
    const savedAda = { ...ada, detailsSaved: true };
    const f = asking({ members: [savedAda, bo] });
    const d = typed(f, { b: { dietary: "Vegan", accessibility: "" } });
    // Ada attends with notes saved earlier and none typed now: the text is not available, only the fact.
    expect(reviewLines(f, d).map((l) => l.notes)).toEqual([SAVED_NOTES, undefined]);
    const again = typed(f, { a: { dietary: "Nuts", accessibility: "Ramp" } });
    expect(reviewLines(f, again)[0]?.notes).toBe("Food: Nuts · Access: Ramp");
    // Not attending: saved notes are not mentioned.
    const declined = withAnswers(f, { a: { status: "declined", mealOptionId: null } });
    expect(reviewLines(f, declined)[0]?.notes).toBeUndefined();
  });
});

describe("removing a plus-one the guest added (UX-09)", () => {
  const di = {
    id: "p",
    name: "Di",
    isPlusOne: true,
    status: "accepted" as const,
    mealOptionId: null,
  };
  const withDi = (over: Partial<RsvpFacts> = {}) =>
    facts({ members: [ada, di], plusOneRemaining: 0, ...over });
  const answered = (f: RsvpFacts, di: "accepted" | "declined") =>
    withAnswers(f, {
      a: { status: "accepted", mealOptionId: null },
      p: { status: di, mealOptionId: null },
    });

  it("marks a declined plus-one for removal and nobody else", () => {
    const f = withDi();
    const sub = buildSubmission(f, answered(f, "declined"));
    expect(sub.responses).toEqual([
      { memberId: "a", status: "accepted", mealOptionId: null },
      { memberId: "p", status: "declined", mealOptionId: null, remove: true },
    ]);
    // A plus-one who stays is a plain answer, and an invited person who declines is not removed.
    expect(buildSubmission(f, answered(f, "accepted")).responses.some((r) => "remove" in r)).toBe(
      false,
    );
    const g = withDi();
    const d = withAnswers(g, {
      a: { status: "declined", mealOptionId: null },
      p: { status: "accepted", mealOptionId: null },
    });
    expect(buildSubmission(g, d).responses.some((r) => "remove" in r)).toBe(false);
  });

  it("does not mark someone who has not been answered for", () => {
    const f = withDi({ members: [ada, { ...di, status: "pending" }] });
    const d = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(buildSubmission(f, d).responses).toEqual([
      { memberId: "a", status: "accepted", mealOptionId: null },
    ]);
  });

  it("counts the place a removal frees, so someone else can be named in the same send", () => {
    const f = withDi();
    expect(plusOnePlaces(f, answered(f, "accepted"))).toBe(0);
    expect(plusOnePlaces(f, answered(f, "declined"))).toBe(1);
    expect(applicableSteps(f, answered(f, "accepted"))).not.toContain("plusOne");
    expect(applicableSteps(f, answered(f, "declined"))).toContain("plusOne");
    const d = {
      ...answered(f, "declined"),
      plusOne: { ...yesPlusOne, name: "Eve" },
    };
    const sub = buildSubmission(f, d);
    expect(sub.plusOne).toMatchObject({ name: "Eve" });
    expect(removedPlusOnes(f, d).map((m) => m.name)).toEqual(["Di"]);
  });

  it("still needs someone attending before a new guest can be added", () => {
    const f = withDi();
    const d = withAnswers(f, {
      a: { status: "declined", mealOptionId: null },
      p: { status: "declined", mealOptionId: null },
    });
    expect(applicableSteps(f, d)).not.toContain("plusOne");
  });

  it("says 'Will be removed' in Review and plain 'Not attending' for what is saved", () => {
    const f = withDi({ members: [ada, { ...di, status: "declined" }] });
    const d = answered(f, "declined");
    expect(reviewLines(f, d)[1]?.answer).toBe("Will be removed");
    expect(reviewLines(f, d, "saved")[1]?.answer).toBe("Not attending");
    // A person the couple invited is never "removed".
    const g = facts();
    const dg = withAnswers(g, { a: { status: "declined", mealOptionId: null } });
    expect(reviewLines(g, dg)[0]?.answer).toBe("Not attending");
  });
});

describe("the couple's own questions (UX-11)", () => {
  const form = {
    versionId: "v-1",
    version: 2,
    questions: [
      {
        key: "q_shuttle1",
        type: "yes_no" as const,
        label: "Need the shuttle?",
        help: null,
        required: true,
        options: [],
      },
      {
        key: "q_song0001",
        type: "text" as const,
        label: "Song request",
        help: null,
        required: false,
        options: [],
      },
    ],
  };
  const withForm = (over: Partial<RsvpFacts> = {}) => facts({ form, mealOptions: [], ...over });
  const typed = (d: RsvpDraft, person: string, key: string, value: string): RsvpDraft => ({
    ...d,
    custom: { ...d.custom, [person]: { ...d.custom[person], [key]: value } },
  });

  it("asks after the plus-one step, only when someone attends", () => {
    const f = withForm();
    expect(
      applicableSteps(f, withAnswers(f, { a: { status: "declined", mealOptionId: null } })),
    ).toEqual(["attendance", "review"]);
    const d = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(applicableSteps(f, d)).toEqual(["attendance", "plusOne", "questions", "review"]);
    expect(nextStep(f, d, "plusOne")).toBe("questions");
    // No published form, or one with no questions: no step.
    expect(applicableSteps(facts({ mealOptions: [] }), d)).not.toContain("questions");
    expect(applicableSteps(withForm({ form: { ...form, questions: [] } }), d)).not.toContain(
      "questions",
    );
  });

  it("asks everyone attending and the plus-one being added", () => {
    const f = withForm();
    const d = withAnswers(
      f,
      {
        a: { status: "accepted", mealOptionId: null },
        b: { status: "declined", mealOptionId: null },
      },
      { bringing: true, name: " Cy " },
    );
    expect(questionPeople(f, d).map((p) => p.id)).toEqual(["a", NEW_PLUS_ONE]);
    expect(questionPeople(f, d)[1]!.name).toBe("Cy (your guest)");
  });

  it("needs every required question answered, now or before, naming who and what", () => {
    const f = withForm();
    let d = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    expect(validateStep(f, d, "questions")).toEqual({
      field: "questions",
      message: 'Answer "Need the shuttle?" for Ada.',
      target: "a:q_shuttle1",
    });
    d = typed(d, "a", "q_shuttle1", "yes");
    expect(validateStep(f, d, "questions")).toBeNull();
    const saved = withForm({ members: [{ ...ada, answered: ["q_shuttle1"] }, bo] });
    expect(
      validateStep(
        saved,
        withAnswers(saved, { a: { status: "accepted", mealOptionId: null } }),
        "questions",
      ),
    ).toBeNull();
  });

  it("sends answers only for attending people, with the form version", () => {
    const f = withForm();
    let d = withAnswers(
      f,
      {
        a: { status: "accepted", mealOptionId: null },
        b: { status: "declined", mealOptionId: null },
      },
      { bringing: true, name: "Cy" },
    );
    d = typed(d, "a", "q_shuttle1", "yes");
    d = typed(d, "a", "q_song0001", "  ");
    d = typed(d, "b", "q_shuttle1", "no");
    d = typed(d, NEW_PLUS_ONE, "q_song0001", "Hey Jude");
    const s = buildSubmission(f, d);
    expect(s.formVersionId).toBe("v-1");
    expect(s.responses).toEqual([
      { memberId: "a", status: "accepted", mealOptionId: null, answers: { q_shuttle1: "yes" } },
      { memberId: "b", status: "declined", mealOptionId: null },
    ]);
    expect(s.plusOne).toEqual({
      name: "Cy",
      mealOptionId: null,
      answers: { q_song0001: "Hey Jude" },
    });
    // Without a published form nothing is sent, whatever was typed.
    expect(buildSubmission(facts({ mealOptions: [] }), d).responses[0]).toEqual({
      memberId: "a",
      status: "accepted",
      mealOptionId: null,
    });
  });

  it("shows typed answers in Review and only 'saved' for stored ones", () => {
    const f = withForm({ members: [ada, { ...bo, status: "accepted", answered: ["q_song0001"] }] });
    let d = withAnswers(f, { a: { status: "accepted", mealOptionId: null } });
    d = typed(d, "a", "q_shuttle1", "no");
    d = typed(d, "a", "q_song0001", "Hey Jude");
    const lines = reviewLines(f, d);
    expect(lines[0]!.answers).toBe("Need the shuttle: No · Song request: Hey Jude");
    expect(lines[1]!.answers).toBe(SAVED_ANSWERS);
  });
});
