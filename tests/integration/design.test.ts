import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let other: TestUser;
const BUCKET = "wedding-design";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  owner = await createUser("db-owner");
  other = await createUser("db-other");
});

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

async function rpc<T>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await user.client.rpc(fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}

const board = (user: TestUser, w: string, extra: Record<string, unknown> = {}) =>
  user.client.rpc("create_design_board", { p_wedding: w, p_title: "Florals", ...extra });

async function newBoard(w: string, extra: Record<string, unknown> = {}) {
  const r = await board(owner, w, extra);
  if (r.error) throw new Error(r.error.message);
  return r.data as string;
}
const link = (user: TestUser, w: string, b: string, extra: Record<string, unknown> = {}) =>
  user.client.rpc("add_design_item", {
    p_wedding: w,
    p_board: b,
    p_kind: "link",
    p_title: "Arch",
    p_url: "https://example.com/arch",
    ...extra,
  });
async function newLink(w: string, b: string, extra: Record<string, unknown> = {}) {
  const r = await link(owner, w, b, extra);
  if (r.error) throw new Error(r.error.message);
  return r.data as string;
}
const intent = (user: TestUser, w: string, b: string, extra: Record<string, unknown> = {}) =>
  user.client.rpc("create_design_image_intent", {
    p_wedding: w,
    p_board: b,
    p_title: "Bouquet",
    p_rights: "own",
    p_mime: "image/png",
    p_bytes: PNG.byteLength,
    ...extra,
  });
async function newImage(w: string, b: string) {
  const r = await intent(owner, w, b);
  if (r.error) throw new Error(r.error.message);
  const id = r.data as string;
  const key = `${w}/${id}`;
  const up = await adminClient().storage.from(BUCKET).upload(key, PNG, {
    contentType: "image/png",
    upsert: false,
  });
  if (up.error) throw new Error(up.error.message);
  const done = await adminClient().rpc("complete_design_image", {
    p_item: id,
    p_checksum: sha(PNG),
    p_bytes: PNG.byteLength,
  });
  if (done.error) throw new Error(done.error.message);
  return { id, key };
}
async function itemRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      status: string;
      version: number;
      position: number;
      favorite: boolean;
      storage_key: string | null;
      title: string;
    }>(
      "select status, version, position, favorite, storage_key, title from public.design_items where id=$1",
      [id],
    );
    return r.rows[0];
  });
}
async function count(table: string, w: string) {
  return withSuperuser(async (db) =>
    Number(
      (await db.query(`select count(*)::int as v from public.${table} where wedding_id=$1`, [w]))
        .rows[0].v,
    ),
  );
}
async function canDownload(user: TestUser, key: string) {
  const { data, error } = await user.client.storage.from(BUCKET).download(key);
  return !error && data !== null;
}

