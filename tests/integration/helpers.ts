import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { z } from "zod";

type LocalStack = { apiUrl: string; publishableKey: string; secretKey: string; dbUrl: string };

let cached: LocalStack | undefined;

function loadStack(): LocalStack {
  const env = process.env;
  if (env.TEST_API_URL && env.TEST_PUBLISHABLE_KEY && env.TEST_SECRET_KEY && env.TEST_DB_URL) {
    return {
      apiUrl: env.TEST_API_URL,
      publishableKey: env.TEST_PUBLISHABLE_KEY,
      secretKey: env.TEST_SECRET_KEY,
      dbUrl: env.TEST_DB_URL,
    };
  }
  const out = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const json = z
    .object({
      API_URL: z.string(),
      PUBLISHABLE_KEY: z.string(),
      SECRET_KEY: z.string(),
      DB_URL: z.string(),
    })
    .parse(JSON.parse(out.slice(out.indexOf("{"))));
  return {
    apiUrl: json.API_URL,
    publishableKey: json.PUBLISHABLE_KEY,
    secretKey: json.SECRET_KEY,
    dbUrl: json.DB_URL,
  };
}

/** Reads connection details from env, else from `supabase status` (local stack only). */
export function localStack(): LocalStack {
  if (cached) return cached;
  const stack = loadStack();
  const host = new URL(stack.apiUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Integration tests only run against the local stack");
  }
  cached = stack;
  return stack;
}

export function anonClient(): SupabaseClient {
  const s = localStack();
  return createClient(s.apiUrl, s.publishableKey, { auth: { persistSession: false } });
}

export function adminClient(): SupabaseClient {
  const s = localStack();
  return createClient(s.apiUrl, s.secretKey, { auth: { persistSession: false } });
}

export type TestUser = { id: string; email: string; client: SupabaseClient };

/** Creates a confirmed user through the real Auth admin API and signs in. */
export async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, email, client };
}

export async function withSuperuser<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: localStack().dbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function createWedding(
  user: TestUser,
  overrides: Partial<{
    name: string;
    tz: string;
    cur: string;
    date: string | null;
    key: string | null;
    budgetMinor: number | null;
    guests: number | null;
    location: string | null;
  }> = {},
): Promise<string> {
  const { data, error } = await user.client.rpc("create_wedding", {
    p_name: overrides.name ?? "Test Wedding",
    p_timezone: overrides.tz ?? "America/Chicago",
    p_base_currency: overrides.cur ?? "USD",
    p_date: overrides.date ?? null,
    p_idempotency_key: overrides.key ?? null,
    ...(overrides.budgetMinor != null && { p_target_budget_minor: overrides.budgetMinor }),
    ...(overrides.guests != null && { p_target_guest_count: overrides.guests }),
    ...(overrides.location != null && { p_location: overrides.location }),
  });
  if (error) throw new Error(error.message);
  return data as string;
}
