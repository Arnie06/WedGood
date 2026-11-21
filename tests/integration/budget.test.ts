import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let stranger: TestUser;

async function addMember(wedding: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await createUser(label);
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      wedding,
      user.id,
      role,
    ]),
  );
  return user;
}

beforeAll(async () => {
  owner = await createUser("budget-owner");
  stranger = await createUser("budget-stranger");
});

function category(user: TestUser, wedding: string, name: string, extra = {}) {
  return user.client.rpc("create_budget_category", { p_wedding: wedding, p_name: name, ...extra });
}
async function newCategory(user: TestUser, wedding: string, name = "Flowers", extra = {}) {
  const { data, error } = await category(user, wedding, name, extra);
  if (error) throw new Error(error.message);
  return data as string;
}
function item(user: TestUser, wedding: string, cat: string, extra: Record<string, unknown> = {}) {
  return user.client.rpc("create_budget_item", {
    p_wedding: wedding,
    p_category: cat,
    p_name: "Bouquets",
    ...extra,
  });
}
async function newItem(user: TestUser, wedding: string, cat: string, extra = {}) {
  const { data, error } = await item(user, wedding, cat, extra);
  if (error) throw new Error(error.message);
  return data as string;
}
async function row(table: string, id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(`select * from public.${table} where id = $1`, [id]);
    return r.rows[0];
  });
}

describe("categories", () => {
  it("keeps an unset allocation null and an explicit zero as zero", async () => {
    const w = await createWedding(owner);
    const unset = await newCategory(owner, w, "Unset");
    const zero = await newCategory(owner, w, "Zero", { p_allocation_minor: 0 });
    expect((await row("budget_categories", unset)).allocation_minor).toBeNull();
    expect(Number((await row("budget_categories", zero)).allocation_minor)).toBe(0);
  });

  it("rejects blank, over-long and negative inputs and a duplicate name ignoring case", async () => {
    const w = await createWedding(owner);
    await newCategory(owner, w, "Venue");
    for (const extra of [
      { p_name: "  " },
      { p_name: "x".repeat(81) },
      { p_name: "A", p_allocation_minor: -1 },
    ]) {
      const { error } = await owner.client.rpc("create_budget_category", {
        p_wedding: w,
        ...extra,
      });
      expect(error?.code).toBe("22023");
    }
    const dup = await category(owner, w, "venue");
    expect(dup.error?.code).toBe("22023");
  });

  it("replays an idempotency key once, even under 5 concurrent submits, and rejects a changed body", async () => {
    const w = await createWedding(owner);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => category(owner, w, "Music", { p_idempotency_key: key })),
    );
    const ids = new Set(results.map((r) => r.data));
    expect(results.every((r) => !r.error)).toBe(true);
    expect(ids.size).toBe(1);
    const count = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) from public.budget_categories where wedding_id=$1", [w]))
          .rows[0].count,
      ),
    );
    expect(count).toBe(1);
    const changed = await category(owner, w, "Other name", { p_idempotency_key: key });
    expect(changed.error?.code).toBe("23505");
  });

  it("updates with a version check; a stale or concurrent same-version edit has one winner", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const upd = (name: string, v: number) =>
      owner.client.rpc("update_budget_category", {
        p_wedding: w,
        p_category: c,
        p_expected_version: v,
        p_name: name,
        p_allocation_minor: 500_000,
      });
    const [a, b] = await Promise.all([upd("Blooms", 1), upd("Petals", 1)]);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
    expect([a.error, b.error].find(Boolean)?.code).toBe("55000");
    const stale = await upd("Late", 1);
    expect(stale.error?.code).toBe("55000");
  });

  it("a no-op save does not bump the version or write audit noise", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w, "Flowers", { p_allocation_minor: 100 });
    const before = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) from public.audit_events where wedding_id=$1", [w]))
          .rows[0].count,
      ),
    );
    const { data, error } = await owner.client.rpc("update_budget_category", {
      p_wedding: w,
      p_category: c,
      p_expected_version: 1,
      p_name: "Flowers",
      p_allocation_minor: 100,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    const after = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) from public.audit_events where wedding_id=$1", [w]))
          .rows[0].count,
      ),
    );
    expect(after).toBe(before);
  });

  it("suggested categories are idempotent and never duplicate an existing name", async () => {
    const w = await createWedding(owner);
    await newCategory(owner, w, "venue");
    const names = ["Venue", "Catering", "Music"];
    const first = await owner.client.rpc("add_suggested_budget_categories", {
      p_wedding: w,
      p_names: names,
    });
    expect(first.data).toBe(2);
    const again = await owner.client.rpc("add_suggested_budget_categories", {
      p_wedding: w,
      p_names: names,
    });
    expect(again.data).toBe(0);
    const bad = await owner.client.rpc("add_suggested_budget_categories", {
      p_wedding: w,
      p_names: [1],
    });
    expect(bad.error?.code).toBe("22023");
  });

  it("cannot archive a category that still has costs, and can once they are removed", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const i = await newItem(owner, w, c);
    const blocked = await owner.client.rpc("archive_budget_category", {
      p_wedding: w,
      p_category: c,
      p_expected_version: 1,
    });
    expect(blocked.error?.code).toBe("22023");
    const gone = await owner.client.rpc("archive_budget_item", {
      p_wedding: w,
      p_item: i,
      p_expected_version: 1,
    });
    expect(gone.error).toBeNull();
    const ok = await owner.client.rpc("archive_budget_category", {
      p_wedding: w,
      p_category: c,
      p_expected_version: 1,
    });
    expect(ok.error).toBeNull();
    // The name is free again once archived.
    expect((await category(owner, w, "Flowers")).error).toBeNull();
  });
});

