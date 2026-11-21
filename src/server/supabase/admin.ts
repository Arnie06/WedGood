import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/database.types";
import { readSupabaseConfig } from "./config";

/**
 * Service-role client for the few operations a user session must not perform itself: writing a
 * validated upload to private storage and marking it complete (R1-08). Never use it to read or
 * write on behalf of a request without first authorizing that request as the signed-in user.
 * Returns null when the server secret is not configured, so callers show an honest state.
 */
export function createAdminClient() {
  const config = readSupabaseConfig();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!config || !secret) return null;
  return createClient<Database>(config.url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * No malware scanner is configured, so validated uploads stay "unscanned". Downloading them is
 * off unless an operator opts in explicitly (local development and the e2e server do).
 */
export function unscannedDownloadsAllowed(): boolean {
  return process.env.DOCUMENTS_ALLOW_UNSCANNED_DOWNLOADS === "true";
}
