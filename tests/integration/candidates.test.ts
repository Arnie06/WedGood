import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;

type CandidateRow = {
  id: string;
  kind: string;
  category: string;
  name: string;
  source_url: string | null;
  price_minor: string | null;
  price_basis: string | null;
  price_currency: string | null;
  is_favorite: boolean;
  archived_at: string | null;
  version: number;
  seated_capacity: number | null;
  ceremony_capacity: number | null;
};

async function rows(wedding: string): Promise<CandidateRow[]> {
  return withSuperuser(async (db) => {
    const r = await db.query<CandidateRow>(
      `select c.id, c.kind, c.category, c.name, c.source_url, c.price_minor::text, c.price_basis,
              c.price_currency, c.is_favorite, c.archived_at::text, c.version,
              v.seated_capacity, v.ceremony_capacity
         from public.candidates c left join public.venues v on v.candidate_id = c.id
        where c.wedding_id = $1 order by c.created_at, c.id`,
      [wedding],
    );
    return r.rows;
  });
}
async function only(wedding: string): Promise<CandidateRow> {
  const r = await rows(wedding);
  if (r.length !== 1) throw new Error(`expected one candidate, got ${r.length}`);
  return r[0] as CandidateRow;
}
async function auditActions(wedding: string): Promise<string[]> {
  return withSuperuser(async (db) => {
    const r = await db.query<{ action: string }>(
      "select action from public.audit_events where wedding_id=$1 and entity_type='candidate' order by occurred_at, id",
      [wedding],
    );
    return r.rows.map((x) => x.action);
  });
}
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

type Venue = Partial<{
  p_name: string;
  p_source_url: string;
  p_source_checked_on: string;
  p_location: string;
  p_pricing_display: string;
  p_price_minor: number;
  p_price_basis: string;
  p_notes: string;
  p_seated_capacity: number;
  p_ceremony_capacity: number;
  p_idempotency_key: string;
}>;
function createVenue(user: TestUser, wedding: string, extra: Venue = {}) {
  return user.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
    ...extra,
  });
}
function createVendor(
  user: TestUser,
  wedding: string,
  category = "florist",
  name = "Petal & Stem",
) {
  return user.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "vendor",
    p_category: category,
    p_name: name,
  });
}
function update(
  user: TestUser,
  wedding: string,
  id: string,
  version: number,
  extra: Record<string, unknown> = {},
) {
  return user.client.rpc("update_candidate", {
    p_wedding: wedding,
    p_candidate: id,
    p_expected_version: version,
    p_category: "venue",
    p_name: "Garden House",
    ...extra,
  });
}

beforeAll(async () => {
  owner = await createUser("cand-owner");
});

