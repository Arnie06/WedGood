import { isDateOnly } from "@/domain/dates/date-only";

export const MAX_TITLE = 160;
export const MAX_NOTES = 2000;

export type TaskField = "title" | "notes" | "dueDate";

export type TaskInput = { title: string; notes: string | null; dueDate: string | null };

export type TaskParseResult =
  { ok: true; value: TaskInput } | { ok: false; errors: Partial<Record<TaskField, string>> };

/** Validates raw form strings; blank optional fields become null (unknown), never "" or a default. */
export function parseTaskInput(
  raw: Partial<Record<TaskField, string | null | undefined>>,
): TaskParseResult {
  const errors: Partial<Record<TaskField, string>> = {};
  const title = (raw.title ?? "").trim();
  if (title.length === 0) errors.title = "Give the task a name.";
  else if (title.length > MAX_TITLE) errors.title = `Keep the name under ${MAX_TITLE} characters.`;

  const notes = (raw.notes ?? "").trim();
  if (notes.length > MAX_NOTES) errors.notes = `Keep notes under ${MAX_NOTES} characters.`;

  const due = (raw.dueDate ?? "").trim();
  if (due !== "" && !isDateOnly(due)) errors.dueDate = "Enter a valid date.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { title, notes: notes === "" ? null : notes, dueDate: due === "" ? null : due },
  };
}
