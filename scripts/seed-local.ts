/**
 * Seeds the LOCAL Supabase stack with clearly fictional demo accounts and one
 * "Example" workspace so a fresh `pnpm db:reset` can be explored by hand.
 *
 * Safety: refuses to run unless the API host is loopback. Idempotent: re-running
 * reuses the users and the wedding (idempotency key). Demo credentials are
 * public, local-only values and must never be used anywhere else.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

  // Seating demo (SEAT-1): invitations, answers, a plus-one, private notes, seats and captains.
  // Runs once (when the reception has no invitations yet); every name is fictional.
  const layoutId = String(layout.data);
  if (!haveTables.has("Head table")) {
    check(
      "table head",
      await owner.rpc("add_seating_table", {
        p_wedding: weddingId,
        p_layout: layoutId,
        p_label: "Head table",
        p_capacity: 10,
        p_shape: "rectangle",
      }),
    );
  }
  // Floor plan (SEAT-2): a few room items and placed tables for the demo. Runs once, when the
  // layout has no room items; tables are then moved off the automatic layout.
  const { data: roomItems } = await owner
    .from("seating_elements")
    .select("id")
    .eq("layout_id", layoutId)
    .limit(1);
  if (!roomItems || roomItems.length === 0) {
    for (const item of [
      { kind: "stage", label: "Stage", x: 48, y: 2, w: 24, h: 10 },
      { kind: "dance_floor", label: "Dance floor", x: 49, y: 30, w: 22, h: 22 },
      { kind: "bar", label: "Bar", x: 100, y: 66, w: 16, h: 6 },
    ]) {
      check(
        `element ${item.label}`,
        await owner.rpc("add_seating_element", {
          p_wedding: weddingId,
          p_layout: layoutId,
          p_kind: item.kind,
          p_label: item.label,
          p_x: item.x,
          p_y: item.y,
          p_w: item.w,
          p_h: item.h,
        }),
      );
    }
    const { data: placedTables } = await owner
      .from("seating_tables")
      .select("id, label")
      .eq("layout_id", layoutId);
    const spots: Record<string, [number, number]> = {
      "Head table": [60, 20],
      "Table 1": [20, 24],
      "Table 2": [20, 52],
      "Table 3": [96, 30],
    };
    for (const t of placedTables ?? []) {
      const spot = spots[t.label];
      if (!spot) continue;
      check(
        `place ${t.label}`,
        await owner.rpc("move_seating_table", {
          p_wedding: weddingId,
          p_table: t.id,
          p_x: spot[0],
          p_y: spot[1],
        }),
      );
    }
  }
  const { data: existingInvites } = await owner
    .from("invitations")
    .select("id")
    .eq("event_id", reception)
    .limit(1);
  if (!existingInvites || existingInvites.length === 0) {
    const { data: allGuests, error: guestsError } = await owner
      .from("guests")
      .select("id, full_name, household_id, version, age_group, tags")
      .eq("wedding_id", weddingId)
      .is("archived_at", null)
      .order("full_name");
    if (guestsError) throw guestsError;
    const byHousehold = new Map<string, string[]>();
    for (const g of allGuests ?? []) {
      const key = g.household_id ?? g.id;
      byHousehold.set(key, [...(byHousehold.get(key) ?? []), g.id]);
    }
    const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
    const expires = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const plusOneHousehold = (allGuests ?? []).find((g) =>
      g.full_name.endsWith("Mockford"),
    )?.household_id;
    const groups = [...byHousehold.entries()].map(([householdId, guestIds]) => ({
      householdId,
      guestIds,
    }));
    const plain = groups.filter((g) => g.householdId !== plusOneHousehold);
    const withPlusOne = groups.filter((g) => g.householdId === plusOneHousehold);
    check(
      "invitations",
      await owner.rpc("create_invitations", {
        p_wedding: weddingId,
        p_event_id: reception,
        p_groups: plain,
        p_plus_one_quota: 0,
        p_expires_at: expires,
        p_token_hashes: plain.map(() => sha(randomBytes(32).toString("base64url"))),
        p_idempotency_key: "seed-local-reception-invitations-v1",
      }),
    );
    const plusToken = randomBytes(32).toString("base64url");
    if (withPlusOne.length > 0) {
      check(
        "plus-one invitation",
        await owner.rpc("create_invitations", {
          p_wedding: weddingId,
          p_event_id: reception,
          p_groups: withPlusOne,
          p_plus_one_quota: 1,
          p_expires_at: expires,
          p_token_hashes: [sha(plusToken)],
          p_idempotency_key: "seed-local-reception-invitations-plus-v1",
        }),
      );
    }

    // Answers: most accept (with a meal), some wait, a few decline.
    const { data: meals2 } = await owner
      .from("meal_options")
      .select("id")
      .eq("event_id", reception)
      .order("created_at");
    const { data: members } = await owner
      .from("invitation_members")
      .select("id, guest_id")
      .eq("event_id", reception)
      .eq("active", true);
    const memberOf = new Map((members ?? []).map((m) => [m.guest_id, m.id]));
    const status = new Map<string, "accepted" | "pending" | "declined">();
    for (const [i, g] of (allGuests ?? []).entries()) {
      const memberId = memberOf.get(g.id);
      if (!memberId) continue;
      const answer = i % 7 === 3 ? "declined" : i % 5 === 4 ? "pending" : "accepted";
      status.set(g.id, answer);
      if (answer === "pending") continue;
      const meal = meals2?.[i % Math.max(meals2.length, 1)]?.id;
      check(
        `answer ${i}`,
        await owner.rpc("override_rsvp_response", {
          p_wedding: weddingId,
          p_member_id: memberId,
          p_status: answer,
          p_reason: "Seeded demo answer (fictional)",
          ...(answer === "accepted" && meal && { p_meal_option_id: meal }),
        }),
      );
    }

    // A plus-one, added the way a guest would: through their own invitation link.
    if (withPlusOne.length > 0) {
      const view = await admin.rpc("rsvp_view", { p_token_hash: sha(plusToken), p_client: "seed" });
      const version = (view.data as { version?: number } | null)?.version;
      const cameron = (allGuests ?? []).find((g) => g.full_name.endsWith("Mockford"));
      const cameronMember = cameron ? memberOf.get(cameron.id) : undefined;
      if (typeof version === "number" && cameronMember && meals2?.[0]) {
        check(
          "plus-one",
          await admin.rpc("rsvp_submit", {
            p_token_hash: sha(plusToken),
            p_client: "seed",
            p_expected_version: version,
            p_responses: [
              { memberId: cameronMember, status: "accepted", mealOptionId: meals2[0].id },
            ],
            p_plus_one: { name: "Pat Plusone (fictional)", mealOptionId: meals2[1]?.id ?? null },
          }),
        );
      }
    }

    // Private notes on a few guests.
    const notes: Record<string, { dietary?: string; accessibility?: string }> = {
      "Avery Sample": { dietary: "Vegetarian" },
      "Casey Placeholder": { dietary: "Tree nut allergy (fictional)" },
      "Taylor Demo": { dietary: "Gluten-free" },
      "Robin Fiction": { dietary: "Vegan" },
      "Jamie Testwell": { accessibility: "Uses a wheelchair; needs a step-free route" },
      "Reese Samplestone": { dietary: "Shellfish allergy (fictional)" },
    };
    for (const g of allGuests ?? []) {
      const note = notes[g.full_name];
      if (!note) continue;
      check(
        `notes ${g.full_name}`,
        await owner.rpc("update_guest", {
          p_wedding: weddingId,
          p_guest_id: g.id,
          p_expected_version: g.version,
          p_guest: {
            name: g.full_name,
            age_group: g.age_group,
            tags: g.tags,
            ...note,
          },
          ...(g.household_id && { p_household: g.household_id }),
        }),
      );
    }

    // Seat accepted households together, in table order; hold seats for waiting guests too.
    const { data: layoutRow } = await owner
      .from("seating_layouts")
      .select("version")
      .eq("id", layoutId)
      .single();
    if (layoutRow) {
      check(
        "tentative on",
        await owner.rpc("set_seating_tentative", {
          p_wedding: weddingId,
          p_layout: layoutId,
          p_expected_version: layoutRow.version,
          p_allow: true,
        }),
      );
    }
    const { data: tableRows } = await owner
      .from("seating_tables")
      .select("id, label, capacity")
      .eq("layout_id", layoutId)
      .order("label");
    const open = new Map((tableRows ?? []).map((t) => [t.id, t.capacity]));
    const tableIds = (tableRows ?? []).map((t) => t.id);
    const seatedAt = new Map<string, string[]>();
    const { data: guestsNow } = await owner
      .from("invitation_members")
      .select("guest_id, invitation_id, is_plus_one")
      .eq("event_id", reception)
      .eq("active", true)
      .in("rsvp_status", ["accepted", "pending"]);
    const byInvitation = new Map<string, string[]>();
    for (const m of guestsNow ?? []) {
      byInvitation.set(m.invitation_id, [...(byInvitation.get(m.invitation_id) ?? []), m.guest_id]);
    }
    let cursor = 0;
    for (const ids of [...byInvitation.values()].slice(0, 9)) {
      while (cursor < tableIds.length && (open.get(tableIds[cursor]!) ?? 0) < ids.length)
        cursor += 1;
      const tableId = tableIds[cursor];
      if (!tableId) break;
      check(
        "seat household",
        await owner.rpc("assign_household_seats", {
          p_wedding: weddingId,
          p_layout: layoutId,
          p_table: tableId,
          p_guests: ids,
        }),
      );
      open.set(tableId, (open.get(tableId) ?? 0) - ids.length);
      seatedAt.set(tableId, [...(seatedAt.get(tableId) ?? []), ...ids]);
    }
    for (const [tableId, ids] of seatedAt) {
      if (ids[0])
        check(
          "captain",
          await owner.rpc("set_table_captain", {
            p_wedding: weddingId,
            p_table: tableId,
            p_guest: ids[0],
          }),
        );
    }
  }

  // Numbered seats (SEAT-3): give every seated guest at the demo reception a seat number. Safe to
  // repeat; a table with nobody unnumbered is left alone.
  {
    const { data: seatedTables } = await owner
      .from("seating_tables")
      .select("id")
      .eq("layout_id", layoutId);
    for (const t of seatedTables ?? []) {
      check(
        "number seats",
        await owner.rpc("number_table_seats", { p_wedding: weddingId, p_table: t.id }),
      );
    }
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
