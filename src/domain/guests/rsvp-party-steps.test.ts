import { describe, expect, it } from "vitest";
import {
  buildPartySubmission,
  detailsPeople,
  eventsForStep,
  partyApplicableSteps,
  partyDraftFromFacts,
  partyInitialStep,
  partyNextStep,
  partyPreviousStep,
  partyRemovedNames,
  partyReviewSections,
  partySkippedNotes,
  partyValidateStep,
  setPersonDetails,
  type PartyDraft,
  type PartyEventFacts,
  type PartyRsvpFacts,
} from "./rsvp-party-steps";
import type { RsvpAnswer } from "./rsvp-steps";

const ceremony: PartyEventFacts = {
  invitationId: "inv-c",
  version: 3,
  name: "Ceremony",
  closed: false,
  plusOneRemaining: 0,
  mealOptions: [],
  members: [
    { id: "c-ada", name: "Ada", isPlusOne: false, status: "pending", mealOptionId: null },
    { id: "c-bo", name: "Bo", isPlusOne: false, status: "pending", mealOptionId: null },
  ],
};
const reception: PartyEventFacts = {
  invitationId: "inv-r",
  version: 7,
  name: "Reception",
  closed: false,
  plusOneRemaining: 1,
  mealOptions: [{ id: "chicken", name: "Chicken" }],
  members: [
    { id: "r-ada", name: "Ada", isPlusOne: false, status: "pending", mealOptionId: null },
    { id: "r-bo", name: "Bo", isPlusOne: false, status: "pending", mealOptionId: null },
  ],
};
const facts: PartyRsvpFacts = { events: [ceremony, reception] };

function answer(
  draft: PartyDraft,
  inv: string,
  member: string,
  status: RsvpAnswer,
  mealOptionId: string | null = null,
): PartyDraft {
  const d = draft[inv]!;
  return {
    ...draft,
    [inv]: { ...d, answers: { ...d.answers, [member]: { status, mealOptionId } } },
  };
}

describe("party stepper", () => {
  it("starts with attendance and review only, then adds the steps an event needs", () => {
    let d = partyDraftFromFacts(facts);
    expect(partyApplicableSteps(facts, d)).toEqual(["attendance", "review"]);
    d = answer(d, "inv-c", "c-ada", "accepted");
    // Attending the ceremony asks nothing more: it has no meals and no plus-one places.
    expect(partyApplicableSteps(facts, d)).toEqual(["attendance", "review"]);
    d = answer(d, "inv-r", "r-ada", "accepted");
    expect(partyApplicableSteps(facts, d)).toEqual(["attendance", "meals", "plusOne", "review"]);
    expect(eventsForStep(facts, d, "meals").map((e) => e.name)).toEqual(["Reception"]);
    expect(partyNextStep(facts, d, "attendance")).toBe("meals");
    expect(partyPreviousStep(facts, d, "review")).toBe("plusOne");
  });

  it("needs at least one answer somewhere before moving on", () => {
    const d = partyDraftFromFacts(facts);
    expect(partyValidateStep(facts, d, "attendance")?.field).toBe("attendance");
    expect(
      partyValidateStep(facts, answer(d, "inv-r", "r-bo", "declined"), "attendance"),
    ).toBeNull();
  });

  it("names the event whose plus-one is missing a name", () => {
    let d = answer(partyDraftFromFacts(facts), "inv-r", "r-ada", "accepted");
    d = {
      ...d,
      "inv-r": { ...d["inv-r"]!, plusOne: { ...d["inv-r"]!.plusOne, bringing: true, name: " " } },
    };
    expect(partyValidateStep(facts, d, "plusOne")).toEqual({
      field: "plusOneName",
      message: "Enter your guest's full name.",
      invitationId: "inv-r",
    });
  });

  it("sends one entry per answered event with its own version, and nothing for the rest", () => {
    let d = partyDraftFromFacts(facts);
    d = answer(d, "inv-r", "r-ada", "accepted", "chicken");
    d = answer(d, "inv-r", "r-bo", "declined", "chicken");
    expect(buildPartySubmission(facts, d)).toEqual([
      {
        invitationId: "inv-r",
        expectedVersion: 7,
        formVersionId: null,
        responses: [
          { memberId: "r-ada", status: "accepted", mealOptionId: "chicken" },
          { memberId: "r-bo", status: "declined", mealOptionId: null },
        ],
        plusOne: null,
      },
    ]);
  });

  it("never sends a closed event and shows its saved answers in review", () => {
    const closed: PartyEventFacts = {
      ...ceremony,
      closed: true,
      members: [
        { ...ceremony.members[0]!, status: "accepted" },
        { ...ceremony.members[1]!, status: "declined" },
      ],
    };
    const f = { events: [closed, reception] };
    let d = partyDraftFromFacts(f);
    // A draft change to the closed event (not possible in the UI) is ignored.
    d = answer(d, "inv-c", "c-bo", "accepted");
    d = answer(d, "inv-r", "r-ada", "declined");
    expect(buildPartySubmission(f, d).map((r) => r.invitationId)).toEqual(["inv-r"]);
    const sections = partyReviewSections(f, d);
    expect(sections[0]).toMatchObject({ name: "Ceremony", closed: true });
    expect(sections[0]!.lines.map((l) => l.answer)).toEqual(["Attending", "Not attending"]);
  });

  it("lands on review when an open event has answers, and on the summary when none is open", () => {
    expect(partyInitialStep(facts)).toBe("attendance");
    const answered = {
      events: [
        ceremony,
        { ...reception, members: [{ ...reception.members[0]!, status: "declined" as const }] },
      ],
    };
    expect(partyInitialStep(answered)).toBe("review");
    expect(
      partyInitialStep({
        events: [
          { ...ceremony, closed: true },
          { ...reception, closed: true },
        ],
      }),
    ).toBe("closed");
  });

  it("names the event in skipped-step notes when there are several", () => {
    let d = partyDraftFromFacts(facts);
    d = answer(d, "inv-c", "c-ada", "accepted");
    d = answer(d, "inv-r", "r-ada", "declined");
    expect(partySkippedNotes(facts, d)).toEqual([
      "Reception: no one is attending, so there are no meals to choose.",
      "Reception: no one is attending, so there is no guest to add.",
    ]);
    const single = { events: [reception] };
    expect(
      partySkippedNotes(single, answer(partyDraftFromFacts(single), "inv-r", "r-ada", "declined")),
    ).toEqual([
      "No one is attending, so there are no meals to choose.",
      "No one is attending, so there is no guest to add.",
    ]);
  });
});

