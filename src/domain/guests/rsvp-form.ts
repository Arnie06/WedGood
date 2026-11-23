/**
 * RSVP form builder rules (UX-11).
 *
 * Pure and framework-free. The couple adds their own questions to an event's guest reply; the
 * built-in steps (attendance, meals, notes for the couple, plus-one) are fixed and never part of a
 * definition. Limits and shapes match `app_private.rsvp_form_normalize` and
 * `app_private.rsvp_save_answers`, which stay the authority.
 */

export type QuestionType = "text" | "yes_no" | "choice";

export type QuestionOption = { key: string; label: string };

export type FormQuestion = {
  key: string;
  type: QuestionType;
  label: string;
  help: string | null;
  required: boolean;
  /** Only for "choice"; empty otherwise. */
  options: QuestionOption[];
};

export type FormDefinition = { questions: FormQuestion[] };

export const EMPTY_FORM: FormDefinition = { questions: [] };

export const FORM_LIMITS = {
  questions: 10,
  label: 200,
  help: 300,
  options: { min: 2, max: 10 },
  optionLabel: 80,
  answer: 500,
} as const;

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  text: "Short answer",
  yes_no: "Yes or no",
  choice: "Pick one",
};

/** The fixed steps every guest sees, shown locked in the builder. */
export const BUILT_IN_STEPS = [
  { title: "Who's coming?", note: "Attending or not, for each person invited" },
  { title: "Meal choices", note: "Only when this event offers meals" },
  { title: "Anything we should know?", note: "Dietary and access notes, only the couple sees" },
  { title: "Bringing a guest?", note: "Only when the invitation allows a plus-one" },
] as const;

const QUESTION_KEY = /^q_[a-z0-9]{8}$/;
const OPTION_KEY = /^o_[a-z0-9]{6}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random key. `random` returns a number in [0, 1); injectable for tests. */
export function newKey(prefix: "q" | "o", random: () => number = Math.random): string {
  const length = prefix === "q" ? 8 : 6;
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return `${prefix}_${out}`;
}

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

export type QuestionProblem = {
  key: string;
  field: "label" | "help" | "options";
  message: string;
};

/** Problems the couple can fix in the editor, one per field at most. Empty means it can be saved. */
export function definitionProblems(def: FormDefinition): QuestionProblem[] {
  const problems: QuestionProblem[] = [];
  for (const q of def.questions) {
    const label = tidy(q.label);
    if (label === "") problems.push({ key: q.key, field: "label", message: "Write the question." });
    else if (label.length > FORM_LIMITS.label)
      problems.push({
        key: q.key,
        field: "label",
        message: `Use ${FORM_LIMITS.label} characters or fewer.`,
      });
    if (q.help !== null && tidy(q.help).length > FORM_LIMITS.help)
      problems.push({
        key: q.key,
        field: "help",
        message: `Use ${FORM_LIMITS.help} characters or fewer.`,
      });
    if (q.type === "choice") {
      const labels = q.options.map((o) => tidy(o.label));
      const filled = labels.filter((l) => l !== "");
      if (filled.length < FORM_LIMITS.options.min)
        problems.push({ key: q.key, field: "options", message: "Add at least two choices." });
      else if (labels.some((l) => l === ""))
        problems.push({
          key: q.key,
          field: "options",
          message: "Fill in or remove empty choices.",
        });
      else if (labels.some((l) => l.length > FORM_LIMITS.optionLabel))
        problems.push({
          key: q.key,
          field: "options",
          message: `Keep each choice to ${FORM_LIMITS.optionLabel} characters or fewer.`,
        });
      else if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length)
        problems.push({ key: q.key, field: "options", message: "Each choice must be different." });
    }
  }
  return problems;
}

/**
 * The canonical form the database stores: trimmed labels, blank help as null, options only on
 * "choice". Two definitions mean the same thing exactly when their canonical forms are equal.
 */
export function canonical(def: FormDefinition): FormDefinition {
  return {
    questions: def.questions.map((q) => ({
      key: q.key,
      type: q.type,
      label: tidy(q.label),
      help: q.help === null || tidy(q.help) === "" ? null : tidy(q.help),
      required: q.required,
      options:
        q.type === "choice" ? q.options.map((o) => ({ key: o.key, label: tidy(o.label) })) : [],
    })),
  };
}

