"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StepHeading } from "@/components/ui/stepper";
import { TextField } from "@/components/ui/text-field";
import {
  applicableSteps,
  buildSubmission,
  detailsOf,
  draftFromFacts,
  initialStep,
  nextStep,
  plusOnePlaces,
  PLUS_ONE_NAME_MAX,
  previousStep,
  questionPeople,
  removedPlusOnes,
  reviewLines,
  RSVP_STEP_TITLES,
  skippedNotes,
  validateStep,
  type RsvpAnswer,
  type DetailsDraft,
  type RsvpDraft,
  type RsvpStep,
  type StepProblem,
} from "@/domain/guests/rsvp-steps";
import { submitRsvp, type RsvpActionState } from "@/server/rsvp/actions";
import type { RsvpView } from "@/server/rsvp/public";
import {
  ATTENDANCE_ERROR_ID,
  choiceCard,
  DetailsFields,
  DetailsPrivacyNote,
  ErrorMessage,
  QuestionFields,
  StepButtons,
  StepForm,
  Summary,
} from "./rsvp-parts";
import { AddToCalendar } from "./add-to-calendar";
import { ZonedDate } from "./zoned-date";

const idle: RsvpActionState = { status: "idle" };
type Screen = RsvpStep | "closed" | "confirmation";

/**
 * Guest reply for one single-event invitation as a short stepper (UX-03):
 * attendance, then meals and a plus-one only when they apply, then Review and one Send.
 * Answers live in the browser until Send; the token RPC stays the only writer.
 */
