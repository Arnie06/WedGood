import { describe, expect, it } from "vitest";
import {
  partyDraftFromFacts,
  partyReviewSections,
  partyStay,
  setPartyStay,
  buildPartySubmission,
  type PartyRsvpFacts,
} from "./rsvp-party-steps";
import {
  applicableSteps,
  buildSubmission,
  draftFromFacts,
  reviewLines,
  stayFromValue,
  stayValue,
  type RsvpDraft,
  type RsvpFacts,
} from "./rsvp-steps";

// UX-17 lodging: "Where are you staying?" in the guest RSVP steppers.

const member = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  isPlusOne: false,
  status: "pending" as const,
  mealOptionId: null,
  ...extra,
});
const facts = (over: Partial<RsvpFacts> = {}): RsvpFacts => ({
  members: [member("a", "Ada"), member("b", "Bo")],
  mealOptions: [],
  plusOneRemaining: 0,
  closed: false,
  hotels: [{ id: "h1", name: "Harbour Inn", bookBy: "2027-05-10" }],
  ...over,
});
const attending = (f: RsvpFacts, ids: string[], stay = ""): RsvpDraft => {
  const d = draftFromFacts(f);
  const answers = { ...d.answers };
  for (const m of f.members)
    answers[m.id] = { status: ids.includes(m.id) ? "accepted" : "declined", mealOptionId: null };
  return { ...d, answers, stay };
};

describe("stay step", () => {
  it("is asked only when hotels are offered and someone is attending", () => {
    const f = facts();
    expect(applicableSteps(f, attending(f, ["a"]))).toContain("stay");
    expect(applicableSteps(f, attending(f, []))).not.toContain("stay");
    const none = facts({ hotels: [] });
    expect(applicableSteps(none, attending(none, ["a"]))).not.toContain("stay");
  });

  it("sends the one answer for each attending person and never for a decline", () => {
    const f = facts();
    const s = buildSubmission(f, attending(f, ["a"], "hotel:h1"));
    expect(s.responses.find((r) => r.memberId === "a")?.stay).toEqual({
      kind: "hotel",
      hotelId: "h1",
    });
    expect(s.responses.find((r) => r.memberId === "b")?.stay).toBeUndefined();
    expect(buildSubmission(f, attending(f, ["a"], "")).responses[0]?.stay).toBeUndefined();
  });

  it("ignores a hotel that is no longer offered", () => {
    const f = facts();
    expect(stayFromValue(f, "hotel:gone")).toBeNull();
    expect(
      buildSubmission(f, attending(f, ["a"], "hotel:gone")).responses[0]?.stay,
    ).toBeUndefined();
    expect(stayFromValue(f, "elsewhere")).toEqual({ kind: "elsewhere", hotelId: null });
  });

  it("starts from the saved answer when everyone said the same", () => {
    const same = facts({
      members: [
        member("a", "Ada", { stay: { kind: "hotel", hotelId: "h1" } }),
        member("b", "Bo", { stay: { kind: "hotel", hotelId: "h1" } }),
      ],
    });
    expect(draftFromFacts(same).stay).toBe("hotel:h1");
    const mixed = facts({
      members: [
        member("a", "Ada", { stay: { kind: "hotel", hotelId: "h1" } }),
        member("b", "Bo", { stay: { kind: "elsewhere", hotelId: null } }),
      ],
    });
    expect(draftFromFacts(mixed).stay).toBe("");
    expect(stayValue(same, { kind: "hotel", hotelId: "archived" })).toBe("");
  });

  it("shows the choice on Review, and what is saved afterwards", () => {
    const f = facts();
    expect(reviewLines(f, attending(f, ["a"], "hotel:h1"))[0]?.stay).toBe("Staying at Harbour Inn");
    const saved = facts({
      members: [
        member("a", "Ada", { status: "accepted", stay: { kind: "not_staying", hotelId: null } }),
      ],
    });
    expect(reviewLines(saved, draftFromFacts(saved), "saved")[0]?.stay).toBe(
      "Not staying overnight",
    );
  });
});

describe("party stay", () => {
  const ev = (id: string, name: string): PartyRsvpFacts["events"][number] => ({
    ...facts({
      members: [member(`${id}-a`, "Ada", { personKey: "ada" })],
    }),
    invitationId: id,
    version: 1,
    name,
  });
  const party: PartyRsvpFacts = { events: [ev("i1", "Ceremony"), ev("i2", "Reception")] };

  it("asks once and sends the same answer for every event", () => {
    let d = partyDraftFromFacts(party);
    for (const e of party.events) {
      d = {
        ...d,
        [e.invitationId]: {
          ...d[e.invitationId]!,
          answers: { [`${e.invitationId}-a`]: { status: "accepted", mealOptionId: null } },
        },
      };
    }
    d = setPartyStay(party, d, "elsewhere");
    expect(partyStay(party, d)).toBe("elsewhere");
    const replies = buildPartySubmission(party, d);
    expect(replies.map((r) => r.responses[0]?.stay)).toEqual([
      { kind: "elsewhere", hotelId: null },
      { kind: "elsewhere", hotelId: null },
    ]);
    // Shown once per person on Review, not under every event.
    const lines = partyReviewSections(party, d).flatMap((s) => s.lines);
    expect(lines.filter((l) => l.stay).length).toBe(1);
  });
});
