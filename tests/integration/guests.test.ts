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
  owner = await createUser("guests-owner");
  stranger = await createUser("guests-stranger");
});

type G = Record<string, unknown>;
const guest = (name = "Ada Example", extra: G = {}): G => ({ name, ...extra });

function create(user: TestUser, w: string, g: G, household?: string, key?: string) {
  return user.client.rpc("create_guest", {
    p_wedding: w,
    p_guest: g,
    ...(household && { p_household: household }),
    ...(key && { p_idempotency_key: key }),
  });
}
async function newGuest(user: TestUser, w: string, g: G = guest(), household?: string) {
  const { data, error } = await create(user, w, g, household);
  if (error) throw new Error(error.message);
  return data as string;
}
function importRows(user: TestUser, w: string, rows: G[], key = `key-${randomUUID()}`) {
  return user.client.rpc("commit_guest_import", {
    p_wedding: w,
    p_rows: rows,
    p_idempotency_key: key,
  });
}
async function count(table: string, w: string, where = "") {
  return withSuperuser(async (db) => {
    const r = await db.query<{ n: string }>(
      `select count(*) as n from public.${table} where wedding_id=$1 ${where}`,
      [w],
    );
    return Number(r.rows[0]!.n);
  });
}
async function guestRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select g.*, d.dietary, d.accessibility, d.notes from public.guests g left join public.guest_private_details d on d.guest_id=g.id where g.id=$1",
      [id],
    );
    return r.rows[0] as Record<string, unknown>;
  });
}

