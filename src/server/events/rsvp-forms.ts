import "server-only";
import { parseDefinition, type FormDefinition } from "@/domain/guests/rsvp-form";
import { createUserClient } from "@/server/supabase/server";

/** One event's form as the planner sees it (UX-11). */
export type EventRsvpForm = {
  /** 0 when the couple has never saved a draft for this event. */
  version: number;
  draft: FormDefinition;
  published: {
    id: string;
    version: number;
    definition: FormDefinition;
    publishedAt: string;
  } | null;
  /** Every published definition, oldest first; used to lock question types. */
  history: FormDefinition[];
};

export type RsvpAnswerRow = {
  eventId: string;
  memberId: string;
  guestId: string;
  questionKey: string;
  value: string;
};

const EMPTY: EventRsvpForm = { version: 0, draft: { questions: [] }, published: null, history: [] };

/**
 * Forms, published versions and answers for every event of the workspace. RLS limits all three
 * tables to people who can manage guests; callers check `guests.manage` first. A stored definition
 * that does not parse is a server error, not an empty form.
 */
export async function loadRsvpForms(workspaceId: string): Promise<{
  byEvent: (eventId: string) => EventRsvpForm;
  answers: RsvpAnswerRow[];
}> {
  const supabase = await createUserClient();
  const [forms, versions, answers] = await Promise.all([
    supabase
      .from("rsvp_forms")
      .select("id, event_id, version, draft, published_version_id")
      .eq("wedding_id", workspaceId),
    supabase
      .from("rsvp_form_versions")
      .select("id, form_id, version, definition, published_at")
      .eq("wedding_id", workspaceId)
      .order("version"),
    supabase
      .from("rsvp_answers")
      .select("event_id, member_id, guest_id, question_key, value")
      .eq("wedding_id", workspaceId)
      .limit(20_000),
  ]);
  if (forms.error || versions.error || answers.error) {
    throw new Error("Could not load RSVP forms");
  }
  const parse = (raw: unknown): FormDefinition => {
    const def = parseDefinition(raw);
    if (!def) throw new Error("Stored RSVP form is not valid");
    return def;
  };
  const map = new Map<string, EventRsvpForm>();
  for (const f of forms.data) {
    const mine = versions.data.filter((v) => v.form_id === f.id);
    const current = mine.find((v) => v.id === f.published_version_id);
    map.set(f.event_id, {
      version: f.version,
      draft: parse(f.draft),
      published: current
        ? {
            id: current.id,
            version: current.version,
            definition: parse(current.definition),
            publishedAt: current.published_at,
          }
        : null,
      history: mine.map((v) => parse(v.definition)),
    });
  }
  return {
    byEvent: (eventId) => map.get(eventId) ?? EMPTY,
    answers: answers.data.map((a) => ({
      eventId: a.event_id,
      memberId: a.member_id,
      guestId: a.guest_id,
      questionKey: a.question_key,
      value: a.value,
    })),
  };
}
