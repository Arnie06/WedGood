/**
 * Guest RSVP stepper for a party link (UX-06): the same four steps as the single-event stepper
 * (UX-03), asked across every event the party is invited to, and one Send.
 *
 * Pure and framework-free. Each event reuses the single-event rules in `rsvp-steps.ts`, so the
 * two links ask the same questions and send the same per-event payload. Events whose reply date
 * has passed are shown as a read-only summary and never sent. `rsvp_party_submit` stays the
 * authority on what is saved.
 */
import {
  applicableSteps,
  buildSubmission,
  detailsOf,
  draftFromFacts,
  removedPlusOnes,
  reviewLines,
  skippedNotes,
  validateStep,
  type DetailsDraft,
  type ReviewLine,
  type RsvpDraft,
  type RsvpFacts,
  type RsvpStep,
  type RsvpSubmission,
} from "./rsvp-steps";

export type PartyEventFacts = RsvpFacts & {
  invitationId: string;
  version: number;
  name: string;
};
export type PartyRsvpFacts = { events: readonly PartyEventFacts[] };
export type PartyDraft = Readonly<Record<string, RsvpDraft>>;

const STEP_ORDER: readonly RsvpStep[] = [
  "attendance",
  "meals",
  "details",
  "plusOne",
  "questions",
  "review",
];

export function openEvents(facts: PartyRsvpFacts): PartyEventFacts[] {
  return facts.events.filter((e) => !e.closed);
}

const draftOf = (draft: PartyDraft, e: PartyEventFacts): RsvpDraft =>
  draft[e.invitationId] ?? draftFromFacts(e);

export function partyDraftFromFacts(facts: PartyRsvpFacts): PartyDraft {
  return Object.fromEntries(facts.events.map((e) => [e.invitationId, draftFromFacts(e)]));
}

/** Open events where the given step applies (attendance and review apply to every open event). */
export function eventsForStep(
  facts: PartyRsvpFacts,
  draft: PartyDraft,
  step: RsvpStep,
): PartyEventFacts[] {
  return openEvents(facts).filter((e) => applicableSteps(e, draftOf(draft, e)).includes(step));
}

export function partyApplicableSteps(facts: PartyRsvpFacts, draft: PartyDraft): RsvpStep[] {
  return STEP_ORDER.filter(
    (s) => s === "attendance" || s === "review" || eventsForStep(facts, draft, s).length > 0,
  );
}

/** Review once anyone has answered an open event; the closed summary when nothing is open. */
export function partyInitialStep(facts: PartyRsvpFacts): RsvpStep | "closed" {
  const open = openEvents(facts);
  if (open.length === 0) return "closed";
  return open.some((e) => e.members.some((m) => m.status !== "pending")) ? "review" : "attendance";
}

export function partyNextStep(facts: PartyRsvpFacts, draft: PartyDraft, from: RsvpStep): RsvpStep {
  const steps = partyApplicableSteps(facts, draft);
  return steps[Math.min(steps.indexOf(from) + 1, steps.length - 1)] ?? "review";
}

export function partyPreviousStep(
  facts: PartyRsvpFacts,
  draft: PartyDraft,
  from: RsvpStep,
): RsvpStep {
  const steps = partyApplicableSteps(facts, draft);
  return steps[Math.max(steps.indexOf(from) - 1, 0)] ?? "attendance";
}

/**
 * Notes for steps an event offers but its answers made unnecessary. With one open event the
 * single-event wording is used; with several, each note names its event.
 */
export function partySkippedNotes(facts: PartyRsvpFacts, draft: PartyDraft): string[] {
  const open = openEvents(facts);
  if (open.length === 1) {
    const only = open[0]!;
    return skippedNotes(only, draftOf(draft, only));
  }
  return open.flatMap((e) =>
    skippedNotes(e, draftOf(draft, e)).map(
      (note) => `${e.name}: ${note.replace("No one is attending", "no one is attending")}`,
    ),
  );
}

/** One person asked about dietary and accessibility needs once, even when invited to several events. */
export type PartyPerson = {
  key: string;
  name: string;
  isPlusOne: boolean;
  /** The guest already answered earlier; the text is never available here. */
  saved: boolean;
  /** Every member row for this person in an open event. What they type is mirrored to all of them. */
  members: { invitationId: string; memberId: string }[];
  /** What is typed so far (from the first event where they are attending). */
  value: DetailsDraft;
};

const personKeyOf = (m: { id: string; personKey?: string }) => m.personKey ?? m.id;