describe("create and update guest", () => {
  it("stores a normalized guest with private details in a separate table", async () => {
    const w = await createWedding(owner);
    const id = await newGuest(
      owner,
      w,
      guest("  Ada Example ", {
        email: "ADA@Example.Test",
        phone: "+1 555 010 2000",
        age_group: "adult",
        tags: ["Family", "family", "College"],
        dietary: "Vegetarian",
        accessibility: "Step-free access",
        notes: "Seat away from the band",
        household: "The Examples",
      }),
    );
    const r = await guestRow(id);
    expect(r).toMatchObject({
      full_name: "Ada Example",
      email: "ada@example.test",
      age_group: "adult",
      tags: ["Family", "College"],
      dietary: "Vegetarian",
      version: 1,
    });
    expect(r.household_id).not.toBeNull();
    expect(await count("households", w)).toBe(1);
  });

  it("allows two guests with the same name and email (identity is the id)", async () => {
    const w = await createWedding(owner);
    await newGuest(owner, w, guest("Sam Lee", { email: "sam@example.test" }));
    await newGuest(owner, w, guest("Sam Lee", { email: "sam@example.test" }));
    expect(await count("guests", w)).toBe(2);
  });

  it("rejects invalid payloads and writes nothing", async () => {
    const w = await createWedding(owner);
    const bad: G[] = [
      {},
      { name: "" },
      { name: "x".repeat(121) },
      { name: "A", email: "nope" },
      { name: "A", phone: "12" },
      { name: "A", age_group: "teen" },
      { name: "A", tags: "x" },
      { name: "A", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { name: "A", tags: ["x".repeat(31)] },
      { name: "A", dietary: "x".repeat(501) },
      { name: "A", household: "x".repeat(121) },
      { name: 5 },
    ];
    for (const g of bad) expect((await create(owner, w, g)).error?.code).toBe("22023");
    expect(await count("guests", w)).toBe(0);
    expect(await count("households", w)).toBe(0);
  });

  it("is idempotent under concurrent submits and rejects key reuse with different data", async () => {
    const w = await createWedding(owner);
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(owner, w, guest("Once Only"), undefined, key)),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("guests", w)).toBe(1);
    const other = await create(owner, w, guest("Different"), undefined, key);
    expect(other.error?.code).toBe("23505");
  });

  it("rejects a household from another wedding", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(stranger);
    const foreign = await newGuest(stranger, other, guest("Foreign", { household: "Theirs" }));
    const foreignHousehold = (await guestRow(foreign)).household_id as string;
    const r = await create(owner, w, guest("Mine"), foreignHousehold);
    expect(r.error?.code).toBe("22023");
    expect(await count("guests", w)).toBe(0);
  });

  it("updates with a version check, one concurrent winner, and records field names only", async () => {
    const w = await createWedding(owner);
    const id = await newGuest(owner, w, guest("Before Name", { dietary: "Nuts" }));
    const call = (name: string, v: number) =>
      owner.client.rpc("update_guest", {
        p_wedding: w,
        p_guest_id: id,
        p_expected_version: v,
        p_guest: guest(name, { dietary: "Nuts" }),
      });
    const results = await Promise.all([call("Winner One", 1), call("Winner Two", 1)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
    expect((await guestRow(id)).version).toBe(2);
    const audit = await withSuperuser((db) =>
      db.query("select action, safe_changes from public.audit_events where entity_id=$1", [id]),
    );
    expect(JSON.stringify(audit.rows)).toContain("name");
    expect(JSON.stringify(audit.rows)).not.toMatch(/Winner|Nuts|Before Name/);
  });

  it("treats an unchanged save as a no-op and clears private details when emptied", async () => {
    const w = await createWedding(owner);
    const id = await newGuest(owner, w, guest("Same", { dietary: "Vegan" }));
    const same = await owner.client.rpc("update_guest", {
      p_wedding: w,
      p_guest_id: id,
      p_expected_version: 1,
      p_guest: guest("Same", { dietary: "Vegan" }),
    });
    expect(same.error).toBeNull();
    expect((await guestRow(id)).version).toBe(1);
    const cleared = await owner.client.rpc("update_guest", {
      p_wedding: w,
      p_guest_id: id,
      p_expected_version: 1,
      p_guest: guest("Same"),
    });
    expect(cleared.error).toBeNull();
    const row = await guestRow(id);
    expect(row.dietary).toBeNull();
    expect(row.version).toBe(2);
  });

  it("archives and restores, and refuses edits to an archived guest", async () => {
    const w = await createWedding(owner);
    const id = await newGuest(owner, w);
    const archive = (v: number, a: boolean) =>
      owner.client.rpc("set_guest_archived", {
        p_wedding: w,
        p_guest_id: id,
        p_expected_version: v,
        p_archived: a,
      });
    expect((await archive(1, true)).error).toBeNull();
    expect((await guestRow(id)).archived_at).not.toBeNull();
    const edit = await owner.client.rpc("update_guest", {
      p_wedding: w,
      p_guest_id: id,
      p_expected_version: 2,
      p_guest: guest("Edited"),
    });
    expect(edit.error?.code).toBe("55000");
    expect((await archive(1, false)).error?.code).toBe("55000");
    expect((await archive(2, false)).error).toBeNull();
    expect((await guestRow(id)).archived_at).toBeNull();
  });

  it("enforces the active guest cap", async () => {
    const w = await createWedding(owner);
    await withSuperuser((db) =>
      db.query(
        "insert into public.guests (wedding_id, full_name) select $1, 'G' || n from generate_series(1, 2000) n",
        [w],
      ),
    );
    expect((await create(owner, w, guest("One too many"))).error?.code).toBe("54000");
    expect((await importRows(owner, w, [guest("Also too many")])).error?.code).toBe("54000");
  });
});

describe("households", () => {
  it("reuses an active household by name ignoring case, and renames with version and name checks", async () => {
    const w = await createWedding(owner);
    const a = await newGuest(owner, w, guest("A", { household: "The Smiths" }));
    const b = await newGuest(owner, w, guest("B", { household: "the smiths" }));
    const hid = (await guestRow(a)).household_id as string;
    expect((await guestRow(b)).household_id).toBe(hid);
    expect(await count("households", w)).toBe(1);
    await newGuest(owner, w, guest("C", { household: "Joneses" }));
    const rename = (name: string, v: number) =>
      owner.client.rpc("update_household", {
        p_wedding: w,
        p_household_id: hid,
        p_expected_version: v,
        p_name: name,
        p_address: "1 Example Road",
        p_notes: "",
      });
    expect((await rename("joneses", 1)).error?.code).toBe("23505");
    expect((await rename("The Smith Family", 1)).error).toBeNull();
    expect((await rename("Again", 1)).error?.code).toBe("55000");
  });

  it("concurrent creates of the same new household produce one household", async () => {
    const w = await createWedding(owner);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        create(owner, w, guest(`P${i}`, { household: "Shared" })),
      ),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(await count("households", w)).toBe(1);
  });
});