describe("items", () => {
  it("stores a blank amount as unknown (null), never zero, and a zero amount as zero", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const unknown = await newItem(owner, w, c);
    const zero = await newItem(owner, w, c, { p_amount_minor: 0 });
    expect((await row("budget_items", unknown)).amount_minor).toBeNull();
    expect(Number((await row("budget_items", zero)).amount_minor)).toBe(0);
  });

  it("enforces the cost-mode field matrix and amount limits", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const bad: Record<string, unknown>[] = [
      { p_cost_mode: "fixed", p_quantity: 2 },
      { p_cost_mode: "quantity", p_min_qty: 2 },
      { p_cost_mode: "per_guest", p_quantity: 2 },
      { p_cost_mode: "percent" },
      { p_cost_mode: "quantity", p_quantity: 0 },
      { p_amount_minor: 100_000_001 },
      { p_amount_minor: -1 },
      { p_name: " " },
      { p_notes: "x".repeat(1001) },
    ];
    for (const extra of bad) {
      const { error } = await item(owner, w, c, extra);
      expect(error?.code, JSON.stringify(extra)).toBe("22023");
    }
    expect(
      (await item(owner, w, c, { p_cost_mode: "per_guest", p_amount_minor: 9500, p_min_qty: 120 }))
        .error,
    ).toBeNull();
    expect(
      (await item(owner, w, c, { p_cost_mode: "quantity", p_amount_minor: 5000, p_quantity: 4 }))
        .error,
    ).toBeNull();
  });

  it("refuses a category from another wedding, and an archived one", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(stranger);
    const foreign = await newCategory(stranger, other);
    const { error } = await item(owner, w, foreign);
    expect(error?.code).toBe("22023");
    const c = await newCategory(owner, w);
    await owner.client.rpc("archive_budget_category", {
      p_wedding: w,
      p_category: c,
      p_expected_version: 1,
    });
    expect((await item(owner, w, c)).error?.code).toBe("22023");
  });

  it("moves between categories in the same wedding but not to another wedding's", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(stranger);
    const a = await newCategory(owner, w, "A");
    const b = await newCategory(owner, w, "B");
    const foreign = await newCategory(stranger, other);
    const i = await newItem(owner, w, a);
    const move = (cat: string, v: number) =>
      owner.client.rpc("update_budget_item", {
        p_wedding: w,
        p_item: i,
        p_expected_version: v,
        p_category: cat,
        p_name: "Bouquets",
        p_cost_mode: "fixed",
      });
    expect((await move(foreign, 1)).error?.code).toBe("22023");
    expect((await move(b, 1)).error).toBeNull();
    expect((await row("budget_items", i)).category_id).toBe(b);
  });

  it("replays create once under 5 concurrent submits and rejects a changed body", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        item(owner, w, c, { p_amount_minor: 1000, p_idempotency_key: key }),
      ),
    );
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(results.every((r) => !r.error)).toBe(true);
    const changed = await item(owner, w, c, { p_amount_minor: 2000, p_idempotency_key: key });
    expect(changed.error?.code).toBe("23505");
  });

  it("stale and concurrent same-version edits have exactly one winner; archived items refuse edits", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const i = await newItem(owner, w, c, { p_amount_minor: 100 });
    const upd = (amount: number, v: number) =>
      owner.client.rpc("update_budget_item", {
        p_wedding: w,
        p_item: i,
        p_expected_version: v,
        p_category: c,
        p_name: "Bouquets",
        p_cost_mode: "fixed",
        p_amount_minor: amount,
      });
    const [a, b] = await Promise.all([upd(200, 1), upd(300, 1)]);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
    const v = (await row("budget_items", i)).version as number;
    await owner.client.rpc("archive_budget_item", {
      p_wedding: w,
      p_item: i,
      p_expected_version: v,
    });
    expect((await upd(400, v + 1)).error?.code).toBe("55000");
  });
});

