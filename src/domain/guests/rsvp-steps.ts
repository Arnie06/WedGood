/**
 * Guest RSVP stepper rules for a single-event invitation (UX-03).
 *
 * Pure and framework-free. The stepper only decides which questions to ask and what to send;
 * the token RPC (`rsvp_submit`) stays the authority on what is saved.
 */

import {
  cleanAnswers,
  missingRequired,
  answerText,
  type AnswersDraft,
  type FormQuestion,
} from "./rsvp-form";

export type RsvpAnswer = "accepted" | "declined";

export type RsvpMemberFacts = {
  id: string;
  name: string;
  isPlusOne: boolean;
  status: "pending" | RsvpAnswer;
  mealOptionId: string | null;
  /** The guest has already told the couple something. The text is never sent back (UX-07). */
  detailsSaved?: boolean;
  /** Opaque, stable key for the same person across events of a party link. */
  personKey?: string;
  /** Keys of the couple's questions this person has answered. The answers are never sent back (UX-11). */
  answered?: readonly string[];
};

/** The couple's published questions for this event (UX-11). */
export type RsvpFormFacts = {
  versionId: string;
  version: number;
  questions: readonly FormQuestion[];
};

export type RsvpFacts = {
  members: readonly RsvpMemberFacts[];
  mealOptions: readonly { id: string; name: string }[];
  plusOneRemaining: number;
  closed: boolean;
  /** Ask each person who is attending about dietary and accessibility needs (UX-07). */
  askDetails?: boolean;
  /** The couple's own questions, when they have published some and the switch is on (UX-11). */
  form?: RsvpFormFacts | null;
};

/** Draft key for the plus-one being added in this send (they have no member id yet). */
export const NEW_PLUS_ONE = "new-plus-one";

/** What one person typed for the couple. Text lives in the browser until Send. */
export type DetailsDraft = { dietary: string; accessibility: string };

export type RsvpDraft = {
  answers: Readonly<Record<string, { status: RsvpAnswer | null; mealOptionId: string | null }>>;
  /** By invitation member id. A missing entry means nothing typed. */
  details: Readonly<Record<string, DetailsDraft>>;
  plusOne: {
    bringing: boolean;
    name: string;
    mealOptionId: string | null;
    dietary: string;
    accessibility: string;
  };
  /** Answers to the couple's questions, by member id (or NEW_PLUS_ONE), then question key. */
  custom: Readonly<Record<string, AnswersDraft>>;
};

export type RsvpStep = "attendance" | "meals" | "details" | "plusOne" | "questions" | "review";

export const RSVP_STEP_TITLES: Record<RsvpStep, string> = {
  attendance: "Who's coming?",
  meals: "Meal choices",
  details: "Anything we should know?",
  plusOne: "Bringing a guest?",
  questions: "A few more questions",
  review: "Check your reply",
};

export const PLUS_ONE_NAME_MAX = 120;
/** Matches the database limit on guest_private_details text. */
export const DETAILS_MAX = 500;

export const NO_DETAILS: DetailsDraft = { dietary: "", accessibility: "" };

export const detailsOf = (draft: RsvpDraft, memberId: string): DetailsDraft =>
  draft.details[memberId] ?? NO_DETAILS;

/** Saved answers become the starting draft. Unknown (retired) meal ids are not carried over. */
export function draftFromFacts(facts: RsvpFacts): RsvpDraft {
  const known = new Set(facts.mealOptions.map((o) => o.id));
  const answers: Record<string, { status: RsvpAnswer | null; mealOptionId: string | null }> = {};
  for (const m of facts.members) {
    answers[m.id] = {
      status: m.status === "pending" ? null : m.status,
      mealOptionId: m.mealOptionId && known.has(m.mealOptionId) ? m.mealOptionId : null,
    };
  }
  return {
    answers,
    details: {},
    plusOne: { bringing: false, name: "", mealOptionId: null, dietary: "", accessibility: "" },
    custom: {},
  };
}

function attending(facts: RsvpFacts, draft: RsvpDraft): RsvpMemberFacts[] {
  return facts.members.filter((m) => draft.answers[m.id]?.status === "accepted");
}