describe("create_candidate", () => {
  it("saves a venue with only a name; everything else stays unknown (null, not zero)", async () => {
    const w = await createWedding(owner);
    const { data, error } = await createVenue(owner, w);
    expect(error).toBeNull();
    const row = await only(w);
    expect(row.id).toBe(data);
    expect(row).toMatchObject({
      kind: "venue",
      category: "venue",
      source_url: null,
      price_minor: null,
      price_basis: null,
      price_currency: null,
      seated_capacity: null,
      ceremony_capacity: null,
      is_favorite: false,
      version: 1,
    });
  });

  it("records price in minor units with the wedding currency at entry time", async () => {
    const w = await createWedding(owner, { cur: "EUR" });
    await createVenue(owner, w, {
      p_price_minor: 850050,
      p_price_basis: "total",
      p_seated_capacity: 120,
      p_ceremony_capacity: 140,
      p_source_url: "https://example.com/garden",
      p_source_checked_on: "2026-11-01",
    });
    expect(await only(w)).toMatchObject({
      price_minor: "850050",
      price_basis: "total",
      price_currency: "EUR",
      seated_capacity: 120,
      ceremony_capacity: 140,
      source_url: "https://example.com/garden",
    });
  });

  it("a typed zero is stored as zero (known free), distinct from no price", async () => {
    const w = await createWedding(owner);
    await createVenue(owner, w, { p_price_minor: 0, p_price_basis: "total" });
    expect((await only(w)).price_minor).toBe("0");
  });

  it("rejects invalid input and writes nothing", async () => {
    const w = await createWedding(owner);
    const bad: Venue[] = [
      { p_name: "   " },
      { p_name: "x".repeat(161) },
      { p_price_minor: 100 }, // price without a basis
      { p_price_basis: "total" }, // basis without a price
      { p_price_minor: -1, p_price_basis: "total" },
      { p_source_url: "javascript:alert(1)" },
      { p_source_url: "https://user:pw@example.com" },
      { p_source_url: "ftp://example.com" },
      { p_source_url: "https://exa mple.com" },
      { p_seated_capacity: 0 },
      { p_notes: "x".repeat(2001) },
      { p_source_checked_on: "1800-01-01" },
    ];
    for (const extra of bad) {
      const r = await createVenue(owner, w, extra);
      expect(r.error, JSON.stringify(extra)).not.toBeNull();
    }
    expect(await rows(w)).toHaveLength(0);
  });

  it("keeps kind and category consistent, and capacity belongs to venues only", async () => {
    const w = await createWedding(owner);
    const mismatches = [
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "venue",
        p_category: "florist",
        p_name: "A",
      }),
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "vendor",
        p_category: "venue",
        p_name: "A",
      }),
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "vendor",
        p_category: "nonsense",
        p_name: "A",
      }),
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "other",
        p_category: "venue",
        p_name: "A",
      }),
      owner.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "vendor",
        p_category: "caterer",
        p_name: "A",
        p_seated_capacity: 50,
      }),
    ];
    for (const r of await Promise.all(mismatches)) expect(r.error).not.toBeNull();
    expect(await rows(w)).toHaveLength(0);
    expect((await createVendor(owner, w, "caterer", "Good Food")).error).toBeNull();
  });

  it("is idempotent: a replay returns the same candidate, concurrent replays create one", async () => {
    const w = await createWedding(owner);
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createVenue(owner, w, { p_idempotency_key: key })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await rows(w)).toHaveLength(1);
    expect(await auditActions(w)).toEqual(["candidate.created"]);
  });

  it("refuses a reused key with a different body", async () => {
    const w = await createWedding(owner);
    const key = `key-${randomUUID()}`;
    expect((await createVenue(owner, w, { p_idempotency_key: key })).error).toBeNull();
    const other = await createVenue(owner, w, { p_idempotency_key: key, p_name: "Different" });
    expect(other.error?.code).toBe("23505");
    expect(await rows(w)).toHaveLength(1);
  });

  it("allows two candidates with the same name (no unique-name assumption)", async () => {
    const w = await createWedding(owner);
    await createVenue(owner, w);
    await createVenue(owner, w);
    expect(await rows(w)).toHaveLength(2);
  });
});

describe("update_candidate", () => {
  it("replaces fields, bumps the version and audits only field names", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w, { p_seated_capacity: 100 });
    const r = await update(owner, w, id as string, 1, {
      p_name: "Garden House & Barn",
      p_location: "Napa",
      p_seated_capacity: 150,
      p_notes: "Lovely light",
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(2);
    expect(await only(w)).toMatchObject({
      name: "Garden House & Barn",
      seated_capacity: 150,
      version: 2,
    });
    const audit = await withSuperuser((db) =>
      db.query(
        "select safe_changes from public.audit_events where entity_id=$1 and action='candidate.updated'",
        [id],
      ),
    );
    expect(audit.rows[0].safe_changes).toEqual({
      changed: ["name", "location", "notes", "capacity"],
    });
  });

  it("clears optional fields back to unknown", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w, {
      p_price_minor: 5000,
      p_price_basis: "total",
      p_seated_capacity: 80,
      p_source_url: "https://example.com",
    });
    await update(owner, w, id as string, 1);
    expect(await only(w)).toMatchObject({
      price_minor: null,
      price_basis: null,
      price_currency: null,
      seated_capacity: null,
      source_url: null,
    });
  });

  it("keeps the original currency when the price is unchanged and re-records it when it changes", async () => {
    const w = await createWedding(owner, { cur: "USD" });
    const { data: id } = await createVenue(owner, w, {
      p_price_minor: 5000,
      p_price_basis: "total",
    });
    await withSuperuser((db) =>
      db.query("update public.weddings set base_currency='EUR' where id=$1", [w]),
    );
    await update(owner, w, id as string, 1, {
      p_price_minor: 5000,
      p_price_basis: "total",
      p_notes: "n",
    });
    expect((await only(w)).price_currency).toBe("USD");
    await update(owner, w, id as string, 2, {
      p_price_minor: 6000,
      p_price_basis: "total",
      p_notes: "n",
    });
    expect((await only(w)).price_currency).toBe("EUR");
  });

  it("a no-op save changes nothing and does not bump the version", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const r = await update(owner, w, id as string, 1);
    expect(r.data).toBe(1);
    expect((await only(w)).version).toBe(1);
    expect(await auditActions(w)).toEqual(["candidate.created"]);
  });

  it("detects stale versions; of two concurrent edits exactly one wins", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const results = await Promise.all([
      update(owner, w, id as string, 1, { p_name: "Edit A" }),
      update(owner, w, id as string, 1, { p_name: "Edit B" }),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
    expect((await only(w)).version).toBe(2);
  });

  it("never changes kind: a vendor cannot become a venue by naming that category", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVendor(owner, w);
    const r = await owner.client.rpc("update_candidate", {
      p_wedding: w,
      p_candidate: id,
      p_expected_version: 1,
      p_category: "venue",
      p_name: "Now a venue",
    });
    expect(r.error).not.toBeNull();
    expect((await only(w)).category).toBe("florist");
  });

  it("cannot edit an archived candidate", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    await owner.client.rpc("archive_candidate", {
      p_wedding: w,
      p_candidate: id,
      p_expected_version: 1,
    });
    const r = await update(owner, w, id as string, 2, { p_name: "Zombie" });
    expect(r.error?.code).toBe("55000");
  });
});

