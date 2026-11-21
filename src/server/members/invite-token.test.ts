import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken, isWellFormedInviteToken } from "./invite-token";

describe("invite tokens", () => {
  it("generates unique 256-bit tokens whose hash is a SHA-256 hex digest", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw).toHaveLength(43);
    expect(isWellFormedInviteToken(a.raw)).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(a.raw)).toBe(a.hash);
    expect(a.hash).not.toContain(a.raw);
  });

  it("rejects malformed tokens before any lookup", () => {
    for (const bad of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`, "../etc/passwd"]) {
      expect(isWellFormedInviteToken(bad)).toBe(false);
    }
  });
});
