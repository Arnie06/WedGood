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

let owner: TestUser;
let partner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let wedding: string;
let other: string;
let revision: number;

async function join(w: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await createUser(label);
  await withSuperuser((db) =>
    db.query("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
      w,
      user.id,
      role,
    ]),
  );
  return user;
}

const doc = {
  title: "Example book",
  recipient: "The couple",
  presetLabel: "Wedding book",
  weddingDate: null,
  sections: [],
};
const args = (w: string, id: string, over: Record<string, unknown> = {}) => ({
  p_wedding: w,
  p_id: id,
  p_title: "Example book",
  p_preset: "master",
  p_recipient: "The couple",
  p_sections: ["overview", "events"],
  p_options: { includeContacts: false, includeNotes: false },
  p_formats: ["pdf", "csv"],
  p_paper: "a4",
  p_orientation: "portrait",
  p_snapshot: doc,
  p_digest: "a".repeat(64),
  p_expected_revision: revision,
  p_template_version: 1,
  p_generated_at: new Date().toISOString(),
  p_artifacts: [
    { format: "pdf", checksum: "b".repeat(64), bytes: 1200 },
    { format: "csv", checksum: "c".repeat(64), bytes: 300 },
  ],
  ...over,
});
const create = (
  user: TestUser,
  id = randomUUID(),
  over: Record<string, unknown> = {},
  w = wedding,
) => user.client.rpc("create_package", args(w, id, over));
const count = (w = wedding) =>
  withSuperuser(async (db) =>
    Number(
      (await db.query("select count(*) from public.packages where wedding_id=$1", [w])).rows[0]
        .count,
    ),
  );

beforeAll(async () => {
  owner = await createUser("pk-owner");
  outsider = await createUser("pk-outsider");
  wedding = await createWedding(owner, { name: "Packages wedding" });
  other = await createWedding(outsider, { name: "Other wedding" });
  partner = await join(wedding, "partner", "pk-partner");
  editor = await join(wedding, "editor", "pk-editor");
  viewer = await join(wedding, "viewer", "pk-viewer");
  revision = await withSuperuser(
    async (db) =>
      (await db.query("select revision from public.weddings where id=$1", [wedding])).rows[0]
        .revision as number,
  );
});

describe("create_package", () => {
  it("lets the owner and a partner create a package with derived storage keys and an audit event", async () => {
    for (const user of [owner, partner]) {
      const id = randomUUID();
      const r = await create(user, id);
      expect(r.error).toBeNull();
      expect(r.data).toBe(id);
      const rows = await user.client
        .from("package_artifacts")
        .select("format, storage_key, bytes")
        .eq("package_id", id)
        .order("format");
      expect(rows.data).toEqual([
        { format: "csv", storage_key: `${wedding}/${id}.csv`, bytes: 300 },
        { format: "pdf", storage_key: `${wedding}/${id}.pdf`, bytes: 1200 },
      ]);
    }
    const audit = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes from public.audit_events where wedding_id=$1 and action='package.created' limit 1",
            [wedding],
          )
        ).rows[0].safe_changes,
    );
    expect(audit).toEqual({ preset: "master", sections: 2, formats: ["csv", "pdf"] });
  });

  it("refuses editors, viewers, outsiders and anonymous callers, and shows them nothing", async () => {
    const id = randomUUID();
    const before = await count();
    for (const user of [editor, viewer, outsider]) {
      const r = await create(user, id);
      expect(r.error?.code).toBe("42501");
    }
    const anon = await anonClient().rpc("create_package", args(wedding, id));
    expect(anon.error).not.toBeNull();
    expect(await count()).toBe(before);

    const known = await create(owner);
    expect(known.error).toBeNull();
    for (const user of [editor, viewer, outsider]) {
      const pk = await user.client.from("packages").select("id").eq("wedding_id", wedding);
      expect(pk.data).toEqual([]);
      const ar = await user.client.from("package_artifacts").select("id").eq("wedding_id", wedding);
      expect(ar.data).toEqual([]);
    }
  });

  it("replays the same request to the same package and rejects a changed one on the same id", async () => {
    const id = randomUUID();
    const a = await create(owner, id);
    const b = await create(owner, id);
    expect(a.data).toBe(id);
    expect(b.data).toBe(id);
    const rows = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) from public.package_artifacts where package_id=$1", [id]))
          .rows[0].count,
      ),
    );
    expect(rows).toBe(2);
    const changed = await create(owner, id, { p_digest: "d".repeat(64) });
    expect(changed.error?.code).toBe("23505");
  });

  it("creates exactly one package for concurrent identical submits", async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(owner, id)));
    expect(results.every((r) => r.data === id)).toBe(true);
    expect(results.filter((r) => r.error)).toHaveLength(0);
    const n = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) from public.packages where id=$1", [id])).rows[0].count,
      ),
    );
    expect(n).toBe(1);
  });

  it("refuses when the plan revision moved on", async () => {
    const r = await create(owner, randomUUID(), { p_expected_revision: revision + 1 });
    expect(r.error?.code).toBe("55000");
  });

  it("validates inputs", async () => {
    const bad: Record<string, unknown>[] = [
      { p_digest: "nope" },
      { p_title: "  " },
      { p_preset: "secret" },
      { p_sections: ["overview", "guests_private"] },
      { p_sections: [] },
      { p_formats: ["pdf", "docx"] },
      { p_paper: "folio" },
      { p_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
      { p_artifacts: [{ format: "pdf", checksum: "b".repeat(64), bytes: 10 }] },
      {
        p_artifacts: [
          { format: "pdf", checksum: "short", bytes: 10 },
          { format: "csv", checksum: "c".repeat(64), bytes: 10 },
        ],
      },
      {
        p_artifacts: [
          { format: "pdf", checksum: "b".repeat(64), bytes: 0 },
          { format: "csv", checksum: "c".repeat(64), bytes: 10 },
        ],
      },
      { p_snapshot: { blob: "x".repeat(1_100_000) } },
    ];
    for (const over of bad) {
      const r = await create(owner, randomUUID(), over);
      expect(r.error, JSON.stringify(Object.keys(over))).not.toBeNull();
    }
  });

  it("does not let a package id from one wedding be reused in another", async () => {
    const id = randomUUID();
    expect((await create(owner, id)).error).toBeNull();
    const clash = await outsider.client.rpc(
      "create_package",
      args(other, id, { p_expected_revision: 1 }),
    );
    expect(clash.error?.code).toBe("23505");
    const seen = await outsider.client.from("packages").select("id").eq("id", id);
    expect(seen.data).toEqual([]);
  });

  it("limits how many packages one person makes per hour", async () => {
    const solo = await createUser("pk-rate");
    const w = await createWedding(solo, { name: "Rate wedding" });
    const rev = 1;
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await solo.client.rpc(
        "create_package",
        args(w, randomUUID(), { p_expected_revision: rev }),
      );
      if (i < 20) expect(last.error).toBeNull();
    }
    expect(last?.error?.code).toBe("54000");
  });
});