describe("boards", () => {
  it("creates a board with a palette and audits it without content", async () => {
    const w = await createWedding(owner);
    const id = await newBoard(w, { p_palette: ["#d88c9a", "#3d5a50"], p_description: "Ivory" });
    const rows = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select palette, description, version from public.design_boards where id=$1",
            [id],
          )
        ).rows,
    );
    expect(rows[0].palette).toEqual(["#d88c9a", "#3d5a50"]);
    expect(rows[0].version).toBe(1);
    const audit = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes::text as c from public.audit_events where entity_id=$1",
            [id],
          )
        ).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].c).not.toContain("Florals");
  });

  it("rejects bad titles and palettes without leaving rows", async () => {
    const w = await createWedding(owner);
    for (const extra of [
      { p_title: "  " },
      { p_title: "x".repeat(121) },
      { p_palette: ["red"] },
      { p_palette: ["#D88C9A"] },
      { p_palette: ["#aaaaaa", "#aaaaaa"] },
      { p_palette: Array.from({ length: 9 }, (_, i) => `#00000${i}`) },
      { p_description: "x".repeat(1001) },
    ]) {
      const r = await board(owner, w, extra);
      expect(r.error?.code, JSON.stringify(extra).slice(0, 40)).toBe("22023");
    }
    expect(await count("design_boards", w)).toBe(0);
  });

  it("replays an idempotent create and rejects a changed payload on the same key", async () => {
    const w = await createWedding(owner);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => board(owner, w, { p_idempotency_key: key })),
    );
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("design_boards", w)).toBe(1);
    const changed = await board(owner, w, { p_idempotency_key: key, p_title: "Other" });
    expect(changed.error?.code).toBe("23505");
  });

  it("versions updates, treats a no-op as no change and refuses a stale write", async () => {
    const w = await createWedding(owner);
    const id = await newBoard(w);
    const args = { p_wedding: w, p_board: id, p_expected_version: 1, p_title: "Florals" };
    expect(await rpc<number>(owner, "update_design_board", args)).toBe(1);
    expect(
      await rpc<number>(owner, "update_design_board", {
        ...args,
        p_title: "Table",
        p_palette: ["#ffffff"],
      }),
    ).toBe(2);
    const stale = await owner.client.rpc("update_design_board", { ...args, p_title: "Late" });
    expect(stale.error?.code).toBe("55000");
  });

  it("two concurrent edits from the same version have exactly one winner", async () => {
    const w = await createWedding(owner);
    const id = await newBoard(w);
    const base = { p_wedding: w, p_board: id, p_expected_version: 1 };
    const results = await Promise.all([
      owner.client.rpc("update_design_board", { ...base, p_title: "A" }),
      owner.client.rpc("update_design_board", { ...base, p_title: "B" }),
    ]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("55000");
  });

  it("archives a board, hides it, and blocks further changes", async () => {
    const w = await createWedding(owner);
    const id = await newBoard(w);
    await rpc(owner, "archive_design_board", { p_wedding: w, p_board: id, p_expected_version: 1 });
    // A repeat is harmless even though the version moved on.
    await rpc(owner, "archive_design_board", { p_wedding: w, p_board: id, p_expected_version: 1 });
    expect((await link(owner, w, id)).error?.code).toBe("42501");
    const stale = await owner.client.rpc("update_design_board", {
      p_wedding: w,
      p_board: id,
      p_expected_version: 2,
      p_title: "x",
    });
    expect(stale.error?.code).toBe("55000");
  });
});