describe("reserve", () => {
  const set = (w: string, v: number, bp?: number) =>
    owner.client.rpc("set_budget_reserve", {
      p_wedding: w,
      p_expected_version: v,
      ...(bp !== undefined && { p_reserve_bp: bp }),
    });
  const stored = async (w: string) =>
    withSuperuser(
      async (db) =>
        (await db.query("select * from public.budget_settings where wedding_id=$1", [w])).rows[0],
    );

  it("stores a reserve, an explicit zero, and clears back to none", async () => {
    const w = await createWedding(owner);
    expect((await set(w, 0, 1000)).data).toBe(1);
    expect((await stored(w)).reserve_bp).toBe(1000);
    expect((await set(w, 1, 0)).data).toBe(2);
    expect((await stored(w)).reserve_bp).toBe(0);
    expect((await set(w, 2)).data).toBe(3);
    expect((await stored(w)).reserve_bp).toBeNull();
  });

  it("rejects out-of-range values and stale versions; a no-op keeps the version", async () => {
    const w = await createWedding(owner);
    expect((await set(w, 0, 10_001)).error?.code).toBe("22023");
    expect((await set(w, 0, -1)).error?.code).toBe("22023");
    expect((await set(w, 3, 500)).error?.code).toBe("55000");
    expect((await set(w, 0, 500)).data).toBe(1);
    expect((await set(w, 0, 600)).error?.code).toBe("55000");
    expect((await set(w, 1, 500)).data).toBe(1);
  });

  it("two first saves race: one wins, the other is told to reload", async () => {
    const w = await createWedding(owner);
    const [a, b] = await Promise.all([set(w, 0, 500), set(w, 0, 900)]);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
    expect([a.error, b.error].find(Boolean)?.code).toBe("55000");
  });
});

describe("currency guard", () => {
  const change = (w: string, cur: string, version: number) =>
    owner.client.rpc("update_wedding_settings", {
      p_wedding: w,
      p_expected_version: version,
      p_name: "Test Wedding",
      p_timezone: "America/Chicago",
      p_base_currency: cur,
    });

  it("allows a currency change with no budget amounts, refuses once amounts exist", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w); // no allocation, no amounts
    await newItem(owner, w, c); // unknown amount
    const first = await change(w, "EUR", 1);
    expect(first.error).toBeNull();
    await newItem(owner, w, c, { p_amount_minor: 5000 });
    const refused = await change(w, "GBP", first.data as number);
    expect(refused.error?.code).toBe("55006");
    expect((await row("weddings", w)).base_currency).toBe("EUR");
  });

  it("an allocation alone also blocks it", async () => {
    const w = await createWedding(owner);
    await newCategory(owner, w, "Venue", { p_allocation_minor: 100 });
    expect((await change(w, "EUR", 1)).error?.code).toBe("55006");
  });
});

