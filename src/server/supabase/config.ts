import "server-only";
import { z } from "zod";
import { readSupabaseConfig as readRaw } from "./config-edge";

const schema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  publishableKey: z.string().min(20),
});

export type SupabaseConfig = z.infer<typeof schema>;

export class AuthUnconfiguredError extends Error {
  constructor() {
    super(
      "Sign-in is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see .env.example).",
    );
    this.name = "AuthUnconfiguredError";
  }
}

/** Returns null when unset or malformed so pages can show an honest unconfigured state. */
export function readSupabaseConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = schema.safeParse(readRaw(env));
  return parsed.success ? parsed.data : null;
}

export function requireSupabaseConfig(): SupabaseConfig {
  const config = readSupabaseConfig();
  if (!config) throw new AuthUnconfiguredError();
  return config;
}