function mealsApply(facts: RsvpFacts, draft: RsvpDraft): boolean {
  return facts.mealOptions.length > 0 && attending(facts, draft).length > 0;
}

function detailsApply(facts: RsvpFacts, draft: RsvpDraft): boolean {
  return facts.askDetails === true && attending(facts, draft).length > 0;
}

/**
 * A guest removes someone they added by choosing "Remove" for them (UX-09). The server frees that
 * place in the same Send, so the guest can name someone else straight away.
 */
export function removedPlusOnes(facts: RsvpFacts, draft: RsvpDraft): RsvpMemberFacts[] {
  return facts.members.filter((m) => m.isPlusOne && draft.answers[m.id]?.status === "declined");
}

/** Places left once the removals in this draft are counted. */
export function plusOnePlaces(facts: RsvpFacts, draft: RsvpDraft): number {
  return facts.plusOneRemaining + removedPlusOnes(facts, draft).length;
}

function plusOneApplies(facts: RsvpFacts, draft: RsvpDraft): boolean {
  return plusOnePlaces(facts, draft) > 0 && attending(facts, draft).length > 0;
}

/** The name of the plus-one being added in this send, or null when nobody is being added. */
export function newPlusOneName(facts: RsvpFacts, draft: RsvpDraft): string | null {
  const name = draft.plusOne.name.trim().replace(/\s+/g, " ");
  return plusOneApplies(facts, draft) && draft.plusOne.bringing && name !== "" ? name : null;
}

/** Who answers the couple's questions: everyone attending, then the plus-one being added. */
export function questionPeople(
  facts: RsvpFacts,
  draft: RsvpDraft,
): { id: string; name: string; answered: readonly string[] }[] {
  if (!facts.form || facts.form.questions.length === 0) return [];
  const people = attending(facts, draft).map((m) => ({
    id: m.id,
    name: m.isPlusOne ? `${m.name} (plus-one)` : m.name,
    answered: m.answered ?? [],
  }));
  const plusName = newPlusOneName(facts, draft);
  if (plusName !== null)
    people.push({ id: NEW_PLUS_ONE, name: `${plusName} (your guest)`, answered: [] });
  return people;
}

function questionsApply(facts: RsvpFacts, draft: RsvpDraft): boolean {
  return questionPeople(facts, draft).length > 0;
}

/** The steps this guest will see, in order, given the answers so far. */
export function applicableSteps(facts: RsvpFacts, draft: RsvpDraft): RsvpStep[] {
  const steps: RsvpStep[] = ["attendance"];
  if (mealsApply(facts, draft)) steps.push("meals");
  if (detailsApply(facts, draft)) steps.push("details");
  if (plusOneApplies(facts, draft)) steps.push("plusOne");
  if (questionsApply(facts, draft)) steps.push("questions");
  steps.push("review");
  return steps;
}

/** Where a returning guest lands: Review once anyone has answered, otherwise the first question. */
export function initialStep(facts: RsvpFacts): RsvpStep | "closed" {
  if (facts.closed) return "closed";
  return facts.members.some((m) => m.status !== "pending") ? "review" : "attendance";
}

export function nextStep(facts: RsvpFacts, draft: RsvpDraft, from: RsvpStep): RsvpStep {
  const steps = applicableSteps(facts, draft);
  const i = steps.indexOf(from);
  return steps[Math.min(i + 1, steps.length - 1)] ?? "review";
}

export function previousStep(facts: RsvpFacts, draft: RsvpDraft, from: RsvpStep): RsvpStep {
  const steps = applicableSteps(facts, draft);
  const i = steps.indexOf(from);
  return steps[Math.max(i - 1, 0)] ?? "attendance";
}

/**
 * Plain-language notes for steps that this event offers but that the answers made unnecessary,
 * announced when the guest moves past them. Steps the event never offers (no meal choices, no
 * plus-one places) are not mentioned.
 */
export function skippedNotes(facts: RsvpFacts, draft: RsvpDraft): string[] {
  if (attending(facts, draft).length > 0) return [];
  const notes: string[] = [];
  if (facts.mealOptions.length > 0)
    notes.push("No one is attending, so there are no meals to choose.");
  if (plusOnePlaces(facts, draft) > 0)
    notes.push("No one is attending, so there is no guest to add.");
  return notes;
}