describe("items: links and notes", () => {
  it("saves a link with positions in order and never touches the network", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const a1 = await newLink(w, b, { p_title: "One" });
    const a2 = await newLink(w, b, { p_title: "Two" });
    expect((await itemRow(a1))?.position).toBe(0);
    expect((await itemRow(a2))?.position).toBe(1);
  });

  it("rejects unsafe or malformed URLs and kind mismatches", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://user:pw@example.com",
      "https://exa mple.com",
      "ftp://example.com",
      "",
      `https://example.com/${"a".repeat(2100)}`,
    ]) {
      const r = await link(owner, w, b, { p_url: url });
      expect(r.error?.code, url.slice(0, 30)).toBe("22023");
    }
    const noteWithUrl = await owner.client.rpc("add_design_item", {
      p_wedding: w,
      p_board: b,
      p_kind: "note",
      p_title: "n",
      p_url: "https://example.com",
    });
    expect(noteWithUrl.error?.code).toBe("22023");
    const image = await owner.client.rpc("add_design_item", {
      p_wedding: w,
      p_board: b,
      p_kind: "image",
      p_title: "n",
    });
    expect(image.error?.code).toBe("22023");
    expect(await count("design_items", w)).toBe(0);
  });

  it("table constraints refuse a link without a URL and a note with one", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.design_items (wedding_id, board_id, kind, title, position) values ($1,$2,'link','x',0)",
          [w, b],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.design_items (wedding_id, board_id, kind, title, url, position) values ($1,$2,'note','x','https://a.example/',0)",
          [w, b],
        ),
      ),
    ).rejects.toThrow();
  });

  it("replays an idempotent add under concurrent submits", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => link(owner, w, b, { p_idempotency_key: key })),
    );
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("design_items", w)).toBe(1);
  });

  it("concurrent adds get distinct positions", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    await Promise.all(Array.from({ length: 6 }, (_, i) => link(owner, w, b, { p_title: `T${i}` })));
    const positions = await withSuperuser(async (db) =>
      (
        await db.query(
          "select position from public.design_items where board_id=$1 order by position",
          [b],
        )
      ).rows.map((r) => r.position as number),
    );
    expect(positions).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("links a vendor from the same wedding only", async () => {
    const w = await createWedding(owner);
    const w2 = await createWedding(other);
    const b = await newBoard(w);
    const mine = await rpc<string>(owner, "create_candidate", {
      p_wedding: w,
      p_kind: "vendor",
      p_category: "florist",
      p_name: "Petal Co",
    });
    const theirs = await rpc<string>(other, "create_candidate", {
      p_wedding: w2,
      p_kind: "vendor",
      p_category: "florist",
      p_name: "Elsewhere",
    });
    expect((await link(owner, w, b, { p_candidate: mine })).error).toBeNull();
    expect((await link(owner, w, b, { p_candidate: theirs })).error?.code).toBe("22023");
  });

  it("edits, favourites and removes with version checks; no-ops don't bump the version", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const id = await newLink(w, b);
    const upd = (v: number, extra: Record<string, unknown> = {}) =>
      owner.client.rpc("update_design_item", {
        p_wedding: w,
        p_item: id,
        p_expected_version: v,
        p_title: "Arch",
        p_url: "https://example.com/arch",
        ...extra,
      });
    expect((await upd(1)).data).toBe(1);
    expect((await upd(1, { p_title: "Arch 2", p_note: "Lovely" })).data).toBe(2);
    expect((await upd(1, { p_title: "Late" })).error?.code).toBe("55000");
    expect((await upd(2, { p_url: "javascript:1" })).error?.code).toBe("22023");
    expect((await upd(2, { p_rights: "own" })).error?.code).toBe("22023");
    const fav = (v: number, on: boolean) =>
      owner.client.rpc("set_design_favorite", {
        p_wedding: w,
        p_item: id,
        p_expected_version: v,
        p_favorite: on,
      });
    expect((await fav(2, true)).data).toBe(3);
    expect((await fav(3, true)).data).toBe(3);
    expect((await fav(2, false)).error?.code).toBe("55000");
    const gone = await owner.client.rpc("remove_design_item", {
      p_wedding: w,
      p_item: id,
      p_expected_version: 2,
    });
    expect(gone.error?.code).toBe("55000");
    const ok = await owner.client.rpc("remove_design_item", {
      p_wedding: w,
      p_item: id,
      p_expected_version: 3,
    });
    expect(ok.error).toBeNull();
    expect(await itemRow(id)).toBeUndefined();
    // Removing again is harmless.
    expect(
      (
        await owner.client.rpc("remove_design_item", {
          p_wedding: w,
          p_item: id,
          p_expected_version: 3,
        })
      ).error,
    ).toBeNull();
  });

  it("reorders by swapping with the neighbour and stops at the ends", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const ids = [
      await newLink(w, b, { p_title: "A" }),
      await newLink(w, b, { p_title: "B" }),
      await newLink(w, b, { p_title: "C" }),
    ];
    const order = async () =>
      withSuperuser(async (db) =>
        (
          await db.query(
            "select title from public.design_items where board_id=$1 order by position",
            [b],
          )
        ).rows.map((r) => r.title as string),
      );
    const move = (id: string, d: string) =>
      owner.client.rpc("move_design_item", { p_wedding: w, p_item: id, p_direction: d });
    expect((await move(ids[2]!, "earlier")).error).toBeNull();
    expect(await order()).toEqual(["A", "C", "B"]);
    // First item cannot move earlier, last cannot move later.
    expect((await move(ids[0]!, "earlier")).error).toBeNull();
    expect(await order()).toEqual(["A", "C", "B"]);
    expect((await move(ids[1]!, "later")).error).toBeNull();
    expect(await order()).toEqual(["A", "C", "B"]);
    expect((await move(ids[0]!, "later")).error).toBeNull();
    expect(await order()).toEqual(["C", "A", "B"]);
    expect((await move(ids[0]!, "sideways")).error?.code).toBe("22023");
  });
});