/** People attending at least one open event, in event then guest order, each once. */
export function detailsPeople(facts: PartyRsvpFacts, draft: PartyDraft): PartyPerson[] {
  const people = new Map<string, PartyPerson>();
  for (const e of eventsForStep(facts, draft, "details")) {
    const d = draftOf(draft, e);
    for (const m of e.members) {
      if (d.answers[m.id]?.status !== "accepted") continue;
      const key = personKeyOf(m);
      if (people.has(key)) continue;
      people.set(key, {
        key,
        name: m.name,
        isPlusOne: m.isPlusOne,
        saved: false,
        members: [],
        value: detailsOf(d, m.id),
      });
    }
  }
  for (const e of openEvents(facts)) {
    for (const m of e.members) {
      const person = people.get(personKeyOf(m));
      if (!person) continue;
      person.members.push({ invitationId: e.invitationId, memberId: m.id });
      if (m.detailsSaved) person.saved = true;
    }
  }
  return [...people.values()];
}

/** Writes what one person typed into every event draft they appear in. */
export function setPersonDetails(
  facts: PartyRsvpFacts,
  draft: PartyDraft,
  personKey: string,
  patch: Partial<DetailsDraft>,
): PartyDraft {
  const next: Record<string, RsvpDraft> = { ...draft };
  for (const e of openEvents(facts)) {
    const d = draftOf(draft, e);
    let details = d.details;
    for (const m of e.members) {
      if (personKeyOf(m) !== personKey) continue;
      details = { ...details, [m.id]: { ...detailsOf(d, m.id), ...patch } };
    }
    if (details !== d.details) next[e.invitationId] = { ...d, details };
  }
  return next;
}

export type PartyStepProblem = {
  field: "attendance" | "plusOneName" | "questions";
  message: string;
  invitationId: string | null;
  /** For "questions": the input to focus, as `${personId}:${questionKey}` within the event. */
  target?: string;
};

export function partyValidateStep(
  facts: PartyRsvpFacts,
  draft: PartyDraft,
  step: RsvpStep,
): PartyStepProblem | null {
  if (step === "attendance") {
    const answered = openEvents(facts).some((e) =>
      e.members.some((m) => draftOf(draft, e).answers[m.id]?.status),
    );
    return answered
      ? null
      : {
          field: "attendance",
          message: "Choose Attending or Not attending for at least one person.",
          invitationId: null,
        };
  }
  if (step === "plusOne" || step === "questions") {
    for (const e of eventsForStep(facts, draft, step)) {
      const found = validateStep(e, draftOf(draft, e), step);
      if (found) {
        // With several events, say which one the question belongs to.
        const message =
          step === "questions" && openEvents(facts).length > 1
            ? `${e.name}: ${found.message}`
            : found.message;
        return { ...found, message, invitationId: e.invitationId };
      }
    }
  }
  return null;
}

export type PartyReply = RsvpSubmission & { invitationId: string; expectedVersion: number };

/** Guest-added plus-ones the guest has taken off the reply, as "Name" (once per person across events). */
export function partyRemovedNames(facts: PartyRsvpFacts, draft: PartyDraft): string[] {
  const seen = new Map<string, string>();
  for (const e of openEvents(facts)) {
    for (const m of removedPlusOnes(e, draftOf(draft, e))) {
      seen.set(m.personKey ?? m.id, m.name);
    }
  }
  return [...seen.values()];
}

/** One entry per open event that has something to send; closed events are never sent. */
export function buildPartySubmission(facts: PartyRsvpFacts, draft: PartyDraft): PartyReply[] {
  const replies: PartyReply[] = [];
  for (const e of openEvents(facts)) {
    const s = buildSubmission(e, draftOf(draft, e));
    if (s.responses.length === 0 && !s.plusOne) continue;
    replies.push({ invitationId: e.invitationId, expectedVersion: e.version, ...s });
  }
  return replies;
}

export type PartyReviewSection = {
  invitationId: string;
  name: string;
  closed: boolean;
  lines: ReviewLine[];
};

/** Review per event. A closed event shows what is saved, not the draft. */
export function partyReviewSections(
  facts: PartyRsvpFacts,
  draft: PartyDraft,
  mode: "draft" | "saved" = "draft",
): PartyReviewSection[] {
  // A person's notes are shown under the first event that has them, not repeated under each.
  const shown = new Set<string>();
  return facts.events.map((e) => {
    const byMember = new Map(e.members.map((m) => [m.id, personKeyOf(m)]));
    // A closed event shows what is stored, whatever the screen: nothing in it can be sent.
    const lines = reviewLines(
      e,
      e.closed ? draftFromFacts(e) : draftOf(draft, e),
      e.closed ? "saved" : mode,
    ).map((line) => {
      const key = byMember.get(line.key);
      if (!line.notes || key === undefined) return line;
      if (shown.has(key)) {
        const { notes: _repeat, ...rest } = line;
        void _repeat;
        return rest;
      }
      shown.add(key);
      return line;
    });
    return { invitationId: e.invitationId, name: e.name, closed: e.closed, lines };
  });
}