describe("set_candidate_favorite", () => {
  it("is idempotent set semantics: repeats and double taps are no-ops", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const call = (fav: boolean) =>
      owner.client.rpc("set_candidate_favorite", {
        p_wedding: w,
        p_candidate: id,
        p_favorite: fav,
      });
    expect((await call(true)).data).toBe(2);
    expect((await call(true)).data).toBe(2);
    const burst = await Promise.all([call(true), call(true), call(true)]);
    expect(burst.every((r) => r.error === null && r.data === 2)).toBe(true);
    expect((await only(w)).is_favorite).toBe(true);
    expect((await call(false)).data).toBe(3);
    expect((await call(false)).data).toBe(3);
    expect((await only(w)).is_favorite).toBe(false);
    expect(await auditActions(w)).toEqual([
      "candidate.created",
      "candidate.favorited",
      "candidate.unfavorited",
    ]);
  });

  it("rejects a null value", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const r = await owner.client.rpc("set_candidate_favorite", {
      p_wedding: w,
      p_candidate: id,
      p_favorite: null,
    });
    expect(r.error).not.toBeNull();
  });
});

describe("archive_candidate", () => {
  it("soft-archives, is idempotent, hides from lists and keeps the row", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w, { p_seated_capacity: 90 });
    const args = { p_wedding: w, p_candidate: id, p_expected_version: 1 };
    expect((await owner.client.rpc("archive_candidate", args)).error).toBeNull();
    expect((await owner.client.rpc("archive_candidate", args)).error).toBeNull(); // replay
    const row = await only(w);
    expect(row.archived_at).not.toBeNull();
    expect(row.seated_capacity).toBe(90);
    expect(await auditActions(w)).toEqual(["candidate.created", "candidate.archived"]);
  });

  it("rejects a stale version", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    await owner.client.rpc("set_candidate_favorite", {
      p_wedding: w,
      p_candidate: id,
      p_favorite: true,
    });
    const r = await owner.client.rpc("archive_candidate", {
      p_wedding: w,
      p_candidate: id,
      p_expected_version: 1,
    });
    expect(r.error?.code).toBe("55000");
    expect((await only(w)).archived_at).toBeNull();
  });
});