describe("party notes (UX-07)", () => {
  const person = (key: string, id: string, name: string, saved = false) => ({
    id,
    name,
    isPlusOne: false,
    status: "pending" as const,
    mealOptionId: null,
    personKey: key,
    detailsSaved: saved,
  });
  const asking: PartyRsvpFacts = {
    events: [
      {
        ...ceremony,
        askDetails: true,
        members: [person("k-ada", "c-ada", "Ada", true), person("k-bo", "c-bo", "Bo")],
      },
      {
        ...reception,
        askDetails: true,
        members: [person("k-ada", "r-ada", "Ada", true), person("k-bo", "r-bo", "Bo")],
      },
    ],
  };
  const attendBoth = () => {
    let d = partyDraftFromFacts(asking);
    for (const [inv, m] of [
      ["inv-c", "c-ada"],
      ["inv-r", "r-ada"],
      ["inv-r", "r-bo"],
    ] as const) {
      d = answer(d, inv, m, "accepted");
    }
    return d;
  };

  it("adds the notes step only when an event is asking and someone attends", () => {
    expect(partyApplicableSteps(asking, partyDraftFromFacts(asking))).toEqual([
      "attendance",
      "review",
    ]);
    expect(partyApplicableSteps(asking, attendBoth())).toEqual([
      "attendance",
      "meals",
      "details",
      "plusOne",
      "review",
    ]);
    expect(
      partyApplicableSteps(facts, answer(partyDraftFromFacts(facts), "inv-r", "r-ada", "accepted")),
    ).toEqual(["attendance", "meals", "plusOne", "review"]);
  });

  it("asks each person once, however many events they attend", () => {
    const people = detailsPeople(asking, attendBoth());
    expect(people.map((p) => [p.name, p.saved])).toEqual([
      ["Ada", true],
      ["Bo", false],
    ]);
    expect(people[0]?.members).toEqual([
      { invitationId: "inv-c", memberId: "c-ada" },
      { invitationId: "inv-r", memberId: "r-ada" },
    ]);
  });

  it("writes what is typed to every event the person is in, and nowhere else", () => {
    const base = attendBoth();
    const d = setPersonDetails(asking, base, "k-ada", { dietary: "No shellfish" });
    expect(d["inv-c"]?.details["c-ada"]?.dietary).toBe("No shellfish");
    expect(d["inv-r"]?.details["r-ada"]?.dietary).toBe("No shellfish");
    expect(d["inv-r"]?.details["r-bo"]).toBeUndefined();
    expect(detailsPeople(asking, d)[0]?.value.dietary).toBe("No shellfish");
    expect(base["inv-c"]?.details).toEqual({}); // the old draft is not mutated
  });

  it("sends the notes only on events the person is attending", () => {
    let d = setPersonDetails(asking, attendBoth(), "k-bo", { accessibility: "Wheelchair" });
    d = answer(d, "inv-r", "r-bo", "declined");
    const sent = buildPartySubmission(asking, d).flatMap((r) => r.responses);
    expect(sent.some((r) => r.memberId === "r-bo" && "accessibility" in r)).toBe(false);
    d = answer(d, "inv-r", "r-bo", "accepted");
    expect(
      buildPartySubmission(asking, d)
        .flatMap((r) => r.responses)
        .find((r) => r.memberId === "r-bo")?.accessibility,
    ).toBe("Wheelchair");
  });

  it("shows a person's typed notes under the first event only", () => {
    const d = setPersonDetails(asking, attendBoth(), "k-ada", { dietary: "No shellfish" });
    const sections = partyReviewSections(asking, d);
    const notesOf = (i: number) => sections[i]?.lines.find((l) => l.name === "Ada")?.notes;
    expect(notesOf(0)).toBe("Food: No shellfish");
    expect(notesOf(1)).toBeUndefined();
  });
});

