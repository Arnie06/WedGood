import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let wedding: string;

type Row = {
  name: string;
  date: string | null;
  timezone: string;
  base_currency: string;
  target_budget_minor: number | null;
  target_guest_count: number | null;
  location: string | null;
  version: number;
  revision: number;
};

async function row(id: string): Promise<Row> {
  return withSuperuser(async (db) => {
    const r = await db.query<Row>(
      "select name, date::text, timezone, base_currency, target_budget_minor::int, target_guest_count, location, version, revision from public.weddings where id=$1",
      [id],
    );
    return r.rows[0]!;
  });
}

function update(user: TestUser, id: string, version: number, over: Record<string, unknown> = {}) {
  return user.client.rpc("update_wedding_settings", {
    p_wedding: id,
    p_expected_version: version,
    p_name: "Renamed",
    p_timezone: "America/Chicago",
    p_base_currency: "USD",
    ...over,
  });
}

async function addMember(role: "partner" | "editor" | "viewer", label: string) {
  const user = await createUser(label);
  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  await withSuperuser(async (db) => {
    await db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      wedding,
      user.id,
      role,
    ]);
  });
  void token;
  return user;
}

beforeAll(async () => {
  owner = await createUser("settings-owner");
  wedding = await createWedding(owner, { name: "Settings Wedding" });
});

describe("create_wedding optional settings", () => {
  it("stores unknown date, budget, guests and location as null (not zero)", async () => {
    const r = await row(wedding);
    expect(r).toMatchObject({
      date: null,
      target_budget_minor: null,
      target_guest_count: null,
      location: null,
    });
  });

  it("stores provided values, including an explicit zero target", async () => {
    const id = await createWedding(owner, {
      date: "2027-05-22",
      budgetMinor: 0,
      guests: 0,
      location: "  Napa  ",
    });
    expect(await row(id)).toMatchObject({
      date: "2027-05-22",
      target_budget_minor: 0,
      target_guest_count: 0,
      location: "Napa",
    });
  });

  it.each([
    ["negative budget", { budgetMinor: -1 }],
    ["negative guests", { guests: -1 }],
    ["overlong location", { location: "x".repeat(201) }],
  ])("rejects %s and creates nothing", async (_l, over) => {
    const u = await createUser("settings-bad");
    await expect(createWedding(u, over)).rejects.toThrow();
    await withSuperuser(async (db) => {
      const r = await db.query("select count(*)::int n from public.memberships where user_id=$1", [
        u.id,
      ]);
      expect(r.rows[0].n).toBe(0);
    });
  });

  it("replays one wedding for a repeated key and concurrent submits, and rejects a changed payload", async () => {
    const u = await createUser("settings-idem");
    const key = randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => createWedding(u, { name: "Once", key, budgetMinor: 100 })),
    );
    expect(new Set(ids).size).toBe(1);
    await expect(createWedding(u, { name: "Once", key, budgetMinor: 200 })).rejects.toThrow(
      /different request/,
    );
    await withSuperuser(async (db) => {
      const r = await db.query("select count(*)::int n from public.memberships where user_id=$1", [
        u.id,
      ]);
      expect(r.rows[0].n).toBe(1);
    });
  });
});

