"use client";

import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { EVENT_KIND_LABELS, formatEventDate, type EventKind } from "@/domain/events/event";
import {
  FAQ_SLOTS,
  LIMITS,
  REGISTRY_SLOTS,
  TEMPLATES,
  TEMPLATE_LABELS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  eventField,
  type SiteDraft,
} from "@/domain/website/site";
import {
  publishSite,
  saveSite,
  unpublishSite,
  type WebsiteActionState,
} from "@/server/website/actions";

const idle: WebsiteActionState = { status: "idle" };

function Feedback({ state }: { state: WebsiteActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

export type EventChoice = { id: string; name: string; kind: string; localDate: string | null };

export function SiteForm({
  workspaceId,
  version,
  draft,
  events,
  lodging = null,
}: {
  workspaceId: string;
  version: number;
  draft: SiteDraft;
  events: EventChoice[];
  /** UX-17: present when lodging is on; how many hotels are marked for guests. */
  lodging?: { shown: number } | null;
}) {
  const [state, formAction, pending] = useTrayActionState(saveSite, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const val = (name: string, fallback: string | undefined) => echoed?.[name] ?? fallback ?? "";

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="version" value={version} />

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">The basics</legend>
        <SelectField
          label="Template"
          name="template"
          defaultValue={val("template", draft.template)}
          error={errors.template}
        >
          {TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {TEMPLATE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Title"
          name="title"
          required
          maxLength={LIMITS.title}
          autoComplete="off"
          defaultValue={val("title", draft.title)}
          error={errors.title}
        />
        <TextField
          label="Tagline"
          name="tagline"
          maxLength={LIMITS.tagline}
          autoComplete="off"
          defaultValue={val("tagline", draft.tagline)}
          error={errors.tagline}
        />
        <TextField
          label="Date to show"
          hint="Leave blank to keep the date off the website."
          name="date"
          type="date"
          defaultValue={val("date", draft.date)}
          error={errors.date}
        />
        <TextField
          label="Place to show"
          hint="A city or venue name. Add an address only if you want everyone to have it."
          name="location"
          maxLength={LIMITS.location}
          autoComplete="off"
          defaultValue={val("location", draft.location)}
          error={errors.location}
        />
        <TextAreaField
          label="Our story"
          name="story"
          rows={5}
          maxLength={LIMITS.story}
          defaultValue={val("story", draft.story)}
          error={errors.story}
        />
        <TextAreaField
          label="Travel and stay"
          name="travel"
          rows={4}
          maxLength={LIMITS.travel}
          defaultValue={val("travel", draft.travel)}
          error={errors.travel}
        />
        {lodging && (
          <label className="flex min-h-11 items-start gap-3 text-body-md">
            <input
              type="checkbox"
              name="hotels"
              defaultChecked={echoed ? echoed.hotels === "on" : draft.hotels === true}
              className="mt-1 size-5 shrink-0 accent-action-secondary"
            />
            <span>
              Show the hotels you marked for guests
              <span className="block text-body-sm text-ink-muted">
                {lodging.shown === 0
                  ? "No hotels are marked for guests yet. Mark them in Lodging."
                  : `${lodging.shown} ${lodging.shown === 1 ? "hotel" : "hotels"} marked for guests in Lodging. Names, addresses, booking details and book-by dates are shown; rooms held and bookings never are.`}
              </span>
            </span>
          </label>
        )}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">Events</legend>
        <p className="text-body-md text-ink-muted">
          Choose which events appear and who can see them. Guests only ever see events they are
          allowed to, and only the details written here.
        </p>
        {events.length === 0 && (
          <p className="text-body-md">
            You haven&apos;t added any events yet. Add them under Guests, then Events and
            invitations.
          </p>
        )}
        {events.map((e) => {
          const existing = draft.events.find((x) => x.eventId === e.id);
          const date = formatEventDate(e.localDate);
          const kind = (e.kind in EVENT_KIND_LABELS ? e.kind : "other") as EventKind;
          return (
            <div
              key={e.id}
              role="group"
              aria-label={e.name}
              className="space-y-3 rounded-card border border-border-hairline p-4"
            >
              <p className="font-semibold break-words">{e.name}</p>
              <p className="text-body-sm text-ink-muted">
                {EVENT_KIND_LABELS[kind]}
                {date ? ` · ${date}` : ""}
              </p>
              <SelectField
                label="Who can see it"
                name={eventField(e.id, "visibility")}
                defaultValue={val(eventField(e.id, "visibility"), existing?.visibility ?? "hidden")}
                error={errors[`event_${e.id}`]}
              >
                {VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Time"
                name={eventField(e.id, "when")}
                maxLength={LIMITS.eventWhen}
                autoComplete="off"
                defaultValue={val(eventField(e.id, "when"), existing?.when)}
              />
              <TextField
                label="Where"
                name={eventField(e.id, "where")}
                maxLength={LIMITS.eventWhere}
                autoComplete="off"
                defaultValue={val(eventField(e.id, "where"), existing?.where)}
              />
              <TextAreaField
                label="Notes"
                hint="For example dress code or parking."
                name={eventField(e.id, "notes")}
                rows={2}
                maxLength={LIMITS.eventNotes}
                defaultValue={val(eventField(e.id, "notes"), existing?.notes)}
              />
            </div>
          );
        })}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">Questions and answers</legend>
        {Array.from({ length: FAQ_SLOTS }, (_, i) => (
          <div key={i} className="space-y-3 rounded-card border border-border-hairline p-4">
            <TextField
              label={`Question ${i + 1}`}
              name={`faq_q_${i}`}
              maxLength={LIMITS.faqQuestion}
              autoComplete="off"
              defaultValue={val(`faq_q_${i}`, draft.faq[i]?.q)}
              error={errors[`faq_${i}`]}
            />
            <TextAreaField
              label={`Answer ${i + 1}`}
              name={`faq_a_${i}`}
              rows={2}
              maxLength={LIMITS.faqAnswer}
              defaultValue={val(`faq_a_${i}`, draft.faq[i]?.a)}
            />
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-serif text-headline-sm">Registry links</legend>
        <p className="text-body-md text-ink-muted">
          Links open in a new tab and must start with https://. We never open them for you.
        </p>
        {Array.from({ length: REGISTRY_SLOTS }, (_, i) => (
          <div key={i} className="space-y-3 rounded-card border border-border-hairline p-4">
            <TextField
              label={`Registry name ${i + 1}`}
              name={`reg_label_${i}`}
              maxLength={LIMITS.registryLabel}
              autoComplete="off"
              defaultValue={val(`reg_label_${i}`, draft.registry[i]?.label)}
              error={errors[`reg_${i}`]}
            />
            <TextField
              label={`Registry link ${i + 1}`}
              name={`reg_url_${i}`}
              type="url"
              inputMode="url"
              maxLength={LIMITS.url}
              autoComplete="off"
              defaultValue={val(`reg_url_${i}`, draft.registry[i]?.url)}
            />
          </div>
        ))}
      </fieldset>

      <div className="space-y-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function PublishForm({
  workspaceId,
  version,
  suggestedSlug,
  currentSlug,
  republish,
}: {
  workspaceId: string;
  version: number;
  suggestedSlug: string;
  currentSlug: string | null;
  republish: boolean;
}) {
  const [state, formAction, pending] = useTrayActionState(publishSite, idle);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="version" value={version} />
      <TextField
        label="Web address"
        hint="Your page will be at /w/ followed by this. Lowercase letters, numbers and hyphens."
        name="slug"
        required
        maxLength={40}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        defaultValue={echoed?.slug ?? currentSlug ?? suggestedSlug}
        error={errors.slug}
      />
      <div className="space-y-1.5">
        <label className="flex min-h-11 items-start gap-3 text-body-md">
          <input
            type="checkbox"
            name="confirm"
            value="yes"
            className="mt-1 size-5 shrink-0 accent-[var(--color-action-secondary)]"
            aria-describedby={errors.confirm ? "confirm-error" : undefined}
          />
          <span>
            I&apos;ve previewed the saved draft and I want it to be public. Anyone with the web
            address can read it.
          </span>
        </label>
        {errors.confirm && (
          <p id="confirm-error" role="alert" className="text-body-md text-danger">
            Please confirm before publishing.
          </p>
        )}
      </div>
      <Button type="submit" variant="emphasis" disabled={pending}>
        {pending ? "Publishing…" : republish ? "Publish changes" : "Publish website"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function UnpublishForm({ workspaceId, version }: { workspaceId: string; version: number }) {
  const [state, formAction, pending] = useTrayActionState(unpublishSite, idle);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Unpublishing…" : "Unpublish website"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
