import { createHash, randomBytes } from "node:crypto";

export type InviteToken = { raw: string; hash: string };

const RAW_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 256-bit random token; only its SHA-256 digest is ever sent to the database. */
export function generateInviteToken(): InviteToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isWellFormedInviteToken(raw: string): boolean {
  return RAW_PATTERN.test(raw);
}