describe("import commit", () => {
  const rows = [
    guest("Ada One", { household: "Ones", email: "one@example.test", tags: ["Family"] }),
    guest("Ben One", { household: "ones", dietary: "Gluten free" }),
    guest("Cy Two", { household: "Twos" }),
    guest("Solo"),
  ];

  it("inserts every row atomically with households grouped", async () => {
    const w = await createWedding(owner);
    const { data, error } = await importRows(owner, w, rows);
    expect(error).toBeNull();
    expect(await count("guests", w)).toBe(4);
    expect(await count("households", w)).toBe(2);
    const imp = await withSuperuser((db) =>
      db.query("select guest_count, new_household_count from public.guest_imports where id=$1", [
        data,
      ]),
    );
    expect(imp.rows[0]).toEqual({ guest_count: 4, new_household_count: 2 });
    expect(await count("guest_private_details", w)).toBe(1);
  });

  it("a replayed key adds nothing, under 5 concurrent submits too", async () => {
    const w = await createWedding(owner);
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => importRows(owner, w, rows, key)),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("guests", w)).toBe(4);
    expect(await count("guest_imports", w)).toBe(1);
    const changed = await importRows(owner, w, [guest("Different")], key);
    expect(changed.error?.code).toBe("23505");
    expect(await count("guests", w)).toBe(4);
  });

  it("one invalid row rejects the whole batch and leaves nothing behind", async () => {
    const w = await createWedding(owner);
    const r = await importRows(owner, w, [guest("Fine", { household: "Ghost" }), { name: "" }]);
    expect(r.error?.code).toBe("22023");
    expect(await count("guests", w)).toBe(0);
    expect(await count("households", w)).toBe(0);
    expect(await count("guest_imports", w)).toBe(0);
  });

  it("validates size, shape and key", async () => {
    const w = await createWedding(owner);
    expect((await importRows(owner, w, [])).error?.code).toBe("22023");
    const big = Array.from({ length: 501 }, (_, i) => guest(`G${i}`));
    expect((await importRows(owner, w, big)).error?.code).toBe("22023");
    expect((await importRows(owner, w, rows, "short")).error?.code).toBe("22023");
    const notArray = await owner.client.rpc("commit_guest_import", {
      p_wedding: w,
      p_rows: { name: "x" },
      p_idempotency_key: `key-${randomUUID()}`,
    });
    expect(notArray.error?.code).toBe("22023");
    expect(await count("guests", w)).toBe(0);
  });

  it("stores formula-looking text verbatim and audits counts only", async () => {
    const w = await createWedding(owner);
    const { data } = await importRows(owner, w, [guest("=HYPERLINK(1)", { dietary: "=1+1" })]);
    const r = await withSuperuser((db) =>
      db.query("select full_name from public.guests where wedding_id=$1", [w]),
    );
    expect(r.rows[0].full_name).toBe("=HYPERLINK(1)");
    const audit = await withSuperuser((db) =>
      db.query("select safe_changes from public.audit_events where entity_id=$1", [data]),
    );
    expect(audit.rows[0].safe_changes).toEqual({ guests: 1, new_households: 0 });
  });
});

