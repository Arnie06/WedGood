/**
 * Seeds the LOCAL Supabase stack with clearly fictional demo accounts and one
 * "Example" workspace so a fresh `pnpm db:reset` can be explored by hand.
 *
 * Safety: refuses to run unless the API host is loopback. Idempotent: re-running
 * reuses the users and the wedding (idempotency key). Demo credentials are
 * public, local-only values and must never be used anywhere else.
 */
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { CHECKLIST_TEMPLATE } from "../src/domain/tasks/templates.ts";

const DEMO_PASSWORD = "local-demo-password-not-secret";
const DEMO_USERS = ["alex.example@example.test", "morgan.example@example.test"] as const;

type Stack = { apiUrl: string; publishableKey: string; secretKey: string };

function loadStack(): Stack {
  const { TEST_API_URL, TEST_PUBLISHABLE_KEY, TEST_SECRET_KEY } = process.env;
  if (TEST_API_URL && TEST_PUBLISHABLE_KEY && TEST_SECRET_KEY) {
    return {
      apiUrl: TEST_API_URL,
      publishableKey: TEST_PUBLISHABLE_KEY,
      secretKey: TEST_SECRET_KEY,
    };
  }
  const out = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const json = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string | undefined>;
  const { API_URL, PUBLISHABLE_KEY, SECRET_KEY } = json;
  if (!API_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
    throw new Error("Local Supabase stack is not running (run `pnpm db:start`).");
  }
  return { apiUrl: API_URL, publishableKey: PUBLISHABLE_KEY, secretKey: SECRET_KEY };
}

/** A demo wedding date ~400 days out (offset in days), so the checklist has past and future dates. */
function seedDate(offsetDays = 400): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const stack = loadStack();
  const host = new URL(stack.apiUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to seed non-local host: ${host}`);
  }
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(stack.apiUrl, stack.secretKey, opts);

  const { data: existing, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) throw listError;
  const known = new Set(existing.users.map((u) => u.email));
  for (const email of DEMO_USERS) {
    if (known.has(email)) continue;
    const { error } = await admin.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
  }

  const owner = createClient(stack.apiUrl, stack.publishableKey, opts);
  const signIn = await owner.auth.signInWithPassword({
    email: DEMO_USERS[0],
    password: DEMO_PASSWORD,
  });
  if (signIn.error) throw signIn.error;

  const { data: weddingId, error } = await owner.rpc("create_wedding", {
    p_name: "Example Wedding (fictional sample)",
    p_timezone: "America/New_York",
    p_base_currency: "USD",
    p_date: seedDate(),
    p_location: "Example City (fictional)",
    p_idempotency_key: "seed-local-example-wedding",
  });
  if (error) throw error;

  // Checklist and a few tasks so the plan and dashboard have something to show.
  // Every call is idempotent, so re-running the seed changes nothing.
  const gen = await owner.rpc("generate_checklist", {
    p_wedding: weddingId,
    p_items: CHECKLIST_TEMPLATE.map((t) => ({
      key: t.key,
      title: t.title,
      notes: t.notes ?? null,
      phase: t.phase,
      offsetDays: t.offsetDays,
    })),
  });
  if (gen.error) throw gen.error;
  const manual = [
    ["Example: call the florist", seedDate(-20)],
    ["Example: ask about parking", null],
  ] as const;
  for (const [i, [title, due]] of manual.entries()) {
    const r = await owner.rpc("create_task", {
      p_wedding: weddingId,
      p_title: title,
      p_idempotency_key: `seed-local-task-${i}`,
      ...(due && { p_due_date: due }),
    });
    if (r.error) throw r.error;
  }
  const { data: first } = await owner
    .from("tasks")
    .select("id, version, status")
    .eq("wedding_id", weddingId)
    .eq("template_key", CHECKLIST_TEMPLATE[0]!.key)
    .single();
  if (first && first.status === "open") {
    const r = await owner.rpc("set_task_status", {
      p_wedding: weddingId,
      p_task: first.id,
      p_expected_version: first.version,
      p_done: true,
    });
    if (r.error) throw r.error;
  }

  console.log(`Seeded local demo data. Workspace: /app/${String(weddingId)}`);
  console.log(`Sign in at http://localhost:3000/sign-in`);
  console.log(`  email:    ${DEMO_USERS[0]}`);
  console.log(`  password: ${DEMO_PASSWORD}  (local demo only)`);
  console.log(`Then open http://localhost:3000/app/${String(weddingId)}/plan`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
