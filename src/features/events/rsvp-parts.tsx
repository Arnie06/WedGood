import { CircleAlert } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { FORM_LIMITS, type AnswersDraft, type FormQuestion } from "@/domain/guests/rsvp-form";
import { DETAILS_MAX, type DetailsDraft, type ReviewLine } from "@/domain/guests/rsvp-steps";
import { cn } from "@/lib/cn";

/** Shared pieces of the guest RSVP steppers (single-event UX-03 and party link UX-06). */

export const choiceCard =
  "flex min-h-12 cursor-pointer items-center gap-3 rounded-control border border-border-control bg-surface px-4 py-2 text-body-md text-ink has-[:checked]:border-action-secondary has-[:checked]:bg-action-secondary-subtle has-[:checked]:font-semibold";

export const choiceInput = "size-5 shrink-0 accent-action-secondary";

export const ATTENDANCE_ERROR_ID = "rsvp-attendance-error";

export function StepForm({
  onSubmit,
  children,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {children}
    </form>
  );
}

export function StepButtons({ onBack }: { onBack?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit">Next</Button>
      {onBack && (
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      )}
    </div>
  );
}

export function ErrorMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-body-md text-danger">
      {message}
    </p>
  );
}

/**
 * The two optional questions about food and access (UX-07). Typed text stays in the browser until
 * Send. A person who already answered sees that it is saved, never what they wrote: the link
 * does not read answers back (decision Q2), so whoever opens a shared link next cannot either.
 */
export function DetailsFields({
  value,
  saved,
  onChange,
}: {
  value: DetailsDraft;
  saved: boolean;
  onChange: (patch: Partial<DetailsDraft>) => void;
}) {
  return (
    <div className="space-y-4">
      {saved && (
        <p className="text-body-sm text-ink-muted">
          Notes for the couple are saved and aren&apos;t shown here. Write something below to
          replace them.
        </p>
      )}
      <TextAreaField
        label="Food allergies or dietary needs"
        value={value.dietary}
        maxLength={DETAILS_MAX}
        autoComplete="off"
        onChange={(e) => onChange({ dietary: e.currentTarget.value })}
      />
      <TextAreaField
        label="Accessibility needs"
        value={value.accessibility}
        maxLength={DETAILS_MAX}
        autoComplete="off"
        onChange={(e) => onChange({ accessibility: e.currentTarget.value })}
      />
    </div>
  );
}

/** Said once at the top of the details step, in plain words, before anything is asked. */
export function DetailsPrivacyNote() {
  return (
    <p className="text-body-md text-ink-muted">
      Optional. Only the couple can read this, not other guests. Once you send it, it isn&apos;t
      shown again on this page, even to you.
    </p>
  );
}

export function Summary({ lines }: { lines: ReviewLine[] }) {
  return (
    <ul className="divide-y divide-border-hairline rounded-card border border-border-hairline bg-surface">
      {lines.map((l) => (
        <li
          key={l.key}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3"
        >
          <span className="font-semibold text-ink">{l.name}</span>
          <span
            className={cn(
              "text-body-md",
              l.answer === "No answer yet" ? "text-ink-muted" : "text-ink",
            )}
          >
            {l.answer}
            {l.meal ? ` · ${l.meal}` : ""}
          </span>
          {l.notes && <span className="w-full text-body-sm text-ink-muted">{l.notes}</span>}
          {l.answers && <span className="w-full text-body-sm text-ink-muted">{l.answers}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The couple's own questions for one person (UX-11). Used by both guest steppers and by the
 * builder's preview, so the couple sees exactly what guests see. A stored answer is never shown
 * (a party link is shared by a household); the person is told it is saved and can replace it.
 * `invalidKey` marks the one question the last Next found unanswered.
 */
export function QuestionFields({
  questions,
  idPrefix,
  value,
  answered,
  invalidKey,
  invalidMessage,
  onChange,
}: {
  questions: readonly FormQuestion[];
  /** Unique per person (and event, on a party link): radio groups need distinct names. */
  idPrefix: string;
  value: AnswersDraft | undefined;
  answered: readonly string[];
  invalidKey?: string | null;
  invalidMessage?: string | null;
  onChange: (key: string, v: string) => void;
}) {
  return (
    <div className="space-y-5">
      {questions.map((q) => {
        const saved = answered.includes(q.key);
        const error =
          invalidKey === q.key ? (invalidMessage ?? "Answer this question.") : undefined;
        const savedNote = saved
          ? "Your answer is saved and isn't shown here. Answer again to replace it."
          : null;
        const hint = [q.help, savedNote].filter(Boolean).join(" ") || undefined;
        const target = `${idPrefix}:${q.key}`;
        if (q.type === "text") {
          return (
            <TextField
              key={q.key}
              label={q.label}
              hint={hint}
              error={error}
              required={q.required && !saved}
              value={value?.[q.key] ?? ""}
              maxLength={FORM_LIMITS.answer}
              autoComplete="off"
              data-question-target={target}
              onChange={(e) => onChange(q.key, e.currentTarget.value)}
            />
          );
        }
        const choices =
          q.type === "yes_no"
            ? [
                { key: "yes", label: "Yes" },
                { key: "no", label: "No" },
              ]
            : q.options;
        const hintId = hint ? `${target}-hint` : undefined;
        const errorId = error ? `${target}-error` : undefined;
        return (
          <fieldset
            key={q.key}
            className="space-y-2"
            aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
            aria-invalid={error ? true : undefined}
          >
            <legend className="mb-1 text-label-lg font-semibold text-ink">
              {q.label}
              {q.required && !saved && (
                <span className="font-normal text-ink-muted"> (required)</span>
              )}
            </legend>
            {hint && (
              <p id={hintId} className="text-body-sm text-ink-muted">
                {hint}
              </p>
            )}
            {error && (
              <p id={errorId} className="flex items-start gap-1.5 text-body-sm text-danger">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            <div className={q.type === "yes_no" ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
              {choices.map((c, i) => (
                <label key={c.key} className={choiceCard}>
                  <input
                    type="radio"
                    name={`q-${target}`}
                    value={c.key}
                    checked={(value?.[q.key] ?? "") === c.key}
                    onChange={() => onChange(q.key, c.key)}
                    className={choiceInput}
                    {...(i === 0 && { "data-question-target": target })}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
