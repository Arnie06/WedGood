import { describe, expect, it } from "vitest";
import { applyLookup, type LookupFormValues } from "./apply";
import type { PageDetails } from "./extract";

const empty: LookupFormValues = {
  name: "",
  location: "",
  sourceUrl: "",
  sourceCheckedOn: "",
  notes: "",
};
const details: PageDetails = {
  name: "Garden House",
  location: "1 Vine Rd, Napa",
  phone: "+1 555 010 0100",
  description: "A walled garden.",
  host: "gardenhouse.com",
};

describe("applyLookup", () => {
  it("fills empty fields, names them, and labels notes as coming from the page", () => {
    const r = applyLookup(empty, details, "https://gardenhouse.com/w", "2027-01-05");
    expect(r.values).toEqual({
      name: "Garden House",
      location: "1 Vine Rd, Napa",
      sourceUrl: "https://gardenhouse.com/w",
      sourceCheckedOn: "2027-01-05",
      notes: "From gardenhouse.com: A walled garden.\nPhone on their page: +1 555 010 0100",
    });
    expect(r.filled).toEqual(["Name", "Location", "Source link", "Source last checked", "Notes"]);
  });

  it("never overwrites what the member already typed", () => {
    const typed = { ...empty, name: "My name", notes: "my note" };
    const r = applyLookup(typed, details, "https://gardenhouse.com/w", "2027-01-05");
    expect(r.values.name).toBe("My name");
    expect(r.values.notes).toBe("my note");
    expect(r.filled).not.toContain("Name");
    expect(r.filled).not.toContain("Notes");
  });

  it("fills nothing it was not given", () => {
    const r = applyLookup(
      empty,
      { ...details, name: null, location: null, phone: null, description: null },
      "https://x.com/",
      "2027-01-05",
    );
    expect(r.values.name).toBe("");
    expect(r.values.notes).toBe("");
    expect(r.filled).toEqual(["Source link", "Source last checked"]);
  });
});