describe("immutability and direct access", () => {
  it("rejects updates even from a superuser and denies direct writes from clients", async () => {
    const id = randomUUID();
    await create(owner, id);
    await expect(
      withSuperuser((db) => db.query("update public.packages set title='x' where id=$1", [id])),
    ).rejects.toThrow(/immutable/);
    await expect(
      withSuperuser((db) =>
        db.query("update public.package_artifacts set bytes=5 where package_id=$1", [id]),
      ),
    ).rejects.toThrow(/immutable/);

    const ins = await owner.client.from("packages").insert({
      id: randomUUID(),
      wedding_id: wedding,
      title: "direct",
    });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("packages").update({ title: "hacked" }).eq("id", id);
    expect(upd.error ?? upd.data).toBeTruthy();
    const del = await owner.client.from("packages").delete().eq("id", id).select();
    expect(del.data ?? []).toEqual([]);
    const still = await owner.client.from("packages").select("title").eq("id", id).single();
    expect(still.data?.title).toBe("Example book");
  });

  it("cuts a removed partner off immediately", async () => {
    const temp = await join(wedding, "partner", "pk-temp");
    const id = randomUUID();
    expect((await create(temp, id)).error).toBeNull();
    expect((await temp.client.from("packages").select("id").eq("id", id)).data).toHaveLength(1);
    await withSuperuser((db) =>
      db.query("delete from public.memberships where wedding_id=$1 and user_id=$2", [
        wedding,
        temp.id,
      ]),
    );
    expect((await temp.client.from("packages").select("id").eq("id", id)).data).toEqual([]);
    expect((await create(temp)).error?.code).toBe("42501");
  });
});

describe("private bucket", () => {
  it("is private, size and type limited, and unreadable by any signed-in user", async () => {
    const bucket = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select public, file_size_limit, allowed_mime_types from storage.buckets where id='wedding-packages'",
          )
        ).rows[0],
    );
    expect(bucket.public).toBe(false);
    expect(bucket.file_size_limit).toBe("5242880");
    expect(bucket.allowed_mime_types).toEqual(["application/pdf", "text/csv"]);

    const key = `${wedding}/${randomUUID()}.csv`;
    const up = await adminClient()
      .storage.from("wedding-packages")
      .upload(key, new TextEncoder().encode("a,b\r\n1,2\r\n"), { contentType: "text/csv" });
    expect(up.error).toBeNull();

    for (const user of [owner, partner, viewer, outsider]) {
      const dl = await user.client.storage.from("wedding-packages").download(key);
      expect(dl.error).not.toBeNull();
      const signed = await user.client.storage.from("wedding-packages").createSignedUrl(key, 60);
      expect(signed.error).not.toBeNull();
      const wr = await user.client.storage
        .from("wedding-packages")
        .upload(`${wedding}/${randomUUID()}.csv`, new TextEncoder().encode("x"), {
          contentType: "text/csv",
        });
      expect(wr.error).not.toBeNull();
    }
    const pub = await fetch(
      `${(await import("./helpers")).localStack().apiUrl}/storage/v1/object/public/wedding-packages/${key}`,
    );
    expect(pub.status).toBeGreaterThanOrEqual(400);

    const rejected = await adminClient()
      .storage.from("wedding-packages")
      .upload(`${wedding}/${randomUUID()}.html`, new TextEncoder().encode("<script>"), {
        contentType: "text/html",
      });
    expect(rejected.error).not.toBeNull();
    await adminClient().storage.from("wedding-packages").remove([key]);
  });
});