describe("authorization and privacy", () => {
  it("allows owner and partner; denies editor, viewer, outsider and anonymous on every write", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner", "guests-partner");
    const editor = await addMember(w, "editor", "guests-editor");
    const viewer = await addMember(w, "viewer", "guests-viewer");
    expect((await create(partner, w, guest("By Partner"))).error).toBeNull();
    const g = await newGuest(owner, w, guest("Existing", { household: "Home" }));
    const hid = (await guestRow(g)).household_id as string;
    for (const who of [editor, viewer, stranger]) {
      const calls = [
        create(who, w, guest("Nope")),
        importRows(who, w, [guest("Nope")]),
        who.client.rpc("update_guest", {
          p_wedding: w,
          p_guest_id: g,
          p_expected_version: 1,
          p_guest: guest("Nope"),
        }),
        who.client.rpc("set_guest_archived", {
          p_wedding: w,
          p_guest_id: g,
          p_expected_version: 1,
          p_archived: true,
        }),
        who.client.rpc("update_household", {
          p_wedding: w,
          p_household_id: hid,
          p_expected_version: 1,
          p_name: "Nope",
          p_address: "",
          p_notes: "",
        }),
      ];
      for (const r of await Promise.all(calls)) expect(r.error?.code).toBe("42501");
    }
    const anon = await anonClient().rpc("create_guest", { p_wedding: w, p_guest: guest("Anon") });
    expect(anon.error).not.toBeNull();
    expect(await count("guests", w)).toBe(2);
  });

  it("gives an unknown wedding the same error as a real one the caller cannot use", async () => {
    const w = await createWedding(owner);
    const real = await create(stranger, w, guest());
    const unknown = await create(stranger, randomUUID(), guest());
    expect(unknown.error?.code).toBe(real.error?.code);
    expect(unknown.error?.message).toBe(real.error?.message);
  });

  it("hides guests, households and private details from non-managers and other tenants", async () => {
    const w = await createWedding(owner);
    const editor = await addMember(w, "editor", "guests-reader-editor");
    const viewer = await addMember(w, "viewer", "guests-reader-viewer");
    const id = await newGuest(
      owner,
      w,
      guest("Private Pat", { dietary: "Allergy", household: "H" }),
    );
    const readable = await owner.client.from("guests").select("id, full_name").eq("id", id);
    expect(readable.data).toHaveLength(1);
    expect(
      (await owner.client.from("guest_private_details").select("dietary").eq("wedding_id", w)).data
        ?.length,
    ).toBe(1);
    for (const who of [editor, viewer, stranger]) {
      for (const table of ["guests", "households", "guest_private_details", "guest_imports"]) {
        const r = await who.client.from(table).select("*").eq("wedding_id", w);
        expect(r.data ?? []).toHaveLength(0);
      }
    }
    for (const table of ["guests", "households", "guest_private_details"]) {
      expect((await anonClient().from(table).select("*")).data ?? []).toHaveLength(0);
    }
  });

  it("denies direct table writes, including to forge private details or tenant ids", async () => {
    const w = await createWedding(owner);
    const id = await newGuest(owner, w);
    const ins = await owner.client.from("guests").insert({ wedding_id: w, full_name: "Direct" });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("guests").update({ full_name: "Direct" }).eq("id", id);
    expect(upd.error ?? (await guestRow(id)).full_name === "Direct").toBeTruthy();
    expect((await guestRow(id)).full_name).toBe("Ada Example");
    const priv = await owner.client
      .from("guest_private_details")
      .insert({ guest_id: id, wedding_id: w, dietary: "x" });
    expect(priv.error).not.toBeNull();
    const del = await owner.client.from("guests").delete().eq("id", id);
    expect(del.error ?? (await count("guests", w)) === 1).toBeTruthy();
    expect(await count("guests", w)).toBe(1);
  });

  it("cannot attach a guest to another tenant's household even with direct SQL", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(stranger);
    const foreign = await newGuest(stranger, other, guest("F", { household: "Theirs" }));
    const hid = (await guestRow(foreign)).household_id as string;
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.guests (wedding_id, household_id, full_name) values ($1,$2,'X')",
          [w, hid],
        ),
      ),
    ).rejects.toThrow();
  });

  it("revokes access immediately when a partner is removed", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner", "guests-removed");
    expect((await create(partner, w, guest("Before"))).error).toBeNull();
    await withSuperuser((db) =>
      db.query("delete from public.memberships where wedding_id=$1 and user_id=$2", [
        w,
        partner.id,
      ]),
    );
    expect((await create(partner, w, guest("After"))).error?.code).toBe("42501");
    expect(
      (await partner.client.from("guests").select("id").eq("wedding_id", w)).data,
    ).toHaveLength(0);
  });
});