export type StepProblem = {
  field: "attendance" | "plusOneName" | "questions";
  message: string;
  /** For "questions": the input to focus, as `${personId}:${questionKey}`. */
  target?: string;
};

export function validateStep(
  facts: RsvpFacts,
  draft: RsvpDraft,
  step: RsvpStep,
): StepProblem | null {
  if (step === "attendance") {
    const answered = facts.members.some((m) => draft.answers[m.id]?.status);
    return answered
      ? null
      : {
          field: "attendance",
          message: "Choose Attending or Not attending for at least one person.",
        };
  }
  if (step === "plusOne" && draft.plusOne.bringing) {
    const name = draft.plusOne.name.trim();
    if (name === "") return { field: "plusOneName", message: "Enter your guest's full name." };
    if (name.length > PLUS_ONE_NAME_MAX) {
      return { field: "plusOneName", message: `Use ${PLUS_ONE_NAME_MAX} characters or fewer.` };
    }
  }
  if (step === "questions" && facts.form) {
    for (const p of questionPeople(facts, draft)) {
      const missing = missingRequired(
        { questions: [...facts.form.questions] },
        draft.custom[p.id],
        p.answered,
      )[0];
      if (missing) {
        return {
          field: "questions",
          message: `Answer "${missing.label}" for ${p.name}.`,
          target: `${p.id}:${missing.key}`,
        };
      }
    }
  }
  return null;
}

/** Only present when the guest typed something; blank answers are left out entirely. */
export type SubmittedDetails = { dietary?: string; accessibility?: string };

/** Answers to the couple's questions, only present when something was typed (UX-11). */
export type SubmittedAnswers = { answers?: Record<string, string> };

export type RsvpSubmission = {
  responses: ({
    memberId: string;
    status: RsvpAnswer;
    mealOptionId: string | null;
    /** A guest-added plus-one the guest took off the reply: declined, place freed (UX-09). */
    remove?: true;
  } & SubmittedDetails &
    SubmittedAnswers)[];
  plusOne:
    ({ name: string; mealOptionId: string | null } & SubmittedDetails & SubmittedAnswers) | null;
  /** The published form version the guest answered; null when the couple asks no questions. */
  formVersionId: string | null;
};

function typedAnswers(facts: RsvpFacts, draft: RsvpDraft, personId: string): SubmittedAnswers {
  if (!facts.form || facts.form.questions.length === 0) return {};
  const answers = cleanAnswers({ questions: [...facts.form.questions] }, draft.custom[personId]);
  return Object.keys(answers).length > 0 ? { answers } : {};
}

/** Trimmed, non-blank answers only, cut to the stored limit. */
export function cleanDetails(d: DetailsDraft): SubmittedDetails {
  const dietary = d.dietary.trim().slice(0, DETAILS_MAX);
  const accessibility = d.accessibility.trim().slice(0, DETAILS_MAX);
  return {
    ...(dietary !== "" && { dietary }),
    ...(accessibility !== "" && { accessibility }),
  };
}

/**
 * What one Send carries. Unanswered people are left out (they stay as they are), declines never
 * carry a meal, and a plus-one is only sent when the step applies and a name was given.
 */
export function buildSubmission(facts: RsvpFacts, draft: RsvpDraft): RsvpSubmission {
  const meals = facts.mealOptions.length > 0;
  const responses: RsvpSubmission["responses"] = [];
  for (const m of facts.members) {
    const a = draft.answers[m.id];
    if (!a?.status) continue;
    responses.push({
      memberId: m.id,
      status: a.status,
      mealOptionId: a.status === "accepted" && meals ? a.mealOptionId : null,
      // Declining someone the guest added takes them off the reply and frees the place.
      ...(m.isPlusOne && a.status === "declined" && { remove: true as const }),
      // A decline carries no notes, and nothing is sent when the event is not asking.
      ...(a.status === "accepted" && facts.askDetails && cleanDetails(detailsOf(draft, m.id))),
      ...(a.status === "accepted" && typedAnswers(facts, draft, m.id)),
    });
  }
  const name = newPlusOneName(facts, draft);
  const plusOne =
    name !== null
      ? {
          name,
          mealOptionId: meals ? draft.plusOne.mealOptionId : null,
          ...(facts.askDetails && cleanDetails(draft.plusOne)),
          ...typedAnswers(facts, draft, NEW_PLUS_ONE),
        }
      : null;
  return { responses, plusOne, formVersionId: facts.form?.versionId ?? null };
}