export function sameDefinition(a: FormDefinition | null, b: FormDefinition | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Reads an untrusted definition (from the database or a form post). Null when it is not a
 * well-formed definition; field-level problems (blank labels and the like) are left to
 * `definitionProblems`.
 */
export function parseDefinition(raw: unknown): FormDefinition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const questions = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length > FORM_LIMITS.questions) return null;
  const out: FormQuestion[] = [];
  const keys = new Set<string>();
  for (const item of questions) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.key !== "string" || !QUESTION_KEY.test(q.key) || keys.has(q.key)) return null;
    keys.add(q.key);
    if (q.type !== "text" && q.type !== "yes_no" && q.type !== "choice") return null;
    if (typeof q.label !== "string" || q.label.length > 1000) return null;
    if (
      q.help !== null &&
      q.help !== undefined &&
      (typeof q.help !== "string" || q.help.length > 1000)
    )
      return null;
    if (typeof q.required !== "boolean") return null;
    const rawOptions = q.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > FORM_LIMITS.options.max) return null;
    const options: QuestionOption[] = [];
    const optionKeys = new Set<string>();
    for (const o of rawOptions) {
      if (typeof o !== "object" || o === null) return null;
      const { key, label } = o as Record<string, unknown>;
      if (typeof key !== "string" || !OPTION_KEY.test(key) || optionKeys.has(key)) return null;
      if (typeof label !== "string" || label.length > 1000) return null;
      optionKeys.add(key);
      options.push({ key, label });
    }
    out.push({
      key: q.key,
      type: q.type,
      label: q.label,
      help: typeof q.help === "string" ? q.help : null,
      required: q.required,
      options: q.type === "choice" ? options : [],
    });
  }
  return { questions: out };
}

// ---------------------------------------------------------------- editing (immutable updates)

export function addQuestion(
  def: FormDefinition,
  type: QuestionType,
  random: () => number = Math.random,
): FormDefinition {
  if (def.questions.length >= FORM_LIMITS.questions) return def;
  const taken = new Set(def.questions.map((q) => q.key));
  let key = newKey("q", random);
  while (taken.has(key)) key = newKey("q", random);
  const options =
    type === "choice"
      ? [
          { key: newKey("o", random), label: "" },
          { key: newKey("o", random), label: "" },
        ]
      : [];
  return {
    questions: [...def.questions, { key, type, label: "", help: null, required: false, options }],
  };
}

export function updateQuestion(
  def: FormDefinition,
  key: string,
  patch: Partial<Pick<FormQuestion, "label" | "help" | "required">>,
): FormDefinition {
  return { questions: def.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)) };
}

export function removeQuestion(def: FormDefinition, key: string): FormDefinition {
  return { questions: def.questions.filter((q) => q.key !== key) };
}

export function moveQuestion(def: FormDefinition, key: string, by: -1 | 1): FormDefinition {
  const i = def.questions.findIndex((q) => q.key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= def.questions.length) return def;
  const questions = [...def.questions];
  [questions[i], questions[j]] = [questions[j]!, questions[i]!];
  return { questions };
}

export function addOption(
  def: FormDefinition,
  key: string,
  random: () => number = Math.random,
): FormDefinition {
  return {
    questions: def.questions.map((q) => {
      if (q.key !== key || q.type !== "choice" || q.options.length >= FORM_LIMITS.options.max)
        return q;
      const taken = new Set(q.options.map((o) => o.key));
      let optionKey = newKey("o", random);
      while (taken.has(optionKey)) optionKey = newKey("o", random);
      return { ...q, options: [...q.options, { key: optionKey, label: "" }] };
    }),
  };
}

export function updateOption(
  def: FormDefinition,
  key: string,
  optionKey: string,
  label: string,
): FormDefinition {
  return {
    questions: def.questions.map((q) =>
      q.key === key
        ? { ...q, options: q.options.map((o) => (o.key === optionKey ? { ...o, label } : o)) }
        : q,
    ),
  };
}

export function removeOption(def: FormDefinition, key: string, optionKey: string): FormDefinition {
  return {
    questions: def.questions.map((q) =>
      q.key === key ? { ...q, options: q.options.filter((o) => o.key !== optionKey) } : q,
    ),
  };
}

// ---------------------------------------------------------------- what publishing changes

export type PublishChange =
  | { kind: "added"; label: string }
  | { kind: "removed"; label: string }
  | { kind: "edited"; label: string }
  | { kind: "reordered" };

