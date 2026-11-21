import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Fresh ids for one preview. The package id doubles as the idempotency key, so a retried submit
 * is a replay; the timestamp is fixed here so every retry renders identical files.
 */
export function newPreviewIds() {
  return { packageId: randomUUID(), generatedAt: new Date().toISOString() };
}
