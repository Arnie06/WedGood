import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

let alice: TestUser;
let bob: TestUser;
let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  alice = await createUser("alice");
  bob = await createUser("bob");
  weddingA = await createWedding(alice, { name: "Wedding A" });
  weddingB = await createWedding(bob, { name: "Wedding B" });
});

describe("create_wedding", () => {
  it("creates the wedding, owner membership and audit event together", async () => {
    await withSuperuser(async (db) => {
      const w = await db.query(
        "select name, revision, version, created_by from public.weddings where id=$1",
        [weddingA],
      );
      expect(w.rows[0]).toMatchObject({
        name: "Wedding A",
        revision: 1,
        version: 1,
        created_by: alice.id,
      });
      const m = await db.query("select role, status from public.memberships where wedding_id=$1", [
        weddingA,
      ]);
      expect(m.rows).toEqual([{ role: "owner", status: "active" }]);
      const a = await db.query(
        "select action, actor_id, revision from public.audit_events where wedding_id=$1",
        [weddingA],
      );
      expect(a.rows).toEqual([{ action: "wedding.created", actor_id: alice.id, revision: 1 }]);
    });
  });

  it.each([
    ["blank name", { name: "   " }],
    ["unknown time zone", { tz: "Mars/Olympus" }],
    ["lowercase currency", { cur: "usd" }],
    ["long currency", { cur: "USDX" }],
  ])("rejects %s and leaves no rows behind", async (_label, overrides) => {
    const carol = await createUser("carol");
    await expect(createWedding(carol, overrides)).rejects.toThrow();
    await withSuperuser(async (db) => {
      const r = await db.query(
        "select count(*)::int as n from public.memberships where user_id=$1",
        [carol.id],
      );
      expect(r.rows[0].n).toBe(0);
    });
  });

  it("requires authentication", async () => {
    const { error } = await anonClient().rpc("create_wedding", {
      p_name: "Anon",
      p_timezone: "UTC",
      p_base_currency: "USD",
    });
    expect(error).not.toBeNull();
  });

  it("is idempotent for a repeated key and rejects a changed payload", async () => {
    const dana = await createUser("dana");
    const key = `key-${randomUUID()}`;
    const first = await createWedding(dana, { key });
    const second = await createWedding(dana, { key });
    expect(second).toBe(first);
    await expect(createWedding(dana, { key, name: "Different" })).rejects.toThrow(/idempotency/);
    await withSuperuser(async (db) => {
      const r = await db.query(
        "select count(*)::int as n from public.memberships where user_id=$1",
        [dana.id],
      );
      expect(r.rows[0].n).toBe(1);
    });
  });
});

describe("tenant isolation (RLS)", () => {
  it("members see only their own wedding, even when asking for another by id", async () => {
    const own = await alice.client.from("weddings").select("id");
    expect(own.data?.map((r) => r.id)).toEqual([weddingA]);

    const other = await alice.client.from("weddings").select("id").eq("id", weddingB);
    expect(other.data).toEqual([]);

    const memberships = await alice.client
      .from("memberships")
      .select("wedding_id")
      .eq("wedding_id", weddingB);
    expect(memberships.data).toEqual([]);

    const audit = await alice.client.from("audit_events").select("id").eq("wedding_id", weddingB);
    expect(audit.data).toEqual([]);
  });

  it("anonymous clients read nothing", async () => {
    const anon = anonClient();
    for (const table of [
      "weddings",
      "memberships",
      "audit_events",
      "profiles",
      "idempotency_keys",
    ]) {
      const { data, error } = await anon.from(table).select("*");
      expect(error !== null || (data ?? []).length === 0).toBe(true);
    }
  });

  it("direct writes to tenant tables are denied", async () => {
    // Cannot grant yourself membership in someone else's wedding.
    const join = await alice.client
      .from("memberships")
      .insert({ wedding_id: weddingB, user_id: alice.id, role: "owner" });
    expect(join.error).not.toBeNull();

    // Cannot insert, update or delete weddings directly.
    expect(
      (
        await alice.client
          .from("weddings")
          .insert({ name: "x", timezone: "UTC", base_currency: "USD", created_by: alice.id })
      ).error,
    ).not.toBeNull();
    await alice.client.from("weddings").update({ name: "Hacked" }).eq("id", weddingA);
    await alice.client.from("weddings").delete().eq("id", weddingA);
    // Cannot promote or alter own membership.
    await alice.client.from("memberships").update({ role: "owner" }).eq("wedding_id", weddingA);
    await alice.client.from("memberships").delete().eq("wedding_id", weddingA);

    await withSuperuser(async (db) => {
      const w = await db.query("select name, version from public.weddings where id=$1", [weddingA]);
      expect(w.rows[0]).toEqual({ name: "Wedding A", version: 1 });
      const m = await db.query(
        "select count(*)::int as n from public.memberships where wedding_id=$1",
        [weddingA],
      );
      expect(m.rows[0].n).toBe(1);
      const cross = await db.query(
        "select count(*)::int as n from public.memberships where wedding_id=$1 and user_id=$2",
        [weddingB, alice.id],
      );
      expect(cross.rows[0].n).toBe(0);
    });
  });

  it("cannot forge audit events or read idempotency keys", async () => {
    const forged = await alice.client.from("audit_events").insert({
      wedding_id: weddingA,
      entity_type: "wedding",
      entity_id: weddingA,
      action: "forged",
      revision: 1,
    });
    expect(forged.error).not.toBeNull();
    const keys = await alice.client.from("idempotency_keys").select("*");
    expect(keys.error !== null || (keys.data ?? []).length === 0).toBe(true);
  });

  it("profiles are visible and editable only by their owner", async () => {
    const own = await alice.client.from("profiles").select("user_id");
    expect(own.data?.map((r) => r.user_id)).toEqual([alice.id]);
    await alice.client.from("profiles").update({ display_name: "Hijacked" }).eq("user_id", bob.id);
    const ok = await alice.client
      .from("profiles")
      .update({ display_name: "Alice" })
      .eq("user_id", alice.id)
      .select("display_name");
    expect(ok.data).toEqual([{ display_name: "Alice" }]);
    await withSuperuser(async (db) => {
      const r = await db.query("select display_name from public.profiles where user_id=$1", [
        bob.id,
      ]);
      expect(r.rows[0].display_name).toBeNull();
    });
  });
});

