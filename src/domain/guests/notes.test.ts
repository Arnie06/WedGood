import { describe, expect, it } from "vitest";
import { combineNote } from "./notes";

describe("combineNote", () => {
  it("is null when neither source has text", () => {
    expect(combineNote({ couple: null, guest: null })).toBeNull();
    expect(combineNote({ couple: "  ", guest: "" })).toBeNull();
  });

  it("shows the couple's text alone", () => {
    expect(combineNote({ couple: "Peanut allergy", guest: null })).toBe("Peanut allergy");
  });

  it("marks the guest's text when it is the only one", () => {
    expect(combineNote({ couple: null, guest: "Vegetarian" })).toBe("Guest says: Vegetarian");
  });

  it("keeps both when they differ, couple first", () => {
    expect(combineNote({ couple: "Peanut allergy", guest: "Vegetarian" })).toBe(
      "Peanut allergy · Guest says: Vegetarian",
    );
  });

  it("does not repeat the same words", () => {
    expect(combineNote({ couple: "Vegan", guest: " vegan " })).toBe("Vegan");
  });
});
