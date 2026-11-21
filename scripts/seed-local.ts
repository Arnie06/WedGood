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
    // The listing above is one page; with many test users the demo users can fall outside it.
    if (error && !/already been registered/i.test(error.message)) throw error;
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

  // ---- Richer fictional data so populated screens can be reviewed (UX-06).
  // Everything here is labelled fictional, uses idempotency keys, and never resets anything.
  const check = (label: string, r: { error: { message: string } | null }) => {
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
  };

  // Guests: 12 fictional households, grouped and tagged.
  const FAMILIES: ReadonlyArray<readonly [string, readonly string[], string]> = [
    ["Sample", ["Avery", "Jordan", "Riley (child)"], "Family"],
    ["Placeholder", ["Casey", "Morgan"], "Family"],
    ["Demo", ["Taylor", "Quinn", "Sam (child)", "Lee (child)"], "Family"],
    ["Fiction", ["Robin", "Drew"], "Friends"],
    ["Testwell", ["Alexis", "Jamie"], "Friends"],
    ["Mockford", ["Cameron"], "Work"],
    ["Samplestone", ["Reese", "Parker", "Blake"], "Friends"],
    ["Exampleton", ["Skyler", "Hayden"], "Family"],
    ["Notreal", ["Dakota", "Emery", "Finley (child)"], "Family"],
    ["Fakerton", ["Rowan", "Sage"], "Work"],
    ["Imaginary", ["Kai", "Remy"], "Friends"],
    ["Pretend", ["Logan", "Ari", "Noor", "Eden"], "Friends"],
  ];
  const guestRows = FAMILIES.flatMap(([surname, members, tag]) =>
    members.map((m) => {
      const child = m.includes("(child)");
      const first = m.replace(" (child)", "");
      return {
        name: `${first} ${surname}`,
        household: `The ${surname} household (fictional)`,
        age_group: child ? "child" : "adult",
        tags: [tag],
      };
    }),
  );
  check(
    "guests",
    await owner.rpc("commit_guest_import", {
      p_wedding: weddingId,
      p_rows: guestRows,
      p_idempotency_key: "seed-local-guests-v1",
    }),
  );

  // Events with meal choices, and a seating layout with tables for the reception.
  const eventIds: Record<string, string> = {};
  for (const [name, kind] of [
    ["Ceremony", "ceremony"],
    ["Reception", "reception"],
  ] as const) {
    const r = await owner.rpc("create_event", {
      p_wedding: weddingId,
      p_event: { name, kind, localDate: seedDate() },
      p_idempotency_key: `seed-local-event-${kind}`,
    });
    check(`event ${name}`, r);
    eventIds[kind] = String(r.data);
  }
  const reception = eventIds.reception!;
  const { data: meals } = await owner.from("meal_options").select("name").eq("event_id", reception);
  const haveMeals = new Set((meals ?? []).map((m) => m.name));
  for (const meal of ["Chicken", "Salmon", "Vegetarian plate"]) {
    if (haveMeals.has(meal)) continue;
    check(
      `meal ${meal}`,
      await owner.rpc("add_meal_option", {
        p_wedding: weddingId,
        p_event_id: reception,
        p_name: meal,
      }),
    );
  }
  const layout = await owner.rpc("ensure_seating_layout", {
    p_wedding: weddingId,
    p_event_id: reception,
  });
  check("layout", layout);
  const { data: tables } = await owner
    .from("seating_tables")
    .select("label")
    .eq("layout_id", String(layout.data));
  const haveTables = new Set((tables ?? []).map((t) => t.label));
  for (const label of ["Table 1", "Table 2", "Table 3"]) {
    if (haveTables.has(label)) continue;
    check(
      `table ${label}`,
      await owner.rpc("add_seating_table", {
        p_wedding: weddingId,
        p_layout: String(layout.data),
        p_label: label,
        p_capacity: 8,
      }),
    );
  }

  // Venues and vendors, one with an unknown price on purpose (unknown is never zero).
  const candidates = [
    {
      key: "garden",
      kind: "venue",
      category: "venue",
      name: "Example Garden Estate (fictional)",
      location: "Example City (fictional)",
      seated: 150,
      ceremony: 160,
      price: 1_200_000,
      basis: "total",
    },
    {
      key: "barn",
      kind: "venue",
      category: "venue",
      name: "Sample Barn (fictional)",
      location: "Example County (fictional)",
      seated: 120,
      ceremony: 120,
    },
    {
      key: "photo",
      kind: "vendor",
      category: "photographer",
      name: "Placeholder Photography (fictional)",
      location: "Example City (fictional)",
      price: 350_000,
      basis: "total",
    },
  ] as const;
  for (const c of candidates) {
    check(
      `candidate ${c.key}`,
      await owner.rpc("create_candidate", {
        p_wedding: weddingId,
        p_kind: c.kind,
        p_category: c.category,
        p_name: c.name,
        p_location: c.location,
        p_notes: "Fictional demo entry.",
        p_idempotency_key: `seed-local-candidate-${c.key}`,
        ...("seated" in c && { p_seated_capacity: c.seated, p_ceremony_capacity: c.ceremony }),
        ...("price" in c && { p_price_minor: c.price, p_price_basis: c.basis }),
      }),
    );
  }

  // Budget: suggested categories plus a few costs, one without an amount yet.
  // Same names as SUGGESTED_CATEGORIES in src/domain/budget/input.ts (that module uses the "@/"
  // alias, which plain Node cannot resolve, so the seed keeps its own copy).
  const SUGGESTED_CATEGORIES = [
    "Venue",
    "Catering and bar",
    "Photography and video",
    "Attire and beauty",
    "Flowers and decor",
    "Music and entertainment",
    "Stationery",
    "Transport and lodging",
    "Rings and gifts",
    "Other",
  ];
  check(
    "categories",
    await owner.rpc("add_suggested_budget_categories", {
      p_wedding: weddingId,
      p_names: SUGGESTED_CATEGORIES,
    }),
  );
  const { data: cats } = await owner
    .from("budget_categories")
    .select("id, name")
    .eq("wedding_id", weddingId);
  const cat = (name: string) => cats?.find((c) => c.name === name)?.id;
  const items = [
    ["Venue", "venue-rental", "Venue rental (fictional)", "fixed", 1_200_000, null, null],
    ["Catering and bar", "dinner", "Dinner service (fictional)", "per_guest", 9_500, null, 100],
    [
      "Photography and video",
      "photographer",
      "Photographer (fictional)",
      "fixed",
      350_000,
      null,
      null,
    ],
    [
      "Flowers and decor",
      "ceremony-flowers",
      "Ceremony flowers (fictional)",
      "fixed",
      180_000,
      null,
      null,
    ],
    ["Music and entertainment", "dj", "DJ (price not known yet)", "fixed", null, null, null],
  ] as const;
  for (const [category, key, name, mode, amount, qty, minQty] of items) {
    const categoryId = cat(category);
    if (!categoryId) continue;
    check(
      `item ${key}`,
      await owner.rpc("create_budget_item", {
        p_wedding: weddingId,
        p_category: categoryId,
        p_name: name,
        p_cost_mode: mode,
        p_idempotency_key: `seed-local-item-${key}`,
        ...(amount !== null && { p_amount_minor: amount }),
        ...(qty !== null && { p_quantity: qty }),
        ...(minQty !== null && { p_min_qty: minQty }),
      }),
    );
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