/** Plain-language list of what guests will see differently after publishing the draft. */
export function publishChanges(
  published: FormDefinition | null,
  draft: FormDefinition,
): PublishChange[] {
  const before = canonical(published ?? EMPTY_FORM).questions;
  const after = canonical(draft).questions;
  const oldByKey = new Map(before.map((q) => [q.key, q]));
  const newKeys = new Set(after.map((q) => q.key));
  const changes: PublishChange[] = [];
  for (const q of after) {
    const old = oldByKey.get(q.key);
    if (!old) changes.push({ kind: "added", label: q.label });
    else if (JSON.stringify(old) !== JSON.stringify(q))
      changes.push({ kind: "edited", label: q.label });
  }
  for (const q of before)
    if (!newKeys.has(q.key)) changes.push({ kind: "removed", label: q.label });
  const keptOrderBefore = before.filter((q) => newKeys.has(q.key)).map((q) => q.key);
  const keptOrderAfter = after.filter((q) => oldByKey.has(q.key)).map((q) => q.key);
  if (keptOrderBefore.join() !== keptOrderAfter.join()) changes.push({ kind: "reordered" });
  return changes;
}

/**
 * Keys whose type is fixed because some published version already asked them. Changing the type
 * of such a question is refused (stored answers must keep their meaning); the editor offers
 * "remove and add a new question" instead.
 */
export function lockedTypes(versions: readonly FormDefinition[]): Map<string, QuestionType> {
  const locked = new Map<string, QuestionType>();
  for (const v of versions)
    for (const q of v.questions) if (!locked.has(q.key)) locked.set(q.key, q.type);
  return locked;
}

// ---------------------------------------------------------------- guest answers

/** What one person typed, by question key. Blank means "nothing typed" (keeps a stored answer). */
export type AnswersDraft = Readonly<Record<string, string>>;

/** Trimmed, non-blank answers for questions in the form, cut to the stored limit. */
export function cleanAnswers(
  form: FormDefinition,
  draft: AnswersDraft | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!draft) return out;
  for (const q of form.questions) {
    const v = (draft[q.key] ?? "").trim();
    if (v === "") continue;
    if (q.type === "text") out[q.key] = v.slice(0, FORM_LIMITS.answer);
    else if (q.type === "yes_no" && (v === "yes" || v === "no")) out[q.key] = v;
    else if (q.type === "choice" && q.options.some((o) => o.key === v)) out[q.key] = v;
  }
  return out;
}

/** Required questions this person still has to answer (nothing typed and nothing stored). */
export function missingRequired(
  form: FormDefinition,
  draft: AnswersDraft | undefined,
  answered: readonly string[],
): FormQuestion[] {
  const typed = cleanAnswers(form, draft);
  return form.questions.filter((q) => q.required && !(q.key in typed) && !answered.includes(q.key));
}

/** An answer as a person reads it: the option's label for a choice, "Yes"/"No", or the text. */
export function answerText(q: FormQuestion | undefined, value: string): string {
  if (!q) return value;
  if (q.type === "yes_no") return value === "yes" ? "Yes" : value === "no" ? "No" : value;
  if (q.type === "choice")
    return q.options.find((o) => o.key === value)?.label ?? "A choice no longer offered";
  return value;
}

export type AnswerSummary = {
  key: string;
  label: string;
  type: QuestionType;
  /** Choice and yes/no: count per answer, in the question's order. */
  tallies: { label: string; count: number }[];
  /** Text answers with who gave them. */
  texts: { name: string; text: string }[];
  answered: number;
};

/**
 * Per question of the published form: tallies for choices and yes/no, and text answers with
 * names. Option keys are stable, so an option renamed later is counted under its new label; an
 * option removed later is counted as "no longer offered". Answers to questions no longer in the
 * form are not summarized (they stay stored).
 */
export function summarizeAnswers(
  form: FormDefinition,
  answers: readonly { questionKey: string; value: string; guestName: string }[],
): AnswerSummary[] {
  return form.questions.map((q) => {
    const mine = answers.filter((a) => a.questionKey === q.key);
    const tallies: { label: string; count: number }[] = [];
    if (q.type === "yes_no") {
      tallies.push(
        { label: "Yes", count: mine.filter((a) => a.value === "yes").length },
        { label: "No", count: mine.filter((a) => a.value === "no").length },
      );
    } else if (q.type === "choice") {
      for (const o of q.options)
        tallies.push({ label: o.label, count: mine.filter((a) => a.value === o.key).length });
      const retired = mine.filter((a) => !q.options.some((o) => o.key === a.value)).length;
      if (retired > 0) tallies.push({ label: "A choice no longer offered", count: retired });
    }
    const texts =
      q.type === "text"
        ? mine
            .map((a) => ({ name: a.guestName, text: a.value }))
            .sort((x, y) => x.name.localeCompare(y.name))
        : [];
    return { key: q.key, label: q.label, type: q.type, tallies, texts, answered: mine.length };
  });
}