describe("images", () => {
  it("records a pending intent with a random key, readable by nobody", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const r = await intent(owner, w, b, { p_original_name: "../../evil.png" });
    expect(r.error).toBeNull();
    const row = await itemRow(r.data as string);
    expect(row?.status).toBe("pending");
    expect(row?.storage_key).toBe(`${w}/${r.data}`);
    const listed = await owner.client
      .from("design_items")
      .select("id")
      .eq("id", r.data as string);
    expect(listed.data).toEqual([]);
  });

  it("validates intent input", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    for (const extra of [
      { p_rights: "stolen" },
      { p_rights: null },
      { p_mime: "application/pdf" },
      { p_mime: "image/svg+xml" },
      { p_bytes: 0 },
      { p_bytes: 5 * 1024 * 1024 + 1 },
      { p_title: "" },
    ]) {
      const r = await intent(owner, w, b, extra);
      expect(r.error?.code, JSON.stringify(extra)).toBe("22023");
    }
    expect(await count("design_items", w)).toBe(0);
  });

  it("becomes visible only after the server completes it, and members can read it", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const viewer = await addMember(w, "viewer", "db-viewer");
    const pending = await intent(owner, w, b);
    const pendingId = pending.data as string;
    expect(await canDownload(owner, `${w}/${pendingId}`)).toBe(false);
    const { id, key } = await newImage(w, b);
    expect((await itemRow(id))?.status).toBe("ready");
    expect(await canDownload(owner, key)).toBe(true);
    expect(await canDownload(viewer, key)).toBe(true);
    const signed = await viewer.client.storage.from(BUCKET).createSignedUrl(key, 30);
    expect(signed.data?.signedUrl).toBeTruthy();
  });

  it("denies other tenants, anonymous callers and uploads from clients", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const { key } = await newImage(w, b);
    expect(await canDownload(other, key)).toBe(false);
    expect((await other.client.storage.from(BUCKET).createSignedUrl(key, 30)).data).toBeNull();
    const up = await owner.client.storage.from(BUCKET).upload(`${w}/${randomUUID()}`, PNG, {
      contentType: "image/png",
    });
    expect(up.error).not.toBeNull();
    const pub = await fetch(
      `${process.env.TEST_API_URL ?? "http://127.0.0.1:54321"}/storage/v1/object/public/${BUCKET}/${key}`,
    );
    expect(pub.ok).toBe(false);
  });

  it("only the service role can complete or reject, and a mismatched size is refused", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const id = (await intent(owner, w, b)).data as string;
    for (const fn of [
      ["complete_design_image", { p_item: id, p_checksum: sha(PNG), p_bytes: PNG.byteLength }],
      ["reject_design_image", { p_item: id, p_reason: "x" }],
    ] as const) {
      const r = await owner.client.rpc(fn[0], fn[1]);
      expect(r.error, fn[0]).not.toBeNull();
    }
    const noObject = await adminClient().rpc("complete_design_image", {
      p_item: id,
      p_checksum: sha(PNG),
      p_bytes: PNG.byteLength,
    });
    expect(noObject.error?.code).toBe("22023");
    await adminClient()
      .storage.from(BUCKET)
      .upload(`${w}/${id}`, PNG, { contentType: "image/png" });
    const wrong = await adminClient().rpc("complete_design_image", {
      p_item: id,
      p_checksum: sha(PNG),
      p_bytes: PNG.byteLength + 1,
    });
    expect(wrong.error?.code).toBe("22023");
    const done = await adminClient().rpc("complete_design_image", {
      p_item: id,
      p_checksum: sha(PNG),
      p_bytes: PNG.byteLength,
    });
    expect(done.error).toBeNull();
    const again = await adminClient().rpc("complete_design_image", {
      p_item: id,
      p_checksum: sha(PNG),
      p_bytes: PNG.byteLength,
    });
    expect(again.error?.code).toBe("55000");
  });

  it("a rejected image is never listed or readable", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const id = (await intent(owner, w, b)).data as string;
    await adminClient()
      .storage.from(BUCKET)
      .upload(`${w}/${id}`, PNG, { contentType: "image/png" });
    const rej = await adminClient().rpc("reject_design_image", { p_item: id, p_reason: "Bad" });
    expect(rej.error).toBeNull();
    expect(await canDownload(owner, `${w}/${id}`)).toBe(false);
    const edit = await owner.client.rpc("update_design_item", {
      p_wedding: w,
      p_item: id,
      p_expected_version: 2,
      p_title: "x",
      p_rights: "own",
    });
    expect(edit.error?.code).toBe("42501");
  });

  it("edits rights on an image and removing the row makes the object unreadable", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const { id, key } = await newImage(w, b);
    const edit = await owner.client.rpc("update_design_item", {
      p_wedding: w,
      p_item: id,
      p_expected_version: (await itemRow(id))!.version,
      p_title: "Bouquet",
      p_rights: "permission",
    });
    expect(edit.error).toBeNull();
    const gone = await owner.client.rpc("remove_design_item", {
      p_wedding: w,
      p_item: id,
      p_expected_version: edit.data as number,
    });
    expect(gone.data).toBe(key);
    expect(await canDownload(owner, key)).toBe(false);
  });

  it("archiving the board hides its images from every member", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const { key } = await newImage(w, b);
    expect(await canDownload(owner, key)).toBe(true);
    await rpc(owner, "archive_design_board", { p_wedding: w, p_board: b, p_expected_version: 1 });
    expect(await canDownload(owner, key)).toBe(false);
  });

  it("caps in-flight uploads", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    for (let i = 0; i < 10; i++) expect((await intent(owner, w, b)).error).toBeNull();
    expect((await intent(owner, w, b)).error?.code).toBe("54000");
  });
});