describe("authorization", () => {
  it("owner and partner can manage; editor and viewer can read but not write", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const partner = await addMember(w, "partner", "cand-partner");
    const editor = await addMember(w, "editor", "cand-editor");
    const viewer = await addMember(w, "viewer", "cand-viewer");

    expect((await createVenue(partner, w, { p_name: "By partner" })).error).toBeNull();
    for (const user of [editor, viewer]) {
      expect((await createVenue(user, w)).error?.code).toBe("42501");
      expect((await update(user, w, id as string, 1, { p_name: "x" })).error?.code).toBe("42501");
      expect(
        (
          await user.client.rpc("set_candidate_favorite", {
            p_wedding: w,
            p_candidate: id,
            p_favorite: true,
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("archive_candidate", {
            p_wedding: w,
            p_candidate: id,
            p_expected_version: 1,
          })
        ).error?.code,
      ).toBe("42501");
      // Reading is allowed through RLS, including the venue capacity row.
      expect(
        (await user.client.from("candidates").select("id").eq("wedding_id", w)).data,
      ).toHaveLength(2);
      expect(
        (await user.client.from("venues").select("candidate_id").eq("wedding_id", w)).data,
      ).toHaveLength(2);
    }
    expect((await rows(w)).find((r) => r.id === id)).toMatchObject({
      name: "Garden House",
      is_favorite: false,
    });
  });

  it("hides another wedding's candidates and denies cross-tenant writes with indistinguishable errors", async () => {
    const wa = await createWedding(owner);
    const { data: id } = await createVenue(owner, wa, { p_seated_capacity: 100 });
    const other = await createUser("cand-other");
    const wb = await createWedding(other);

    expect((await other.client.from("candidates").select("id").eq("wedding_id", wa)).data).toEqual(
      [],
    );
    expect((await other.client.from("candidates").select("id").eq("id", id)).data).toEqual([]);
    expect(
      (await other.client.from("venues").select("candidate_id").eq("candidate_id", id)).data,
    ).toEqual([]);

    const attempts = [
      other.client.rpc("update_candidate", {
        p_wedding: wb,
        p_candidate: id,
        p_expected_version: 1,
        p_category: "venue",
        p_name: "x",
      }),
      other.client.rpc("update_candidate", {
        p_wedding: wa,
        p_candidate: id,
        p_expected_version: 1,
        p_category: "venue",
        p_name: "x",
      }),
      other.client.rpc("update_candidate", {
        p_wedding: randomUUID(),
        p_candidate: id,
        p_expected_version: 1,
        p_category: "venue",
        p_name: "x",
      }),
      other.client.rpc("set_candidate_favorite", {
        p_wedding: wb,
        p_candidate: id,
        p_favorite: true,
      }),
      other.client.rpc("archive_candidate", {
        p_wedding: wb,
        p_candidate: id,
        p_expected_version: 1,
      }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.error?.code).toBe("42501");
      expect(r.error?.message).toBe("not permitted");
    }
    expect((await createVenue(other, wa)).error?.code).toBe("42501");
    expect(await only(wa)).toMatchObject({
      name: "Garden House",
      is_favorite: false,
      archived_at: null,
      version: 1,
    });
  });

  it("denies anonymous callers and direct table writes", async () => {
    const w = await createWedding(owner);
    const { data: id } = await createVenue(owner, w);
    const anon = anonClient();
    expect(
      (
        await anon.rpc("create_candidate", {
          p_wedding: w,
          p_kind: "venue",
          p_category: "venue",
          p_name: "x",
        })
      ).error,
    ).not.toBeNull();
    expect((await anon.from("candidates").select("id")).data ?? []).toEqual([]);

    const ins = await owner.client
      .from("candidates")
      .insert({ wedding_id: w, kind: "venue", category: "venue", name: "direct" });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("candidates").update({ name: "direct" }).eq("id", id);
    expect(upd.error).not.toBeNull();
    expect((await owner.client.from("candidates").delete().eq("id", id)).error).not.toBeNull();
    const insVenue = await owner.client
      .from("venues")
      .insert({ candidate_id: id, wedding_id: w, seated_capacity: 1 });
    expect(insVenue.error).not.toBeNull();
    expect((await only(w)).name).toBe("Garden House");
  });

  it("the database refuses a venue row for a vendor or for another tenant's candidate", async () => {
    const wa = await createWedding(owner);
    const wb = await createWedding(owner);
    const { data: vendor } = await createVendor(owner, wa);
    const { data: venue } = await createVenue(owner, wa);
    const insert = (candidate: unknown, wedding: string) =>
      withSuperuser((db) =>
        db.query(
          "insert into public.venues (candidate_id, wedding_id, seated_capacity) values ($1,$2,50)",
          [candidate, wedding],
        ),
      );
    await expect(insert(vendor, wa)).rejects.toThrow(/foreign key/i);
    await expect(insert(venue, wb)).rejects.toThrow(/foreign key|duplicate/i);
  });

  it("deleting the wedding cascades to candidates and venues", async () => {
    const w = await createWedding(owner);
    await createVenue(owner, w, { p_seated_capacity: 10 });
    await withSuperuser((db) => db.query("delete from public.weddings where id=$1", [w]));
    expect(await rows(w)).toHaveLength(0);
    const v = await withSuperuser((db) =>
      db.query("select 1 from public.venues where wedding_id=$1", [w]),
    );
    expect(v.rowCount).toBe(0);
  });
});