describe("membership changes take effect immediately", () => {
  it("viewer reads the wedding but not the audit log; removal revokes access", async () => {
    const eve = await createUser("eve");
    await withSuperuser((db) =>
      db.query(
        "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')",
        [weddingA, eve.id],
      ),
    );
    expect((await eve.client.from("weddings").select("id").eq("id", weddingA)).data).toHaveLength(
      1,
    );
    expect(
      (await eve.client.from("audit_events").select("id").eq("wedding_id", weddingA)).data,
    ).toEqual([]);

    await withSuperuser((db) =>
      db.query(
        "update public.memberships set status='removed' where wedding_id=$1 and user_id=$2",
        [weddingA, eve.id],
      ),
    );
    expect((await eve.client.from("weddings").select("id").eq("id", weddingA)).data).toEqual([]);
  });

  it("owners and partners can read the audit log", async () => {
    const audit = await alice.client
      .from("audit_events")
      .select("action")
      .eq("wedding_id", weddingA);
    expect(audit.data).toEqual([{ action: "wedding.created" }]);
  });
});

describe("audit log is append-only", () => {
  it("rejects update and delete, even for a privileged connection", async () => {
    await withSuperuser(async (db) => {
      await expect(
        db.query("update public.audit_events set action='x' where wedding_id=$1", [weddingA]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("delete from public.audit_events where wedding_id=$1", [weddingA]),
      ).rejects.toThrow(/append-only/);
    });
  });
});

describe("private storage defaults", () => {
  it("the document bucket is private and members only can read their wedding's objects", async () => {
    const { data: bucket } = await adminClient().storage.getBucket("wedding-documents");
    expect(bucket?.public).toBe(false);

    // R1-08 tightened this: an object is readable only through a completed document row, and only
    // by owners and partners (see documents.test.ts for the full matrix).
    const id = randomUUID();
    const path = `${weddingA}/${id}`;
    const body = new Blob(["%PDF-1.7 synthetic file"], { type: "application/pdf" });
    const upload = await adminClient().storage.from("wedding-documents").upload(path, body);
    expect(upload.error).toBeNull();
    expect(
      (await alice.client.storage.from("wedding-documents").createSignedUrl(path, 60)).error,
    ).not.toBeNull();
    await withSuperuser((db) =>
      db.query(
        `insert into public.documents (id, wedding_id, kind, title, storage_key, mime, bytes, checksum, scan_status)
         values ($1, $2, 'other', 'Synthetic', $3, 'application/pdf', 23, $4, 'unscanned')`,
        [id, weddingA, path, "a".repeat(64)],
      ),
    );

    // Owner can sign a URL and list; outsider and anonymous cannot.
    expect(
      (await alice.client.storage.from("wedding-documents").createSignedUrl(path, 60)).error,
    ).toBeNull();
    expect(
      (await bob.client.storage.from("wedding-documents").createSignedUrl(path, 60)).error,
    ).not.toBeNull();
    expect(
      (await bob.client.storage.from("wedding-documents").download(path)).error,
    ).not.toBeNull();
    expect(
      (await anonClient().storage.from("wedding-documents").download(path)).error,
    ).not.toBeNull();
    expect((await bob.client.storage.from("wedding-documents").list(weddingA)).data).toEqual([]);

    // The public (unauthenticated) object URL must not serve a private object.
    const publicUrl = anonClient().storage.from("wedding-documents").getPublicUrl(path)
      .data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);

    // Members cannot upload directly: only the server does, after validating.
    const memberUpload = await alice.client.storage
      .from("wedding-documents")
      .upload(`${weddingA}/${randomUUID()}`, body);
    expect(memberUpload.error).not.toBeNull();

    await adminClient().storage.from("wedding-documents").remove([path]);
  });
});