export type ReviewLine = {
  key: string;
  name: string;
  answer: string;
  meal: string | null;
  /** Notes for the couple: what is about to be sent, or "saved" once it has been. */
  notes?: string;
  /** Answers to the couple's questions: what is about to be sent, or "saved" (UX-11). */
  answers?: string;
};

export const SAVED_ANSWERS = "Answers to the couple's questions are saved.";

/** "Question: answer" for what the guest is about to send. Never used for stored answers. */
function typedAnswerLine(facts: RsvpFacts, a: SubmittedAnswers): string | null {
  if (!facts.form || !a.answers) return null;
  const parts = facts.form.questions
    .filter((q) => a.answers && q.key in a.answers)
    .map((q) => `${q.label.replace(/[?:.]+$/, "")}: ${answerText(q, a.answers![q.key]!)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What the guest is about to send, in their own words. Never used for text read back from the server. */
function typedNotes(d: SubmittedDetails): string | null {
  const parts: string[] = [];
  if (d.dietary) parts.push(`Food: ${d.dietary}`);
  if (d.accessibility) parts.push(`Access: ${d.accessibility}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const SAVED_NOTES = "Notes for the couple are saved. Only they can read them.";

/**
 * One line per person (and the new plus-one), as the guest will read it. "draft" is Review, before
 * Send: a guest-added plus-one marked as declined will be removed. "saved" is what is stored, for the
 * read-only and confirmation screens, where a decline is just "Not attending".
 */
export function reviewLines(
  facts: RsvpFacts,
  draft: RsvpDraft,
  mode: "draft" | "saved" = "draft",
): ReviewLine[] {
  const mealName = (id: string | null) =>
    id === null
      ? "Meal not chosen yet"
      : (facts.mealOptions.find((o) => o.id === id)?.name ?? "Meal not chosen yet");
  const meals = facts.mealOptions.length > 0;
  const lines: ReviewLine[] = facts.members.map((m) => {
    const a = draft.answers[m.id];
    const status = a?.status ?? null;
    const typed =
      status === "accepted" && facts.askDetails
        ? typedNotes(cleanDetails(detailsOf(draft, m.id)))
        : null;
    const notes = typed ?? (status === "accepted" && m.detailsSaved ? SAVED_NOTES : null);
    const answers =
      status === "accepted"
        ? (typedAnswerLine(facts, typedAnswers(facts, draft, m.id)) ??
          (facts.form && (m.answered?.length ?? 0) > 0 ? SAVED_ANSWERS : null))
        : null;
    return {
      ...(notes !== null && { notes }),
      ...(answers !== null && { answers }),
      key: m.id,
      name: m.isPlusOne ? `${m.name} (plus-one)` : m.name,
      answer:
        status === "accepted"
          ? "Attending"
          : status === "declined"
            ? m.isPlusOne && mode === "draft"
              ? "Will be removed"
              : "Not attending"
            : "No answer yet",
      meal: status === "accepted" && meals ? mealName(a?.mealOptionId ?? null) : null,
    };
  });
  const submission = buildSubmission(facts, draft);
  if (submission.plusOne) {
    const plusNotes = typedNotes(submission.plusOne);
    const plusAnswers = typedAnswerLine(facts, submission.plusOne);
    lines.push({
      key: NEW_PLUS_ONE,
      name: `${submission.plusOne.name} (your guest)`,
      answer: "Attending",
      meal: meals ? mealName(submission.plusOne.mealOptionId) : null,
      ...(plusNotes !== null && { notes: plusNotes }),
      ...(plusAnswers !== null && { answers: plusAnswers }),
    });
  }
  return lines;
}
