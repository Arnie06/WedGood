import { describe, expect, it } from "vitest";
import { BLOCKED_SITES, siteDecision } from "./site-rules";

describe("siteDecision", () => {
  it("allows everything by default (no sites are blocked yet)", () => {
    expect(BLOCKED_SITES).toEqual([]);
    expect(siteDecision("example.com")).toEqual({ allowed: true });
  });

  const rules = [{ host: "blocked.example", reason: "Terms do not allow reading this site." }];
  it("blocks the host, its subdomains and the www form, case-insensitively", () => {
    for (const h of [
      "blocked.example",
      "WWW.Blocked.Example",
      "a.b.blocked.example",
      "blocked.example.",
    ])
      expect(siteDecision(h, rules)).toEqual({ allowed: false, reason: rules[0]!.reason });
  });

  it("does not block look-alike hosts", () => {
    for (const h of ["notblocked.example", "blocked.example.evil.com", "example"])
      expect(siteDecision(h, rules)).toEqual({ allowed: true });
  });
});
