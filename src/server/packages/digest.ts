import "server-only";
import { createHash } from "node:crypto";
import { digestInput, type PackageDocument } from "@/domain/packages/document";

export function documentDigest(doc: PackageDocument): string {
  return createHash("sha256").update(digestInput(doc)).digest("hex");
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