describe("authorization", () => {
  it("lets every member read but only owner and partner write", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const item = await newLink(w, b);
    const partner = await addMember(w, "partner", "db-partner");
    const editor = await addMember(w, "editor", "db-editor");
    const viewer = await addMember(w, "viewer", "db-viewer2");
    for (const reader of [owner, partner, editor, viewer]) {
      const boards = await reader.client.from("design_boards").select("id").eq("wedding_id", w);
      const items = await reader.client.from("design_items").select("id").eq("wedding_id", w);
      expect(boards.data).toHaveLength(1);
      expect(items.data).toHaveLength(1);
    }
    expect((await board(partner, w)).error).toBeNull();
    for (const denied of [editor, viewer, other]) {
      expect((await board(denied, w)).error?.code).toBe("42501");
      expect((await link(denied, w, b)).error?.code).toBe("42501");
      expect((await intent(denied, w, b)).error?.code).toBe("42501");
      expect(
        (
          await denied.client.rpc("update_design_item", {
            p_wedding: w,
            p_item: item,
            p_expected_version: 1,
            p_title: "x",
            p_url: "https://example.com/",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await denied.client.rpc("set_design_favorite", {
            p_wedding: w,
            p_item: item,
            p_expected_version: 1,
            p_favorite: true,
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await denied.client.rpc("move_design_item", {
            p_wedding: w,
            p_item: item,
            p_direction: "later",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await denied.client.rpc("remove_design_item", {
            p_wedding: w,
            p_item: item,
            p_expected_version: 1,
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await denied.client.rpc("archive_design_board", {
            p_wedding: w,
            p_board: b,
            p_expected_version: 1,
          })
        ).error?.code,
      ).toBe("42501");
    }
    expect((await itemRow(item))?.version).toBe(1);
  });

  it("isolates tenants by UUID and refuses cross-wedding ids", async () => {
    const w = await createWedding(owner);
    const w2 = await createWedding(other);
    const b = await newBoard(w);
    const item = await newLink(w, b);
    const sees = await other.client.from("design_boards").select("id").eq("id", b);
    expect(sees.data).toEqual([]);
    expect((await other.client.from("design_items").select("id").eq("id", item)).data).toEqual([]);
    // Own wedding id with another wedding's board or item id.
    expect((await link(other, w2, b)).error?.code).toBe("42501");
    expect(
      (
        await other.client.rpc("remove_design_item", {
          p_wedding: w2,
          p_item: item,
          p_expected_version: 1,
        })
      ).error,
    ).toBeNull();
    expect(await itemRow(item)).toBeDefined();
  });

  it("denies direct table writes and anonymous access", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const ins = await owner.client.from("design_boards").insert({ wedding_id: w, title: "x" });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("design_boards").update({ title: "hacked" }).eq("id", b);
    expect(upd.data ?? []).toEqual([]);
    const itemIns = await owner.client
      .from("design_items")
      .insert({ wedding_id: w, board_id: b, kind: "note", title: "x", position: 0 });
    expect(itemIns.error).not.toBeNull();
    const row = await withSuperuser(
      async (db) =>
        (await db.query("select title from public.design_boards where id=$1", [b])).rows[0],
    );
    expect(row.title).toBe("Florals");
  });

  it("revokes access immediately when membership ends", async () => {
    const w = await createWedding(owner);
    const b = await newBoard(w);
    const { key } = await newImage(w, b);
    const viewer = await addMember(w, "viewer", "db-viewer3");
    expect(await canDownload(viewer, key)).toBe(true);
    await withSuperuser((db) =>
      db.query("delete from public.memberships where user_id=$1", [viewer.id]),
    );
    expect(await canDownload(viewer, key)).toBe(false);
    expect((await viewer.client.from("design_boards").select("id").eq("id", b)).data).toEqual([]);
  });
});