describe("update_wedding_settings", () => {
  it("updates all fields, bumps version and revision, and audits changed keys only", async () => {
    const id = await createWedding(owner, { name: "Before", date: "2027-01-01" });
    const { data, error } = await update(owner, id, 1, {
      p_date: "2027-06-05",
      p_target_budget_minor: 4_000_000,
      p_target_guest_count: 120,
      p_location: "Lisbon",
      p_timezone: "Europe/Lisbon",
      p_base_currency: "EUR",
    });
    expect(error).toBeNull();
    expect(data).toBe(2);
    expect(await row(id)).toMatchObject({
      name: "Renamed",
      date: "2027-06-05",
      timezone: "Europe/Lisbon",
      base_currency: "EUR",
      target_budget_minor: 4_000_000,
      target_guest_count: 120,
      location: "Lisbon",
      version: 2,
      revision: 2,
    });
    await withSuperuser(async (db) => {
      const a = await db.query(
        "select safe_changes, revision, actor_id from public.audit_events where wedding_id=$1 and action='wedding.settings_updated'",
        [id],
      );
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0].actor_id).toBe(owner.id);
      expect(a.rows[0].revision).toBe(2);
      expect(a.rows[0].safe_changes.changed.sort()).toEqual(
        [
          "baseCurrency",
          "date",
          "location",
          "name",
          "targetBudgetMinor",
          "targetGuestCount",
          "timezone",
        ].sort(),
      );
      expect(JSON.stringify(a.rows[0].safe_changes)).not.toContain("Lisbon");
    });
  });

  it("clears optional values back to unknown (null)", async () => {
    const id = await createWedding(owner, {
      name: "Clear",
      date: "2027-01-01",
      budgetMinor: 5,
      guests: 5,
      location: "X",
    });
    const { error } = await update(owner, id, 1, { p_name: "Clear" });
    expect(error).toBeNull();
    expect(await row(id)).toMatchObject({
      date: null,
      target_budget_minor: null,
      target_guest_count: null,
      location: null,
    });
  });

  it("is a no-op for identical settings: no version bump, no audit row", async () => {
    const id = await createWedding(owner, { name: "Same" });
    const { data, error } = await update(owner, id, 1, {
      p_name: "Same",
      p_timezone: "America/Chicago",
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect((await row(id)).version).toBe(1);
    await withSuperuser(async (db) => {
      const a = await db.query(
        "select count(*)::int n from public.audit_events where wedding_id=$1 and action='wedding.settings_updated'",
        [id],
      );
      expect(a.rows[0].n).toBe(0);
    });
  });

  it("rejects a stale version without changing anything", async () => {
    const id = await createWedding(owner, { name: "Stale" });
    expect((await update(owner, id, 1, { p_name: "First" })).error).toBeNull();
    const stale = await update(owner, id, 1, { p_name: "Second" });
    expect(stale.error?.code).toBe("55000");
    expect((await row(id)).name).toBe("First");
  });

  it("lets exactly one of two concurrent edits at the same version win", async () => {
    const id = await createWedding(owner, { name: "Race" });
    const results = await Promise.all([
      update(owner, id, 1, { p_name: "A" }),
      update(owner, id, 1, { p_name: "B" }),
    ]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
    expect((await row(id)).version).toBe(2);
  });

  it.each([
    ["blank name", { p_name: "  " }],
    ["unknown zone", { p_timezone: "Mars/Olympus" }],
    ["lowercase currency", { p_base_currency: "usd" }],
    ["negative budget", { p_target_budget_minor: -5 }],
    ["negative guests", { p_target_guest_count: -1 }],
    ["overlong location", { p_location: "x".repeat(201) }],
  ])("rejects %s (22023) and leaves the row untouched", async (_l, over) => {
    const id = await createWedding(owner, { name: "Valid" });
    const r = await update(owner, id, 1, over);
    expect(r.error?.code).toBe("22023");
    expect(await row(id)).toMatchObject({ name: "Valid", version: 1 });
  });

  it("allows partners but denies editors, viewers, outsiders and anonymous users", async () => {
    const partner = await addMember("partner", "settings-partner");
    const editor = await addMember("editor", "settings-editor");
    const viewer = await addMember("viewer", "settings-viewer");
    const outsider = await createUser("settings-outsider");
    const id = wedding;
    const before = await row(id);

    for (const [who, user] of [
      ["editor", editor],
      ["viewer", viewer],
      ["outsider", outsider],
    ] as const) {
      const r = await update(user, id, before.version, { p_name: `by ${who}` });
      expect(r.error?.code, who).toBe("42501");
    }
    expect(await row(id)).toMatchObject({ name: before.name, version: before.version });

    const ok = await update(partner, id, before.version, { p_name: "By partner" });
    expect(ok.error).toBeNull();
    expect((await row(id)).name).toBe("By partner");
  });

  it("gives non-members the same error for a real and an unknown workspace id", async () => {
    const outsider = await createUser("settings-probe");
    const real = await update(outsider, wedding, 1);
    const unknown = await update(outsider, randomUUID(), 1);
    expect(real.error?.code).toBe("42501");
    expect(unknown.error?.code).toBe("42501");
    expect(real.error?.message).toBe(unknown.error?.message);
  });

  it("denies direct table writes", async () => {
    const r = await owner.client
      .from("weddings")
      .update({ name: "Hacked" })
      .eq("id", wedding)
      .select();
    expect(r.data ?? []).toHaveLength(0);
    expect((await row(wedding)).name).not.toBe("Hacked");
  });
});
