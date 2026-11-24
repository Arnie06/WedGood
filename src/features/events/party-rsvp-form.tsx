"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StepHeading } from "@/components/ui/stepper";
import { TextField } from "@/components/ui/text-field";
import { formatEventDate } from "@/domain/events/event";
import {
  buildPartySubmission,
  detailsPeople,
  eventsForStep,
  openEvents,
  partyApplicableSteps,
  partyDraftFromFacts,
  partyHotels,
  partyInitialStep,
  partyRemovedNames,
  partyNextStep,
  partyPreviousStep,
  partyReviewSections,
  partySkippedNotes,
  partyStay,
  partyValidateStep,
  setPartyStay,
  setPersonDetails,
  type PartyDraft,
  type PartyEventFacts,
  type PartyRsvpFacts,
  type PartyStepProblem,
} from "@/domain/guests/rsvp-party-steps";
import {
  plusOnePlaces,
  PLUS_ONE_NAME_MAX,
  questionPeople,
  RSVP_STEP_TITLES,
  type DetailsDraft,
  type RsvpAnswer,
  type RsvpDraft,
  type RsvpStep,
} from "@/domain/guests/rsvp-steps";
import { submitPartyRsvp, type PartyRsvpActionState } from "@/server/rsvp/party-actions";
import type { RsvpPartyEvent, RsvpPartyView } from "@/server/rsvp/public";
import {
  ATTENDANCE_ERROR_ID,
  choiceCard,
  choiceInput,
  DetailsFields,
  DetailsPrivacyNote,
  ErrorMessage,
  QuestionFields,
  StayFields,
  StepButtons,
  StepForm,
  Summary,
} from "./rsvp-parts";
import { AddToCalendar } from "./add-to-calendar";
import { ZonedDate } from "./zoned-date";

const idle: PartyRsvpActionState = { status: "idle" };
type Screen = RsvpStep | "closed" | "confirmation";

function toFacts(view: RsvpPartyView): PartyRsvpFacts {
  return { events: view.events.map((e) => ({ ...e, name: e.event.name })) };
}

/**
 * Guest reply for every event of a party link (UX-06): the UX-03 steps asked across events, then
 * Review and one Send. Answers live in the browser until Send; the party token RPC is the only
 * writer, and it saves every event or none.
 */
