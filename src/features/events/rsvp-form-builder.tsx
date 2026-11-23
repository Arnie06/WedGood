"use client";

import { ArrowDown, ArrowUp, Lock, Trash2 } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StepHeading } from "@/components/ui/stepper";
import { TextField } from "@/components/ui/text-field";
import {
  addOption,
  addQuestion,
  BUILT_IN_STEPS,
  definitionProblems,
  FORM_LIMITS,
  moveQuestion,
  publishChanges,
  QUESTION_TYPE_LABELS,
  removeOption,
  removeQuestion,
  sameDefinition,
  updateOption,
  updateQuestion,
  type FormDefinition,
  type QuestionType,
} from "@/domain/guests/rsvp-form";
import { RSVP_STEP_TITLES } from "@/domain/guests/rsvp-steps";
import { saveRsvpForm, type RsvpFormActionState } from "@/server/events/rsvp-form-actions";
import { QuestionFields } from "./rsvp-parts";

const idle: RsvpFormActionState = { status: "idle" };

/**
 * The couple's own questions for one event (UX-11). The built-in steps are listed, locked, so the
 * couple sees where their questions go. Edits stay in the browser until "Save draft" or
 * "Publish"; guests only ever see a published version. The preview uses the same component guests
 * see.
 */
export function RsvpFormBuilder({
  workspaceId,
  eventId,
  eventName,
  version,
  draft: savedDraft,
  published,
  lockedTypes,
}: {
  workspaceId: string;
  eventId: string;
  eventName: string;
  version: number;
  draft: FormDefinition;
  published: { version: number; definition: FormDefinition; publishedOn: string } | null;
  /** Question key to type, for questions guests have already seen. */
  lockedTypes: Record<string, QuestionType>;
}) {
  const [state, formAction, pending] = useActionState(saveRsvpForm, idle);
  const [def, setDef] = useState<FormDefinition>(savedDraft);
  const [newType, setNewType] = useState<QuestionType>("text");
  const [showProblems, setShowProblems] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLOListElement>(null);
  const focusNew = useRef<string | null>(null);

  // After a save the server's draft is the starting point again; the newest version wins.
  const expected = state.status === "ok" ? Math.max(state.version, version) : version;
  const problems = definitionProblems(def);
  const problemFor = (key: string, field: "label" | "help" | "options") =>
    showProblems ? problems.find((p) => p.key === key && p.field === field)?.message : undefined;
  const unsaved = !sameDefinition(def, savedDraft);
  const changes = publishChanges(published?.definition ?? null, def);
  const unpublished = !sameDefinition(def, published?.definition ?? { questions: [] });

  useEffect(() => {
    if (!focusNew.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-question="${focusNew.current}"] input`,
    );
    focusNew.current = null;
    el?.focus();
  }, [def]);

  const blockIfInvalid = (e: React.FormEvent<HTMLFormElement>) => {
    if (problems.length === 0) return;
    e.preventDefault();
    setShowProblems(true);
    setConfirming(false);
    const first = problems[0]!;
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-question="${first.key}"] [aria-invalid="true"]`)
        ?.focus();
    });
  };

  return (
    <form action={formAction} onSubmit={blockIfInvalid} className="space-y-6" noValidate>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="version" value={expected} />
      <input type="hidden" name="draft" value={JSON.stringify(def)} />

      <div className="space-y-2" aria-live="polite">
        <p className="text-body-md">
          {published
            ? `Guests see version ${published.version}, published ${published.publishedOn}.`
            : "Nothing published yet. Guests aren't asked any of your questions."}
        </p>
        {unpublished && <Badge tone="pending">Changes not published</Badge>}
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
        {state.status === "ok" && (
          <p className="text-body-md text-action-secondary">{state.message}</p>
        )}
      </div>

      <section aria-labelledby={`builtin-${eventId}`} className="space-y-2">
        <h3 id={`builtin-${eventId}`} className="text-label-lg font-semibold">
          Always asked
        </h3>
        <ul className="space-y-1">
          {BUILT_IN_STEPS.map((s) => (
            <li key={s.title} className="flex items-start gap-2 text-body-md text-ink-muted">
              <Lock aria-hidden="true" className="mt-1 size-4 shrink-0" />
              <span>
                <span className="font-semibold text-ink">{s.title}</span> · {s.note}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby={`custom-${eventId}`} className="space-y-3">
        <h3 id={`custom-${eventId}`} className="text-label-lg font-semibold">
          Your questions ({def.questions.length} of {FORM_LIMITS.questions})
        </h3>
        <p className="text-body-sm text-ink-muted">
          Asked of each person attending {eventName}, after the steps above. Please don&apos;t ask
          about health or access needs here: guests are already asked privately, and those answers
          are protected separately.
        </p>
        {def.questions.length === 0 && (
          <p className="text-body-md text-ink-muted">No questions yet.</p>
        )}
        <ol ref={listRef} className="space-y-4">
          {def.questions.map((q, i) => {
            const locked = lockedTypes[q.key];
            const name = q.label.trim() || `Question ${i + 1}`;
            return (
              <li
                key={q.key}
                data-question={q.key}
                className="space-y-3 rounded-card border border-border-hairline bg-surface p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-label-md font-semibold text-ink-muted uppercase">
                    Question {i + 1} · {QUESTION_TYPE_LABELS[q.type]}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={i === 0}
                      aria-label={`Move "${name}" up`}
                      onClick={() => setDef((d) => moveQuestion(d, q.key, -1))}
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={i === def.questions.length - 1}
                      aria-label={`Move "${name}" down`}
                      onClick={() => setDef((d) => moveQuestion(d, q.key, 1))}
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-label={`Remove "${name}"`}
                      onClick={() => setDef((d) => removeQuestion(d, q.key))}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </div>
                <TextField
                  label="Question"
                  value={q.label}
                  maxLength={FORM_LIMITS.label}
                  error={problemFor(q.key, "label")}
                  onChange={(e) => {
                    const label = e.currentTarget.value;
                    setDef((d) => updateQuestion(d, q.key, { label }));
                  }}
                />
                <TextField
                  label="Help text (optional)"
                  value={q.help ?? ""}
                  maxLength={FORM_LIMITS.help}
                  error={problemFor(q.key, "help")}
                  onChange={(e) => {
                    const help = e.currentTarget.value;
                    setDef((d) => updateQuestion(d, q.key, { help: help === "" ? null : help }));
                  }}
                />
                {locked && (
                  <p className="text-body-sm text-ink-muted">
                    Guests have seen this question, so it stays a &ldquo;
                    {QUESTION_TYPE_LABELS[locked]}&rdquo; question.
                  </p>
                )}
                {q.type === "choice" && (
                  <fieldset className="space-y-2">
                    <legend className="mb-1 text-label-lg font-semibold">Choices</legend>
                    {problemFor(q.key, "options") && (
                      <p className="text-body-sm text-danger">{problemFor(q.key, "options")}</p>
                    )}
                    {q.options.map((o, j) => (
                      <div key={o.key} className="flex items-end gap-2">
                        <TextField
                          className="min-w-0 flex-1"
                          label={`Choice ${j + 1}`}
                          value={o.label}
                          maxLength={FORM_LIMITS.optionLabel}
                          aria-invalid={
                            problemFor(q.key, "options") && o.label.trim() === "" ? true : undefined
                          }
                          onChange={(e) => {
                            const label = e.currentTarget.value;
                            setDef((d) => updateOption(d, q.key, o.key, label));
                          }}
                        />
                        <Button
                          variant="quiet"
                          size="sm"
                          disabled={q.options.length <= FORM_LIMITS.options.min}
                          aria-label={`Remove choice ${j + 1} from "${name}"`}
                          onClick={() => setDef((d) => removeOption(d, q.key, o.key))}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      </div>
                    ))}
                    {q.options.length < FORM_LIMITS.options.max && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDef((d) => addOption(d, q.key))}
                      >
                        Add a choice
                      </Button>
                    )}
                  </fieldset>
                )}
                <label className="flex min-h-11 items-center gap-3 text-body-md">
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) => {
                      const required = e.currentTarget.checked;
                      setDef((d) => updateQuestion(d, q.key, { required }));
                    }}
                    className="size-5 shrink-0 accent-action-secondary"
                  />
                  <span>Guests must answer</span>
                </label>
              </li>
            );
          })}
        </ol>
        {def.questions.length < FORM_LIMITS.questions && (
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="Add a question"
              value={newType}
              onChange={(e) => setNewType(e.currentTarget.value as QuestionType)}
            >
              {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
                <option key={t} value={t}>
                  {QUESTION_TYPE_LABELS[t]}
                </option>
              ))}
            </SelectField>
            <Button
              variant="secondary"
              onClick={() =>
                setDef((d) => {
                  const next = addQuestion(d, newType);
                  focusNew.current = next.questions.at(-1)?.key ?? null;
                  return next;
                })
              }
            >
              Add question
            </Button>
          </div>
        )}
      </section>

      {def.questions.length > 0 && (
        <section className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={preview}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Hide preview" : "Preview as a guest"}
          </Button>
          {preview && (
            <div className="space-y-4 rounded-card border border-border-hairline bg-surface-sunken p-4">
              <p className="text-body-sm text-ink-muted">
                Preview only. Nothing you choose here is saved.
              </p>
              <StepHeading title={RSVP_STEP_TITLES.questions} focusKey={0} />
              <QuestionFields
                questions={def.questions.filter((q) => q.label.trim() !== "")}
                idPrefix={`preview-${eventId}`}
                value={previewAnswers}
                answered={[]}
                onChange={(key, value) => setPreviewAnswers((a) => ({ ...a, [key]: value }))}
              />
            </div>
          )}
        </section>
      )}

      <div className="space-y-3 border-t border-border-hairline pt-4">
        {confirming && (
          <div
            className="space-y-2 rounded-card border border-border-hairline p-4"
            role="group"
            aria-label="Publish changes"
          >
            <p className="text-label-lg font-semibold">What guests will see differently</p>
            {changes.length === 0 ? (
              <p className="text-body-md">Nothing changes for guests.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-6 text-body-md">
                {changes.map((c, i) => (
                  <li key={i}>
                    {c.kind === "added" && `New question: ${c.label}`}
                    {c.kind === "removed" && `No longer asked: ${c.label}`}
                    {c.kind === "edited" && `Changed: ${c.label}`}
                    {c.kind === "reordered" && "Questions in a new order"}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-body-sm text-ink-muted">
              Replies already sent keep their answers. Anyone who opens their link after this sees
              the new version, and must answer any new required question before sending again.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                name="intent"
                value="publish"
                variant="emphasis"
                disabled={pending}
              >
                {pending ? "Publishing…" : "Publish to guests"}
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                Not yet
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            name="intent"
            value="save"
            variant="secondary"
            disabled={pending || !unsaved}
          >
            {pending ? "Saving…" : unsaved ? "Save draft" : "Draft saved"}
          </Button>
          {!confirming && (
            <Button
              variant="primary"
              disabled={pending || !unpublished}
              onClick={() => {
                if (problems.length > 0) {
                  setShowProblems(true);
                  return;
                }
                setConfirming(true);
              }}
            >
              Publish…
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
