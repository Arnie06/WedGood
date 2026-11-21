"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { buttonClasses } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";

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
  showArchived,
  filtering,
}: {
  base: string;
  q: string;
  age: string;
  tag: string;
  allTags: readonly string[];
  showArchived: boolean;
  filtering: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function apply() {
    const form = formRef.current;
    if (!form) return;
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
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
      className="space-y-3"
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
        autoComplete="off"
        maxLength={100}
        onChange={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(apply, 300);
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>
      <div className="flex flex-wrap gap-3">
        <noscript>
          <button type="submit" className={buttonClasses({ variant: "secondary" })}>
            Apply filters
          </button>
        </noscript>
        {(filtering || showArchived) && (
          <button type="button" onClick={clear} className={buttonClasses({ variant: "outline" })}>
            Clear
          </button>
        )}
      </div>
    </form>
  );
}
