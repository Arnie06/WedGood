import { describe, expect, it } from "vitest";
import { safeNextPath } from "./redirects";

describe("safeNextPath", () => {
  it("keeps same-site paths with query strings", () => {
    expect(safeNextPath("/app/abc?tab=1")).toBe("/app/abc?tab=1");
    expect(safeNextPath("/invite/token")).toBe("/invite/token");
  });
  it.each([
    null,
    undefined,
    "",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "app/relative",
    "/ok\nSet-Cookie: x=1",
  ])("falls back for %j", (value) => {
    expect(safeNextPath(value)).toBe("/app");
  });
});
