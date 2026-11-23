import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES } from "@/domain/permissions";
import { defaultDensity, isDensity, resolveDensity } from "./density";

describe("density", () => {
  it("defaults planners to compact and everyone else to comfortable", () => {
    expect(defaultDensity("editor")).toBe("compact");
    expect(defaultDensity("owner")).toBe("comfortable");
    expect(defaultDensity("partner")).toBe("comfortable");
    expect(defaultDensity("viewer")).toBe("comfortable");
  });

  it("uses a saved choice over the role default", () => {
    expect(resolveDensity("comfortable", "editor")).toBe("comfortable");
    expect(resolveDensity("compact", "owner")).toBe("compact");
  });

  it("ignores missing or unrecognised saved values", () => {
    for (const role of MEMBERSHIP_ROLES) {
      for (const bad of [undefined, null, "", "COMPACT", "dense", 1, {}]) {
        expect(resolveDensity(bad, role)).toBe(defaultDensity(role));
      }
    }
  });

  it("recognises only the two settings", () => {
    expect(isDensity("compact")).toBe(true);
    expect(isDensity("comfortable")).toBe(true);
    expect(isDensity("cozy")).toBe(false);
  });
});