describe("party removal of a guest-added plus-one (UX-09)", () => {
  const di = (invId: string): PartyEventFacts["members"][number] => ({
    id: `${invId}-di`,
    name: "Di",
    isPlusOne: true,
    status: "accepted",
    mealOptionId: null,
    personKey: "di-key",
  });
  const both: PartyRsvpFacts = {
    events: [
      { ...ceremony, members: [...ceremony.members, di("c")] },
      { ...reception, plusOneRemaining: 0, members: [...reception.members, di("r")] },
    ],
  };

  it("sends the removal per event and frees the place for a new guest there", () => {
    let d = partyDraftFromFacts(both);
    d = answer(d, "inv-r", "r-ada", "accepted");
    d = answer(d, "inv-r", "r-di", "declined");
    const replies = buildPartySubmission(both, d);
    // The ceremony still has Di attending, so nothing there is a removal.
    const ceremonyReply = replies.find((r) => r.invitationId === "inv-c");
    expect(ceremonyReply?.responses.some((r) => "remove" in r)).toBe(false);
    expect(replies.find((r) => r.invitationId === "inv-r")?.responses).toContainEqual({
      memberId: "r-di",
      status: "declined",
      mealOptionId: null,
      remove: true,
    });
    expect(eventsForStep(both, d, "plusOne").map((e) => e.invitationId)).toEqual(["inv-r"]);
  });

  it("names a removed person once, even when removed from two events", () => {
    let d = partyDraftFromFacts(both);
    d = answer(d, "inv-c", "c-ada", "accepted");
    d = answer(d, "inv-c", "c-di", "declined");
    d = answer(d, "inv-r", "r-di", "declined");
    expect(partyRemovedNames(both, d)).toEqual(["Di"]);
    expect(partyRemovedNames(both, partyDraftFromFacts(both))).toEqual([]);
  });

  it("shows a closed event as it is stored, not as removed", () => {
    const closedFacts: PartyRsvpFacts = {
      events: [{ ...both.events[0]!, closed: true, members: [{ ...di("c"), status: "declined" }] }],
    };
    const [section] = partyReviewSections(closedFacts, partyDraftFromFacts(closedFacts));
    expect(section?.lines[0]?.answer).toBe("Not attending");
  });
});

describe("the couple's questions on a party link (UX-11)", () => {
  const question = {
    key: "q_shuttle1",
    type: "yes_no" as const,
    label: "Need the shuttle?",
    help: null,
    required: true,
    options: [],
  };
  const withForm: PartyRsvpFacts = {
    events: [
      ceremony,
      { ...reception, form: { versionId: "v-r", version: 1, questions: [question] } },
    ],
  };

  it("asks per event that has questions and names the event when one is missing", () => {
    let d = partyDraftFromFacts(withForm);
    d = answer(d, "inv-c", "c-ada", "accepted");
    expect(partyApplicableSteps(withForm, d)).not.toContain("questions");
    d = answer(d, "inv-r", "r-ada", "accepted");
    expect(partyApplicableSteps(withForm, d)).toContain("questions");
    expect(eventsForStep(withForm, d, "questions").map((e) => e.name)).toEqual(["Reception"]);
    expect(partyValidateStep(withForm, d, "questions")).toEqual({
      field: "questions",
      message: 'Reception: Answer "Need the shuttle?" for Ada.',
      invitationId: "inv-r",
      target: "r-ada:q_shuttle1",
    });
    const r = d["inv-r"]!;
    d = { ...d, "inv-r": { ...r, custom: { "r-ada": { q_shuttle1: "yes" } } } };
    expect(partyValidateStep(withForm, d, "questions")).toBeNull();
    const replies = buildPartySubmission(withForm, d);
    expect(replies.map((x) => [x.invitationId, x.formVersionId])).toEqual([
      ["inv-c", null],
      ["inv-r", "v-r"],
    ]);
    expect(replies[1]!.responses[0]!.answers).toEqual({ q_shuttle1: "yes" });
  });
});
