import type { PageDetails } from "./extract";

export type LookupFormValues = {
  name: string;
  location: string;
  sourceUrl: string;
  sourceCheckedOn: string;
  notes: string;
};

export type AppliedLookup = {
  values: LookupFormValues;
  /** Human labels of the fields that were filled, in form order. */
  filled: string[];
};

/**
 * Applies a page lookup to the form. It only ever fills fields the member has left
 * empty, so nothing they typed is overwritten. Never touches price, capacity or any
 * availability or rating field. Notes are labelled as coming from the page.
 */
export function applyLookup(
  current: LookupFormValues,
  details: PageDetails,
  finalUrl: string,
  today: string,
): AppliedLookup {
  const values = { ...current };
  const filled: string[] = [];
  const fill = (key: keyof LookupFormValues, label: string, next: string | null) => {
    if (next && current[key].trim() === "") {
      values[key] = next;
      filled.push(label);
    }
  };
  fill("name", "Name", details.name);
  fill("location", "Location", details.location);
  fill("sourceUrl", "Source link", finalUrl);
  fill("sourceCheckedOn", "Source last checked", today);
  const noteBits = [
    details.description ? `From ${details.host}: ${details.description}` : null,
    details.phone ? `Phone on their page: ${details.phone}` : null,
  ].filter((p): p is string => p !== null);
  fill("notes", "Notes", noteBits.length > 0 ? noteBits.join("\n") : null);
  return { values, filled };
}
