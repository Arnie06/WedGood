"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { cn } from "@/lib/cn";
import { buttonClasses } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { REPLY_FILTERS, REPLY_FILTER_LABELS, type ReplyFilter } from "@/domain/guests/replies";

/**
 * Search and filters that apply as you type or choose, with no "Apply" step. It is still a
 * plain GET form, so it works without JavaScript (the button appears only then).
 */
export function GuestFilters({
  base,
  q,
  age,
  tag,
  allTags,
  events,
  event,
  reply,
  asksMeal,
  showArchived,
  filtering,
}: {
  base: string;
  q: string;
  age: string;
  tag: string;
  allTags: readonly string[];
  /** Events the replies can be shown for. Empty hides the selector. */
  events: readonly { id: string; name: string }[];
  event: string;
  reply: ReplyFilter | "";
  /** The chosen event offers meal choices; otherwise "without a meal" is not offered. */
  asksMeal: boolean;
  showArchived: boolean;
  filtering: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The selects are uncontrolled so they work without JavaScript. When a link or Back changes the
  // address, show the filter that now applies, without remounting (which would drop focus).
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    for (const [name, value] of [
      ["event", event],
      ["reply", reply],
      ["age", age],
      ["tag", tag],
    ] as const) {
      const el = form.elements.namedItem(name);
      if (el instanceof HTMLSelectElement && el.value !== value) el.value = value;
    }
  }, [event, reply, age, tag]);

  function apply() {
    const form = formRef.current;
    if (!form) return;
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    // A reply filter means nothing without an event.
    if (!params.has("event")) params.delete("reply");
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${base}/guests?${query}` : `${base}/guests`, { scroll: false });
    });
  }

  /** Empties the fields themselves (they are uncontrolled), then reloads the unfiltered list. */
  function clear() {
    const form = formRef.current;
    if (form) {
      for (const el of Array.from(form.elements)) {
        if (el instanceof HTMLInputElement && el.type === "search") el.value = "";
        if (el instanceof HTMLSelectElement) el.value = "";
      }
    }
    window.clearTimeout(timer.current);
    startTransition(() => router.replace(`${base}/guests`, { scroll: false }));
  }

  return (
    <form
      ref={formRef}
      method="get"
      action={`${base}/guests`}
      className={cn(
        "grid grid-cols-2 gap-3 lg:items-end",
        events.length === 0
          ? "lg:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]"
          : event === ""
            ? "lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]"
            : "lg:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]",
      )}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      {showArchived && <input type="hidden" name="view" value="archived" />}
      <TextField
        label="Search by name or email"
        name="q"
        type="search"
        defaultValue={q}
        className="col-span-full lg:col-span-1"
        autoComplete="off"
        maxLength={100}
        onChange={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(apply, 300);
        }}
      />
      {events.length > 0 && (
        <>
          <SelectField
            label="Show replies for"
            name="event"
            defaultValue={event}
            onChange={apply}
            className={event === "" ? "col-span-full lg:col-span-1" : undefined}
          >
            <option value="">No event</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectField>
          {event !== "" && (
            <SelectField label="Reply" name="reply" defaultValue={reply} onChange={apply}>
              <option value="">Any reply</option>
              {REPLY_FILTERS.filter((f) => asksMeal || f !== "no_meal").map((f) => (
                <option key={f} value={f}>
                  {REPLY_FILTER_LABELS[f]}
                </option>
              ))}
            </SelectField>
          )}
        </>
      )}
      <SelectField label="Adult or child" name="age" defaultValue={age} onChange={apply}>
        <option value="">Everyone</option>
        <option value="adult">Adults</option>
        <option value="child">Children</option>
      </SelectField>
      <SelectField label="Tag" name="tag" defaultValue={tag} onChange={apply}>
        <option value="">All tags</option>
        {allTags.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </SelectField>
      <noscript className="col-span-full">
        <button type="submit" className={buttonClasses({ variant: "secondary" })}>
          Apply filters
        </button>
      </noscript>
      {(filtering || showArchived) && (
        <div className="col-span-full">
          <button type="button" onClick={clear} className={buttonClasses({ variant: "outline" })}>
            Clear
          </button>
        </div>
      )}
    </form>
  );
}