describe("authorization", () => {
  it("allows owner and partner; denies editor, viewer and outsider on every write", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner", "budget-partner");
    const editor = await addMember(w, "editor", "budget-editor");
    const viewer = await addMember(w, "viewer", "budget-viewer");
    expect((await category(partner, w, "By partner")).error).toBeNull();
    const c = await newCategory(owner, w, "Existing");
    const i = await newItem(owner, w, c);
    for (const who of [editor, viewer, stranger]) {
      const calls = [
        category(who, w, "Nope"),
        item(who, w, c),
        who.client.rpc("update_budget_category", {
          p_wedding: w,
          p_category: c,
          p_expected_version: 1,
          p_name: "x",
        }),
        who.client.rpc("archive_budget_item", { p_wedding: w, p_item: i, p_expected_version: 1 }),
        who.client.rpc("set_budget_reserve", {
          p_wedding: w,
          p_expected_version: 0,
          p_reserve_bp: 100,
        }),
        who.client.rpc("add_suggested_budget_categories", { p_wedding: w, p_names: ["Venue"] }),
      ];
      for (const r of await Promise.all(calls)) expect(r.error?.code).toBe("42501");
    }
  });

  it("gives an unknown wedding id the same error as a real one the caller cannot use", async () => {
    const w = await createWedding(owner);
    const real = await category(stranger, w, "x");
    const unknown = await category(stranger, randomUUID(), "x");
    expect(real.error?.code).toBe("42501");
    expect(unknown.error?.code).toBe(real.error?.code);
    expect(unknown.error?.message).toBe(real.error?.message);
  });

  it("denies anonymous callers", async () => {
    const w = await createWedding(owner);
    const r = await anonClient().rpc("create_budget_category", { p_wedding: w, p_name: "x" });
    expect(r.error).not.toBeNull();
    expect((await anonClient().from("budget_categories").select("id")).data ?? []).toHaveLength(0);
  });

  it("members read their budget; viewers can read but cannot write; outsiders see nothing", async () => {
    const w = await createWedding(owner);
    const viewer = await addMember(w, "viewer", "budget-reader");
    const c = await newCategory(owner, w);
    await newItem(owner, w, c);
    const seen = await viewer.client.from("budget_items").select("id").eq("wedding_id", w);
    expect(seen.data).toHaveLength(1);
    const hidden = await stranger.client.from("budget_items").select("id").eq("wedding_id", w);
    expect(hidden.data).toHaveLength(0);
    const hiddenCats = await stranger.client
      .from("budget_categories")
      .select("id")
      .eq("wedding_id", w);
    expect(hiddenCats.data).toHaveLength(0);
    const hiddenSettings = await stranger.client
      .from("budget_settings")
      .select("wedding_id")
      .eq("wedding_id", w);
    expect(hiddenSettings.data).toHaveLength(0);
  });

  it("denies direct table writes even for the owner", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w);
    const ins = await owner.client
      .from("budget_categories")
      .insert({ wedding_id: w, name: "Direct" });
    expect(ins.error).not.toBeNull();
    const insItem = await owner.client
      .from("budget_items")
      .insert({ wedding_id: w, category_id: c, name: "Direct" });
    expect(insItem.error).not.toBeNull();
    const upd = await owner.client
      .from("budget_categories")
      .update({ name: "Hacked" })
      .eq("id", c)
      .select();
    expect(upd.data ?? []).toHaveLength(0);
    expect((await row("budget_categories", c)).name).toBe("Flowers");
    const set = await owner.client.from("budget_settings").insert({ wedding_id: w, reserve_bp: 1 });
    expect(set.error).not.toBeNull();
  });

  it("the composite key keeps an item from pointing at another wedding's category", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(stranger);
    const foreign = await newCategory(stranger, other);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.budget_items (wedding_id, category_id, name) values ($1,$2,'x')",
          [w, foreign],
        ),
      ),
    ).rejects.toThrow();
  });

  it("audit rows record field names and flags, never amounts or names", async () => {
    const w = await createWedding(owner);
    const c = await newCategory(owner, w, "Secret vendor budget", { p_allocation_minor: 123_456 });
    await newItem(owner, w, c, { p_name: "Private thing", p_amount_minor: 987_654 });
    const audit = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select action, safe_changes from public.audit_events where wedding_id=$1 and action like 'budget.%'",
            [w],
          )
        ).rows,
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "budget.category_created",
      "budget.item_created",
    ]);
    const text = JSON.stringify(audit);
    for (const leak of ["Secret", "Private", "123456", "987654"]) expect(text).not.toContain(leak);
  });
});
