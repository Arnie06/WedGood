import { z } from "zod";

/**
 * Public (browser-safe) configuration. Only NEXT_PUBLIC_* values belong here;
 * server secrets get a separate server-only schema when the first server
 * integration lands (R0-03).
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .url({ protocol: /^https?$/, message: "NEXT_PUBLIC_APP_URL must be an http(s) URL" })
    .optional(),
  NEXT_PUBLIC_SUPABASE_URL: z
    .url({ protocol: /^https?$/, message: "NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL" })
    .optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(20, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY looks too short to be a key")
    .optional(),
});

export type PublicEnv = {
  appUrl: URL;
  /** Null when sign-in is intentionally unconfigured (honest "not configured" UI). */
  supabase: { url: URL; publishableKey: string } | null;
};

const DEV_APP_URL = "http://localhost:3000";

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

type EnvSource = Record<string, string | undefined>;

/**
 * Validates public configuration. In production the app URL is required and
 * must use https; in development/test a localhost default is used.
 */
export function parsePublicEnv(source: EnvSource, nodeEnv = source.NODE_ENV): PublicEnv {
  const blankToUndefined = (value: string | undefined) =>
    value === undefined || value.trim() === "" ? undefined : value.trim();

  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_APP_URL: blankToUndefined(source.NEXT_PUBLIC_APP_URL),
    NEXT_PUBLIC_SUPABASE_URL: blankToUndefined(source.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: blankToUndefined(
      source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  });
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((issue) => issue.message));
  }

  const { NEXT_PUBLIC_APP_URL: raw, ...supa } = result.data;
  const production = nodeEnv === "production";
  const supabase = parseSupabase(supa, production);

  if (production) {
    if (raw === undefined) {
      throw new EnvValidationError(["NEXT_PUBLIC_APP_URL is required in production"]);
    }
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new EnvValidationError(["NEXT_PUBLIC_APP_URL must use https in production"]);
    }
    return { appUrl: url, supabase };
  }

  return { appUrl: new URL(raw ?? DEV_APP_URL), supabase };
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Both values or neither: a half-configured pair is an error, never a silent fallback. */
function parseSupabase(
  values: {
    NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  },
  production: boolean,
): PublicEnv["supabase"] {
  const rawUrl = values.NEXT_PUBLIC_SUPABASE_URL;
  const key = values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (rawUrl === undefined && key === undefined) return null;
  if (rawUrl === undefined || key === undefined) {
    throw new EnvValidationError([
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set together",
    ]);
  }
  const url = new URL(rawUrl);
  if (production && url.protocol !== "https:" && !isLoopback(url)) {
    throw new EnvValidationError(["NEXT_PUBLIC_SUPABASE_URL must use https in production"]);
  }
  return { url, publishableKey: key };
}
