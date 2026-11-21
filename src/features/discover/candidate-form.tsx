"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextAreaField } from "@/components/ui/text-area-field";
import { TextField } from "@/components/ui/text-field";
import { PRICE_BASES, VENDOR_CATEGORIES, type CandidateKind } from "@/domain/candidates/categories";
import type { CandidateField } from "@/domain/candidates/input";
import { applyLookup } from "@/domain/links/apply";
import type { CandidateActionState } from "@/server/candidates/actions";
import { lookupLink } from "@/server/links/actions";

export type CandidateFormDefaults = Record<CandidateField, string>;

type Action = (state: CandidateActionState, form: FormData) => Promise<CandidateActionState>;

/** Add and edit share one form; edits carry the candidate id and last-seen version. */
export function CandidateForm({
  action,
  kind,
  currency,
  defaults,
  hidden,
  submitLabel,
  pendingLabel,
  lookupWorkspaceId,
}: {
  action: Action;
  kind: CandidateKind;
  currency: string;
  defaults: CandidateFormDefaults;
  hidden: Record<string, string>;
  submitLabel: string;
  pendingLabel: string;
  /** When set, shows "Paste a link" so details can be prefilled from the page (ADR-029). */
  lookupWorkspaceId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as CandidateActionState);
  const echoed = state.status === "error" ? state.values : undefined;
  const errors = state.status === "error" ? state.fieldErrors : {};
  const v = (k: CandidateField) => echoed?.[k] ?? defaults[k];
  const noun = kind === "venue" ? "venue" : "vendor";
  const formRef = useRef<HTMLFormElement>(null);
  const [linkText, setLinkText] = useState("");
  const [looking, startLookup] = useTransition();
  const [lookupNote, setLookupNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  /** Reads and writes the uncontrolled fields directly, so typed text is never lost. */
  function runLookup() {
    const form = formRef.current;
    if (!form || !lookupWorkspaceId) return;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
    setLookupNote(null);
    startLookup(async () => {
      const result = await lookupLink(lookupWorkspaceId, linkText);
      if (result.status === "error") {
        setLookupNote({ tone: "error", text: result.message });
        return;
      }
      const keys = ["name", "location", "sourceUrl", "sourceCheckedOn", "notes"] as const;
      const current = Object.fromEntries(keys.map((k) => [k, field(k)?.value ?? ""])) as Record<
        (typeof keys)[number],
        string
      >;
      const today = new Date().toLocaleDateString("en-CA");
      const applied = applyLookup(current, result.details, result.finalUrl, today);
      for (const k of keys) {
        const el = field(k);
        if (el && applied.values[k] !== current[k]) {
          el.value = applied.values[k];
          el.setAttribute("data-just-added", "");
          window.setTimeout(() => el.removeAttribute("data-just-added"), 2500);
        }
      }
      const onlyLink = applied.filled.every(
        (f) => f === "Source link" || f === "Source last checked",
      );
      setLookupNote({
        tone: "ok",
        text: onlyLink
          ? "We opened the page but found no details we could use. The link is saved in the form. Please fill in the rest yourself."
          : `Filled from the page: ${applied.filled.join(", ")}. These come from their website, not from us. Please check each one before saving.`,
      });
    });
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="kind" value={kind} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {lookupWorkspaceId && (
        <div className="space-y-3 rounded-card border border-border-hairline p-4">
          <TextField
            label="Paste a link"
            hint={`Optional. Paste the ${noun}'s web page and we'll read its name and details for you to check. Nothing is saved until you press ${submitLabel}.`}
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (linkText.trim() !== "" && !looking) runLookup();
              }
            }}
            type="text"
            inputMode="url"
            autoComplete="off"
            placeholder="https://"
            maxLength={2048}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={looking || linkText.trim() === ""}
            onClick={runLookup}
          >
            {looking ? "Looking…" : "Look up this page"}
          </Button>
          <div aria-live="polite" className="min-h-6">
            {lookupNote && (
              <p
                role={lookupNote.tone === "error" ? "alert" : undefined}
                className={
                  lookupNote.tone === "error"
                    ? "text-body-md text-danger"
                    : "text-body-md text-action-secondary"
                }
              >
                {lookupNote.text}
              </p>
            )}
          </div>
        </div>
      )}
      <TextField
        label="Name"
        name="name"
        required
        maxLength={160}
        autoComplete="off"
        placeholder={kind === "venue" ? "e.g. Garden House" : "e.g. Lantern Photography"}
        defaultValue={v("name")}
        error={errors.name}
      />
      {kind === "vendor" && (
        <SelectField
          label="What do they do?"
          name="category"
          required
          defaultValue={v("category")}
          error={errors.category}
        >
          <option value="">Choose one</option>
          {VENDOR_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label="Location"
        hint="Optional. A city, neighborhood or address."
        name="location"
        maxLength={200}
        autoComplete="off"
        defaultValue={v("location")}
        error={errors.location}
      />
      {kind === "venue" && (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Seated capacity"
            hint="Optional. Leave blank if you don't know yet."
            name="seatedCapacity"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("seatedCapacity")}
            error={errors.seatedCapacity}
          />
          <TextField
            label="Ceremony capacity"
            hint="Optional."
            name="ceremonyCapacity"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v("ceremonyCapacity")}
            error={errors.ceremonyCapacity}
          />
        </div>
      )}
      <fieldset className="space-y-5 rounded-card border border-border-hairline p-4">
        <legend className="px-1 text-label-lg font-semibold">Price you were quoted</legend>
        <p className="text-body-sm text-ink-muted">
          Optional. Leave this blank if you don&apos;t have a number yet; a blank price is shown as
          unknown, never as zero. Amounts are in {currency}.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Amount"
            name="price"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 8500"
            defaultValue={v("price")}
            error={errors.price}
          />
          <SelectField
            label="That price is"
            name="priceBasis"
            defaultValue={v("priceBasis")}
            error={errors.priceBasis}
          >
            <option value="">Choose one</option>
            {PRICE_BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label="Pricing note"
          hint="Optional. For example “From $8,500, plus 22% service”."
          name="pricingDisplay"
          maxLength={200}
          autoComplete="off"
          defaultValue={v("pricingDisplay")}
          error={errors.pricingDisplay}
        />
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Source link"
          hint={`Optional. Where you found this ${noun}. The app only reads a page when you press “Look up this page”.`}
          name="sourceUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          defaultValue={v("sourceUrl")}
          error={errors.sourceUrl}
        />
        <TextField
          label="Source last checked"
          hint="Optional. The day you last looked at it."
          name="sourceCheckedOn"
          type="date"
          defaultValue={v("sourceCheckedOn")}
          error={errors.sourceCheckedOn}
        />
      </div>
      <TextAreaField
        label="Notes"
        name="notes"
        maxLength={2000}
        defaultValue={v("notes")}
        error={errors.notes}
      />
      <div aria-live="polite" className="min-h-6">
        {state.status === "error" && (
          <p role="alert" className="text-body-md text-danger">
            {state.message}
          </p>
        )}
      </div>
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
