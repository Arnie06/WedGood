import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_LENGTH,
  canDeleteComment,
  isCommentKind,
  parseCommentBody,
  subjectPath,
} from "./comment";

describe("parseCommentBody", () => {
  it("trims and normalizes line endings", () => {
    expect(parseCommentBody("  Love it\r\nreally  ")).toEqual({
      ok: true,
      body: "Love it\nreally",
    });
  });
  it("rejects empty and whitespace-only text", () => {
    expect(parseCommentBody("").ok).toBe(false);
    expect(parseCommentBody(" \n\t ").ok).toBe(false);
  });
  it("accepts the maximum and rejects one more, counting characters not UTF-16 units", () => {
    expect(parseCommentBody("a".repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    expect(parseCommentBody("a".repeat(MAX_COMMENT_LENGTH + 1)).ok).toBe(false);
    expect(parseCommentBody("💐".repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
  });
  it("keeps markup as plain text", () => {
    expect(parseCommentBody("<script>x</script>")).toEqual({
      ok: true,
      body: "<script>x</script>",
    });
  });
});

describe("helpers", () => {
  it("validates kinds", () => {
    expect(isCommentKind("candidate")).toBe(true);
    expect(isCommentKind("guest")).toBe(false);
    expect(isCommentKind(undefined)).toBe(false);
  });
  it("builds paths under the workspace", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(subjectPath("w1", "candidate", id)).toBe(`/app/w1/discover/${id}`);
    expect(subjectPath("w1", "comparison", id)).toBe(`/app/w1/discover/compare/${id}`);
    expect(subjectPath("w1", "design_board", id)).toBe(`/app/w1/design/${id}`);
  });
  it("lets authors and owner/partner delete, nobody else", () => {
    expect(canDeleteComment("viewer", true)).toBe(true);
    expect(canDeleteComment("viewer", false)).toBe(false);
    expect(canDeleteComment("editor", false)).toBe(false);
    expect(canDeleteComment("partner", false)).toBe(true);
    expect(canDeleteComment("owner", false)).toBe(true);
  });
});