export function PartyRsvpForm({ token, initial }: { token: string; initial: RsvpPartyView }) {
  const [state, formAction, pending] = useActionState(submitPartyRsvp, idle);
  const [seen, setSeen] = useState(state);
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<PartyDraft>(() => partyDraftFromFacts(toFacts(initial)));
  const [screen, setScreen] = useState<Screen>(() => partyInitialStep(toFacts(initial)));
  const [focusKey, setFocusKey] = useState(0);
  const [problem, setProblem] = useState<PartyStepProblem | null>(null);
  const [notice, setNotice] = useState("");
  // Guests taken off the reply by the last Send, named on the confirmation (UX-09).
  const [removed, setRemoved] = useState<string[]>([]);
  const sending = useRef(false);
  useEffect(() => {
    sending.current = false;
  }, [state]);

  if (seen !== state) {
    setSeen(state);
    if (state.status !== "idle") {
      const nextView = state.view ?? view;
      setRemoved(state.status === "ok" ? partyRemovedNames(toFacts(view), draft) : []);
      if (state.view) {
        setView(state.view);
        setDraft(partyDraftFromFacts(toFacts(state.view)));
      }
      const anyOpen = openEvents(toFacts(nextView)).length > 0;
      setScreen(state.status === "ok" ? "confirmation" : anyOpen ? "review" : "closed");
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
              `[data-question-target="${CSS.escape(`${problem.invitationId}-${problem.target ?? ""}`)}"]`,
            )
          : document.querySelector<HTMLElement>(
              `[aria-describedby~="${ATTENDANCE_ERROR_ID}"] input`,
            );
    target?.focus();
  }, [problem]);

  const facts = toFacts(view);
  const byId = new Map(view.events.map((e) => [e.invitationId, e]));
  const open = openEvents(facts);
  const closedEvents = facts.events.filter((e) => e.closed);
  const steps = partyApplicableSteps(facts, draft);
  const stepInfo = (s: RsvpStep) => ({ number: steps.indexOf(s) + 1, count: steps.length });
  const answeredBefore = open.some((e) => e.members.some((m) => m.status !== "pending"));
  const errorMessage = state.status === "error" ? state.message : null;

  const go = (to: Screen, announce = "") => {
    setProblem(null);
    setNotice(announce);
    setScreen(to);
    setFocusKey((k) => k + 1);
  };
  const next = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (screen === "closed" || screen === "confirmation") return;
    const found = partyValidateStep(facts, draft, screen);
    if (found) {
      setProblem(found);
      return;
    }
    go(
      partyNextStep(facts, draft, screen),
      screen === "attendance" ? partySkippedNotes(facts, draft).join(" ") : "",
    );
  };
  const back = () => {
    if (screen === "closed" || screen === "confirmation") return;
    go(partyPreviousStep(facts, draft, screen));
  };
  const patch = (invitationId: string, fn: (d: RsvpDraft) => RsvpDraft) =>
    setDraft((all) => {
      const current = all[invitationId];
      return current ? { ...all, [invitationId]: fn(current) } : all;
    });
  const setAnswer = (
    invitationId: string,
    memberId: string,
    change: { status?: RsvpAnswer; mealOptionId?: string | null },
  ) =>
    patch(invitationId, (d) => {
      const current = d.answers[memberId] ?? { status: null, mealOptionId: null };
      return { ...d, answers: { ...d.answers, [memberId]: { ...current, ...change } } };
    });
  const setDetails = (personKey: string, change: Partial<DetailsDraft>) =>
    setDraft((all) => setPersonDetails(facts, all, personKey, change));
  const setCustom = (invitationId: string, personId: string, key: string, value: string) =>
    patch(invitationId, (d) => ({
      ...d,
      custom: { ...d.custom, [personId]: { ...d.custom[personId], [key]: value } },
    }));
  const answerOf = (e: PartyEventFacts, memberId: string) =>
    draft[e.invitationId]?.answers[memberId];

  let body: ReactNode;
  if (screen === "closed") {
    body = (
      <section className="space-y-5">
        <StepHeading title="Your reply" focusKey={focusKey} />
        <ErrorMessage message={errorMessage} />
        <p className="text-body-md">
          The reply date has passed for every event, so answers can&apos;t be changed here. Please
          contact the couple.
        </p>
        <ReviewSections facts={facts} draft={draft} byId={byId} mode="saved" />
      </section>
    );
  } else if (screen === "confirmation") {
    body = (
      <section className="space-y-5">
        <StepHeading title="Thank you. Your reply is saved." focusKey={focusKey} />
        <ReviewSections facts={facts} draft={draft} byId={byId} mode="saved" />
        {removed.length > 0 && (
          <p className="text-body-md">
            {removed.join(" and ")} {removed.length === 1 ? "was" : "were"} removed from your reply.
          </p>
        )}
        <ChangeUntil events={open.map((e) => byId.get(e.invitationId)).filter(isEvent)} />
        {view.addToCalendar && (
          <AddToCalendar
            weddingName={view.weddingName}
            events={view.events.map((e) => ({
              name: e.event.name,
              localDate: e.event.localDate,
              attending: e.members.some((m) => m.status === "accepted"),
            }))}
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
        <p className="text-body-md text-ink-muted">Choose an answer for each person and event.</p>
        {problem?.field === "attendance" && (
          <p id={ATTENDANCE_ERROR_ID} role="alert" className="text-body-md text-danger">
            {problem.message}
          </p>
        )}
        {open.map((e) => (
          <EventFieldset key={e.invitationId} event={byId.get(e.invitationId)}>
            {e.members.map((m) => (
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
                        checked={answerOf(e, m.id)?.status === value}
                        onChange={() => setAnswer(e.invitationId, m.id, { status: value })}
                        className={choiceInput}
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
          </EventFieldset>
        ))}
        {closedEvents.length > 0 && (
          <p className="text-body-sm text-ink-muted">
            The reply date has passed for {closedEvents.map((e) => e.name).join(", ")}, so those
            answers can&apos;t be changed here. They are shown in Review.
          </p>
        )}
        <StepButtons />
      </StepForm>
    );
  } else if (screen === "meals") {
    body = (
      <StepForm onSubmit={next}>
        <StepHeading title={RSVP_STEP_TITLES.meals} step={stepInfo("meals")} focusKey={focusKey} />
        {eventsForStep(facts, draft, "meals").map((e) => {
          const notComing = e.members.filter((m) => answerOf(e, m.id)?.status !== "accepted");
          return (
            <EventFieldset key={e.invitationId} event={byId.get(e.invitationId)}>
              {e.members
                .filter((m) => answerOf(e, m.id)?.status === "accepted")
                .map((m) => (
                  <fieldset key={m.id} className="space-y-2">
                    <legend className="mb-2 text-label-lg font-semibold">
                      {m.name}
                      {m.isPlusOne ? " (plus-one)" : ""}
                    </legend>
                    <div className="grid gap-2">
                      {[...e.mealOptions, { id: "", name: "Decide later" }].map((o) => (
                        <label key={o.id || "later"} className={choiceCard}>
                          <input
                            type="radio"
                            name={`meal-${m.id}`}
                            value={o.id}
                            checked={(answerOf(e, m.id)?.mealOptionId ?? "") === o.id}
                            onChange={() =>
                              setAnswer(e.invitationId, m.id, { mealOptionId: o.id || null })
                            }
                            className={choiceInput}
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
                      {answerOf(e, m.id)?.status === "declined"
                        ? "isn't attending, so no meal is needed."
                        : "has no answer yet, so no meal is asked for."}
                    </li>
                  ))}
                </ul>
              )}
            </EventFieldset>
          );
        })}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "details") {
    const people = detailsPeople(facts, draft);
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.details}
          step={stepInfo("details")}
          focusKey={focusKey}
        />
        <DetailsPrivacyNote />
        {open.length > 1 && (
          <p className="text-body-md text-ink-muted">
            Each person is asked once. It applies to every event they are attending.
          </p>
        )}
        {people.map((p) => (
          <fieldset key={p.key} className="space-y-3">
            <legend className="mb-2 text-label-lg font-semibold">
              {p.name}
              {p.isPlusOne ? " (plus-one)" : ""}
            </legend>
            <DetailsFields
              value={p.value}
              saved={p.saved}
              onChange={(change) => setDetails(p.key, change)}
            />
          </fieldset>
        ))}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "plusOne") {
    const plusEvents = eventsForStep(facts, draft, "plusOne");
    body = (
      <StepForm onSubmit={next}>
        <StepHeading
          title={RSVP_STEP_TITLES.plusOne}
          step={stepInfo("plusOne")}
          focusKey={focusKey}
        />
        {plusEvents.length > 1 && (
          <p className="text-body-md text-ink-muted">
            If the same person is coming to more than one event, use the same name each time.
          </p>
        )}
        {plusEvents.map((e) => {
          const d = draft[e.invitationId];
          if (!d) return null;
          const remaining = plusOnePlaces(e, d);
          const invalid =
            problem?.field === "plusOneName" && problem.invitationId === e.invitationId;
          return (
            <EventFieldset key={e.invitationId} event={byId.get(e.invitationId)}>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-body-md text-ink-muted">
                  You may bring {remaining} {remaining === 1 ? "guest" : "guests"}.
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
                      name={`plus-one-choice-${e.invitationId}`}
                      checked={d.plusOne.bringing === value}
                      onChange={() =>
                        patch(e.invitationId, (x) => ({
                          ...x,
                          plusOne: { ...x.plusOne, bringing: value },
                        }))
                      }
                      className={choiceInput}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              {d.plusOne.bringing && (
                <div className="space-y-4">
                  <TextField
                    label="Guest's full name"
                    value={d.plusOne.name}
                    maxLength={PLUS_ONE_NAME_MAX}
                    autoComplete="off"
                    error={invalid ? problem.message : undefined}
                    onChange={(ev) => {
                      const name = ev.currentTarget.value;
                      patch(e.invitationId, (x) => ({ ...x, plusOne: { ...x.plusOne, name } }));
                    }}
                  />
                  {e.mealOptions.length > 0 && (
                    <SelectField
                      label="Their meal choice"
                      value={d.plusOne.mealOptionId ?? ""}
                      onChange={(ev) => {
                        const id = ev.currentTarget.value;
                        patch(e.invitationId, (x) => ({
                          ...x,
                          plusOne: { ...x.plusOne, mealOptionId: id || null },
                        }));
                      }}
                    >
                      <option value="">Decide later</option>
                      {e.mealOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </SelectField>
                  )}
                  {e.askDetails && (
                    <>
                      <DetailsPrivacyNote />
                      <DetailsFields
                        value={{
                          dietary: d.plusOne.dietary,
                          accessibility: d.plusOne.accessibility,
                        }}
                        saved={false}
                        onChange={(change) =>
                          patch(e.invitationId, (x) => ({
                            ...x,
                            plusOne: { ...x.plusOne, ...change },
                          }))
                        }
                      />
                    </>
                  )}
                </div>
              )}
            </EventFieldset>
          );
        })}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "questions") {
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
        {eventsForStep(facts, draft, "questions").map((e) => {
          const d = draft[e.invitationId];
          if (!d) return null;
          const mine = problem?.field === "questions" && problem.invitationId === e.invitationId;
          return (
            <EventFieldset key={e.invitationId} event={byId.get(e.invitationId)}>
              {questionPeople(e, d).map((p) => (
                <fieldset key={p.id} className="space-y-3">
                  <legend className="mb-2 text-label-lg font-semibold">{p.name}</legend>
                  <QuestionFields
                    questions={e.form?.questions ?? []}
                    idPrefix={`${e.invitationId}-${p.id}`}
                    value={d.custom[p.id]}
                    answered={p.answered}
                    invalidKey={
                      mine && problem.target?.startsWith(`${p.id}:`)
                        ? problem.target.slice(p.id.length + 1)
                        : null
                    }
                    invalidMessage={mine ? problem.message : null}
                    onChange={(key, value) => setCustom(e.invitationId, p.id, key, value)}
                  />
                </fieldset>
              ))}
            </EventFieldset>
          );
        })}
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else if (screen === "stay") {
    body = (
      <StepForm onSubmit={next}>
        <StepHeading title={RSVP_STEP_TITLES.stay} step={stepInfo("stay")} focusKey={focusKey} />
        <StayFields
          hotels={partyHotels(facts)}
          value={partyStay(facts, draft)}
          onChange={(value) => setDraft((d) => setPartyStay(facts, d, value))}
        />
        <StepButtons onBack={back} />
      </StepForm>
    );
  } else {
    const replies = buildPartySubmission(facts, draft);
    const notes = partySkippedNotes(facts, draft);
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
        <ErrorMessage message={errorMessage} />
        <ReviewSections facts={facts} draft={draft} byId={byId} />
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
          {steps.includes("stay") && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={() => go("stay")}>
              Edit where you&apos;re staying
            </Button>
          )}
        </div>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="replies" value={JSON.stringify(replies)} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : answeredBefore ? "Update my reply" : "Send my reply"}
          </Button>
          <Button variant="outline" disabled={pending} onClick={back}>
            Back
          </Button>
        </div>
        <ReplyBy events={open.map((e) => byId.get(e.invitationId)).filter(isEvent)} />
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

const isEvent = (e: RsvpPartyEvent | undefined): e is RsvpPartyEvent => e !== undefined;

function EventTitle({ event }: { event: RsvpPartyEvent | undefined }) {
  if (!event) return null;
  const date = formatEventDate(event.event.localDate);
  return (
    <>
      {event.event.name}
      {date && <span className="font-normal text-ink-muted"> · {date}</span>}
    </>
  );
}

function EventFieldset({
  event,
  children,
}: {
  event: RsvpPartyEvent | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-4 rounded-card border border-border-hairline p-4">
      <legend className="px-1 font-serif text-headline-sm">
        <EventTitle event={event} />
      </legend>
      {children}
    </fieldset>
  );
}

function ReviewSections({
  facts,
  draft,
  byId,
  mode = "draft",
}: {
  facts: PartyRsvpFacts;
  draft: PartyDraft;
  byId: Map<string, RsvpPartyEvent>;
  mode?: "draft" | "saved";
}) {
  return (
    <div className="space-y-4">
      {partyReviewSections(facts, draft, mode).map((s) => (
        <section key={s.invitationId} className="space-y-2" aria-label={s.name}>
          <h3 className="font-serif text-headline-sm">
            <EventTitle event={byId.get(s.invitationId)} />
          </h3>
          {s.closed && (
            <p className="text-body-sm text-ink-muted">
              Reply date passed. Please contact the couple to change these answers.
            </p>
          )}
          <Summary lines={s.lines} />
        </section>
      ))}
    </div>
  );
}

function ReplyBy({ events }: { events: RsvpPartyEvent[] }) {
  const dated = events.filter((e) => e.deadline);
  if (dated.length === 0) return null;
  return (
    <ul className="space-y-1 text-body-sm text-ink-muted">
      {dated.map((e) => (
        <li key={e.invitationId}>
          Please reply for {e.event.name} by{" "}
          <ZonedDate iso={e.deadline ?? ""} timeZone={e.event.timezone} />.
        </li>
      ))}
    </ul>
  );
}

function ChangeUntil({ events }: { events: RsvpPartyEvent[] }) {
  const dated = events.filter((e) => e.deadline);
  if (dated.length === 0) {
    return <p className="text-body-md">You can change it any time using this link.</p>;
  }
  return (
    <div className="space-y-1 text-body-md">
      <p>You can change it using this link:</p>
      <ul className="list-disc space-y-1 pl-6">
        {events.map((e) => (
          <li key={e.invitationId}>
            {e.event.name}:{" "}
            {e.deadline ? (
              <>
                until the end of <ZonedDate iso={e.deadline} timeZone={e.event.timezone} />
              </>
            ) : (
              "any time"
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