export function RsvpForm({ token, initial }: { token: string; initial: RsvpView }) {
  const [state, formAction, pending] = useActionState(submitRsvp, idle);
  const [seen, setSeen] = useState(state);
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<RsvpDraft>(() => draftFromFacts(initial));
  const [screen, setScreen] = useState<Screen>(() => initialStep(initial));
  const [focusKey, setFocusKey] = useState(0);
  const [problem, setProblem] = useState<StepProblem | null>(null);
  const [notice, setNotice] = useState("");
  // Guests taken off the reply by the last Send, named on the confirmation (UX-09).
  const [removed, setRemoved] = useState<string[]>([]);
  // One Send per press: a second click before the first result arrives is ignored.
  const sending = useRef(false);
  useEffect(() => {
    sending.current = false;
  }, [state]);

  // Each action result moves the flow on: saved → confirmation; a refreshed view → Review with
  // the saved answers (or the read-only summary once the reply date has passed).
  if (seen !== state) {
    setSeen(state);
    if (state.status !== "idle") {
      const next = state.view ?? view;
      setRemoved(state.status === "ok" ? removedPlusOnes(view, draft).map((m) => m.name) : []);
      if (state.view) {
        setView(state.view);
        setDraft(draftFromFacts(state.view));
      }
      setScreen(state.status === "ok" ? "confirmation" : next.closed ? "closed" : "review");
      setProblem(null);
      setNotice("");
      setFocusKey((k) => k + 1);
    }
  }

  useEffect(() => {
    if (!problem) return;
    const target =
      problem.field === "plusOneName"
        ? document.querySelector<HTMLElement>("#main input[aria-invalid='true']")
        : problem.field === "questions"
          ? document.querySelector<HTMLElement>(
              `[data-question-target="${CSS.escape(problem.target ?? "")}"]`,
            )
          : document.querySelector<HTMLElement>(
              `[aria-describedby~="${ATTENDANCE_ERROR_ID}"] input`,
            );
    target?.focus();
  }, [problem]);

  const steps = applicableSteps(view, draft);
  const go = (to: Screen, announce = "") => {
    setProblem(null);
    setNotice(announce);
    setScreen(to);
    setFocusKey((k) => k + 1);
  };
  const next = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (screen === "closed" || screen === "confirmation") return;
    const found = validateStep(view, draft, screen);
    if (found) {
      setProblem(found);
      return;
    }
    go(
      nextStep(view, draft, screen),
      screen === "attendance" ? skippedNotes(view, draft).join(" ") : "",
    );
  };
  const back = () => {
    if (screen === "closed" || screen === "confirmation") return;
    go(previousStep(view, draft, screen));
  };
  const setAnswer = (
    memberId: string,
    patch: { status?: RsvpAnswer; mealOptionId?: string | null },
  ) =>
    setDraft((d) => {
      const current = d.answers[memberId] ?? { status: null, mealOptionId: null };
      return { ...d, answers: { ...d.answers, [memberId]: { ...current, ...patch } } };
    });

  const setDetails = (memberId: string, patch: Partial<DetailsDraft>) =>
    setDraft((d) => ({
      ...d,
      details: { ...d.details, [memberId]: { ...detailsOf(d, memberId), ...patch } },
    }));

  const setCustom = (personId: string, key: string, value: string) =>
    setDraft((d) => ({
      ...d,
      custom: { ...d.custom, [personId]: { ...d.custom[personId], [key]: value } },
    }));

  const stepInfo = (s: RsvpStep) => ({ number: steps.indexOf(s) + 1, count: steps.length });
  const answeredBefore = view.members.some((m) => m.status !== "pending");

  let body: ReactNode;
  if (screen === "closed") {
    body = (
      <section className="space-y-5">
        <StepHeading title="Your reply" focusKey={focusKey} />
        <ErrorMessage message={state.status === "error" ? state.message : null} />
        <p className="text-body-md">
          The reply date has passed, so answers can&apos;t be changed here. Please contact the
          couple.
        </p>
        <Summary lines={reviewLines(view, draftFromFacts(view), "saved")} />
      </section>
    );
  } else if (screen === "confirmation") {
    body = (
      <section className="space-y-5">
        <StepHeading title="Thank you. Your reply is saved." focusKey={focusKey} />
        <Summary lines={reviewLines(view, draft, "saved")} />
        {removed.length > 0 && (
          <p className="text-body-md">
            {removed.join(" and ")} {removed.length === 1 ? "was" : "were"} removed from your reply.
            {view.plusOneRemaining > 0
              ? " Their place is free if you'd like to add someone else."
              : ""}
          </p>
        )}
        <p className="text-body-md">
          {view.deadline ? (
            <>
              You can change it until the end of{" "}
              <ZonedDate iso={view.deadline} timeZone={view.event.timezone} /> using this link.
            </>
          ) : (
            "You can change it any time using this link."
          )}
        </p>
        {view.addToCalendar && (
          <AddToCalendar
            weddingName={view.weddingName}
            events={[
              {
                name: view.event.name,
                localDate: view.event.localDate,
                attending: view.members.some((m) => m.status === "accepted"),
              },
            ]}
          />
        )}
        <Button variant="outline" onClick={() => go("review")}>
          Change my reply
        </Button>
      </section>
    );
  } else if (screen === "attendance") {
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.attendance}
          step={stepInfo("attendance")}
          focusKey={focusKey}
        />
        <p className="text-body-md text-ink-muted">Choose an answer for each person.</p>
        {problem?.field === "attendance" && (
          <p id={ATTENDANCE_ERROR_ID} role="alert" className="text-body-md text-danger">
            {problem.message}
          </p>
        )}
        {view.members.map((m) => (
          <fieldset
            key={m.id}
            className="space-y-2"
            aria-describedby={problem?.field === "attendance" ? ATTENDANCE_ERROR_ID : undefined}
          >
            <legend className="mb-2 text-label-lg font-semibold">
              {m.name}
              {m.isPlusOne ? " (plus-one)" : ""}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["accepted", "Attending"],
                  ["declined", m.isPlusOne ? "Remove this guest" : "Not attending"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={choiceCard}>
                  <input
                    type="radio"
                    name={`answer-${m.id}`}
                    value={value}
                    checked={draft.answers[m.id]?.status === value}
                    onChange={() => setAnswer(m.id, { status: value })}
                    className="size-5 shrink-0 accent-action-secondary"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {m.isPlusOne && (
              <p className="text-body-sm text-ink-muted">
                You added this guest. Removing them frees their place.
              </p>
            )}
          </fieldset>
        ))}
        <StepButtons />
      </StepForm>
    );
  } else if (screen === "meals") {
    const notComing = view.members.filter((m) => draft.answers[m.id]?.status !== "accepted");
    body = (
      <StepForm onSubmit={next}>
        <StepHeading title={RSVP_STEP_TITLES.meals} step={stepInfo("meals")} focusKey={focusKey} />
        {view.members
          .filter((m) => draft.answers[m.id]?.status === "accepted")
          .map((m) => (
            <fieldset key={m.id} className="space-y-2">
              <legend className="mb-2 text-label-lg font-semibold">
                {m.name}
                {m.isPlusOne ? " (plus-one)" : ""}
              </legend>
              <div className="grid gap-2">
                {[...view.mealOptions, { id: "", name: "Decide later" }].map((o) => (
                  <label key={o.id || "later"} className={choiceCard}>
                    <input
                      type="radio"
                      name={`meal-${m.id}`}
                      value={o.id}
                      checked={(draft.answers[m.id]?.mealOptionId ?? "") === o.id}
                      onChange={() => setAnswer(m.id, { mealOptionId: o.id || null })}
                      className="size-5 shrink-0 accent-action-secondary"
                    />
                    <span>{o.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        {notComing.length > 0 && (
          <ul className="space-y-1 text-body-sm text-ink-muted">
            {notComing.map((m) => (
              <li key={m.id}>
                {m.name}{" "}
                {draft.answers[m.id]?.status === "declined"
                  ? "isn't attending, so no meal is needed."
                  : "has no answer yet, so no meal is asked for."}
              </li>
            ))}
          </ul>
        )}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "details") {
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.details}
          step={stepInfo("details")}
          focusKey={focusKey}
        />
        <DetailsPrivacyNote />
        {view.members
          .filter((m) => draft.answers[m.id]?.status === "accepted")
          .map((m) => (
            <fieldset key={m.id} className="space-y-3">
              <legend className="mb-2 text-label-lg font-semibold">
                {m.name}
                {m.isPlusOne ? " (plus-one)" : ""}
              </legend>
              <DetailsFields
                value={detailsOf(draft, m.id)}
                saved={m.detailsSaved}
                onChange={(patch) => setDetails(m.id, patch)}
              />
            </fieldset>
          ))}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "plusOne") {
    const remaining = plusOnePlaces(view, draft);
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.plusOne}
          step={stepInfo("plusOne")}
          focusKey={focusKey}
        />
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body-md text-ink-muted">
            You may bring {remaining} {remaining === 1 ? "guest" : "guests"} with you.
            {remaining > 1 ? " Add one at a time." : ""}
          </legend>
          {(
            [
              [false, "Not bringing anyone"],
              [true, "Yes, I'm bringing a guest"],
            ] as const
          ).map(([value, label]) => (
            <label key={label} className={choiceCard}>
              <input
                type="radio"
                name="plus-one-choice"
                checked={draft.plusOne.bringing === value}
                onChange={() =>
                  setDraft((d) => ({ ...d, plusOne: { ...d.plusOne, bringing: value } }))
                }
                className="size-5 shrink-0 accent-action-secondary"
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {draft.plusOne.bringing && (
          <div className="space-y-4">
            <TextField
              label="Guest's full name"
              value={draft.plusOne.name}
              maxLength={PLUS_ONE_NAME_MAX}
              autoComplete="off"
              error={problem?.field === "plusOneName" ? problem.message : undefined}
              onChange={(e) => {
                const name = e.currentTarget.value;
                setDraft((d) => ({ ...d, plusOne: { ...d.plusOne, name } }));
              }}
            />
            {view.mealOptions.length > 0 && (
              <SelectField
                label="Their meal choice"
                value={draft.plusOne.mealOptionId ?? ""}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  setDraft((d) => ({ ...d, plusOne: { ...d.plusOne, mealOptionId: id || null } }));
                }}
              >
                <option value="">Decide later</option>
                {view.mealOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </SelectField>
            )}
            {view.askDetails && (
              <>
                <DetailsPrivacyNote />
                <DetailsFields
                  value={{
                    dietary: draft.plusOne.dietary,
                    accessibility: draft.plusOne.accessibility,
                  }}
                  saved={false}
                  onChange={(patch) =>
                    setDraft((d) => ({ ...d, plusOne: { ...d.plusOne, ...patch } }))
                  }
                />
              </>
            )}
          </div>
        )}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "questions") {
    const questions = view.form?.questions ?? [];
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.questions}
          step={stepInfo("questions")}
          focusKey={focusKey}
        />
        <p className="text-body-md text-ink-muted">
          From the couple. Only they see your answers. Once you send them, they aren&apos;t shown
          again on this page.
        </p>
        {questionPeople(view, draft).map((p) => (
          <fieldset key={p.id} className="space-y-3">
            <legend className="mb-2 font-serif text-headline-sm text-ink">{p.name}</legend>
            <QuestionFields
              questions={questions}
              idPrefix={p.id}
              value={draft.custom[p.id]}
              answered={p.answered}
              invalidKey={
                problem?.field === "questions" && problem.target?.startsWith(`${p.id}:`)
                  ? problem.target.slice(p.id.length + 1)
                  : null
              }
              invalidMessage={problem?.field === "questions" ? problem.message : null}
              onChange={(key, value) => setCustom(p.id, key, value)}
            />
          </fieldset>
        ))}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else {
    const submission = buildSubmission(view, draft);
    const notes = skippedNotes(view, draft);
    body = (
      <form
        action={formAction}
        onSubmit={(e) => {
          if (sending.current) e.preventDefault();
          else sending.current = true;
        }}
        className="space-y-5"
        noValidate
      >
        <StepHeading
          title={RSVP_STEP_TITLES.review}
          step={stepInfo("review")}
          focusKey={focusKey}
        />
        <ErrorMessage message={state.status === "error" ? state.message : null} />
        <Summary lines={reviewLines(view, draft)} />
        {notes.length > 0 && <p className="text-body-sm text-ink-muted">{notes.join(" ")}</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("attendance")}>
            Edit answers
          </Button>
          {steps.includes("meals") && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("meals")}>
              Edit meals
            </Button>
          )}
          {steps.includes("details") && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("details")}>
              Edit notes
            </Button>
          )}
          {steps.includes("plusOne") && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("plusOne")}>
              Edit guest
            </Button>
          )}
          {steps.includes("questions") && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("questions")}>
              Edit questions
            </Button>
          )}
        </div>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="version" value={view.version} />
        {submission.formVersionId && (
          <input type="hidden" name="formVersionId" value={submission.formVersionId} />
        )}
        {submission.responses.map((r) => (
          <span key={r.memberId} hidden>
            <input type="hidden" name="memberId" value={r.memberId} />
            <input type="hidden" name={`status_${r.memberId}`} value={r.status} />
            {r.remove && <input type="hidden" name={`remove_${r.memberId}`} value="1" />}
            {r.mealOptionId && (
              <input type="hidden" name={`meal_${r.memberId}`} value={r.mealOptionId} />
            )}
            {r.dietary && <input type="hidden" name={`dietary_${r.memberId}`} value={r.dietary} />}
            {r.accessibility && (
              <input type="hidden" name={`access_${r.memberId}`} value={r.accessibility} />
            )}
            {Object.entries(r.answers ?? {}).map(([key, value]) => (
              <input key={key} type="hidden" name={`ans_${r.memberId}_${key}`} value={value} />
            ))}
          </span>
        ))}
        {submission.plusOne && (
          <>
            <input type="hidden" name="plusOneName" value={submission.plusOne.name} />
            {submission.plusOne.mealOptionId && (
              <input type="hidden" name="plusOneMeal" value={submission.plusOne.mealOptionId} />
            )}
            {submission.plusOne.dietary && (
              <input type="hidden" name="plusOneDietary" value={submission.plusOne.dietary} />
            )}
            {submission.plusOne.accessibility && (
              <input type="hidden" name="plusOneAccess" value={submission.plusOne.accessibility} />
            )}
            {Object.entries(submission.plusOne.answers ?? {}).map(([key, value]) => (
              <input key={key} type="hidden" name={`plusOneAns_${key}`} value={value} />
            ))}
          </>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : answeredBefore ? "Update my reply" : "Send my reply"}
          </Button>
          <Button variant="outline" disabled={pending} onClick={back}>
            Back
          </Button>
        </div>
        {view.deadline && (
          <p className="text-body-sm text-ink-muted">
            Please reply by <ZonedDate iso={view.deadline} timeZone={view.event.timezone} />.
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-6">
      <p aria-live="polite" className="sr-only">
        {notice}
      </p>
      {body}
    </div>
  );
}
