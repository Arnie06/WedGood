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
});

export type PublicEnv = {
  appUrl: URL;
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
  });
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((issue) => issue.message));
  }

  const raw = result.data.NEXT_PUBLIC_APP_URL;
  if (nodeEnv === "production") {
    if (raw === undefined) {
      throw new EnvValidationError(["NEXT_PUBLIC_APP_URL is required in production"]);
    }
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new EnvValidationError(["NEXT_PUBLIC_APP_URL must use https in production"]);
    }
    return { appUrl: url };
  }

  return { appUrl: new URL(raw ?? DEV_APP_URL) };
}
