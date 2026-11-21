import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let outsider: TestUser;
let partner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let wedding: string;
let candidate: string;
let board: string;
let comparison: string;

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

const add = (
  user: TestUser,
  extra: Record<string, unknown> = {},
  w = wedding,
  subject = candidate,
) =>
  user.client.rpc("add_comment", {
    p_wedding: w,
    p_kind: "candidate",
    p_subject: subject,
    p_body: "Love the light here",
    ...extra,
  });
async function post(user: TestUser, body = "Love the light here") {
  const r = await add(user, { p_body: body });
  if (r.error) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.data as string;
}
const count = (w = wedding) =>
  withSuperuser(async (db) =>
    Number(
      (await db.query("select count(*) from public.comments where wedding_id=$1", [w])).rows[0]
        .count,
    ),
  );

beforeAll(async () => {
  owner = await createUser("c-owner");
  outsider = await createUser("c-out");
  wedding = await createWedding(owner);
  partner = await join(wedding, "partner", "c-partner");
  editor = await join(wedding, "editor", "c-editor");
  viewer = await join(wedding, "viewer", "c-viewer");
  const c = await owner.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Barn",
  });
  if (c.error) throw new Error(c.error.message);
  candidate = c.data as string;
  const b = await owner.client.rpc("create_design_board", {
    p_wedding: wedding,
    p_title: "Florals",
  });
  if (b.error) throw new Error(b.error.message);
  board = b.data as string;
  comparison = await withSuperuser(
    async (db) =>
      (
        await db.query(
          `insert into public.comparisons (wedding_id, title, scenario_guest_count, currency)
           values ($1, 'Venues', 100, 'USD') returning id`,
          [wedding],
        )
      ).rows[0].id as string,
  );
});

describe("posting", () => {
  it("lets every member role comment, including viewers", async () => {
    for (const u of [owner, partner, editor, viewer]) {
      const r = await add(u);
      expect(r.error).toBeNull();
      expect(typeof r.data).toBe("string");
    }
  });

  it("works on all three subject kinds", async () => {
    for (const [kind, subject] of [
      ["candidate", candidate],
      ["comparison", comparison],
      ["design_board", board],
    ] as const) {
      const r = await viewer.client.rpc("add_comment", {
        p_wedding: wedding,
        p_kind: kind,
        p_subject: subject,
        p_body: `On ${kind}`,
      });
      expect(r.error).toBeNull();
    }
  });

  it("denies outsiders and signed-out callers with the same error as an unknown workspace", async () => {
    const before = await count();
    const r = await add(outsider);
    expect(r.error?.code).toBe("42501");
    const unknown = await add(outsider, {}, randomUUID());
    expect(unknown.error?.code).toBe("42501");
    expect(unknown.error?.message).toBe(r.error?.message);
    const anon = await add({ client: anonClient() } as TestUser);
    expect(anon.error).not.toBeNull();
    expect(await count()).toBe(before);
  });

  it("refuses a subject from another wedding, an unknown subject and an unknown kind", async () => {
    const other = await createWedding(outsider);
    const foreign = await outsider.client.rpc("create_design_board", {
      p_wedding: other,
      p_title: "Theirs",
    });
    const foreignBoard = foreign.data as string;
    const cross = await viewer.client.rpc("add_comment", {
      p_wedding: wedding,
      p_kind: "design_board",
      p_subject: foreignBoard,
      p_body: "hi",
    });
    expect(cross.error?.code).toBe("55000");
    expect((await add(viewer, {}, wedding, randomUUID())).error?.code).toBe("55000");
    expect((await add(viewer, { p_kind: "guest" })).error?.code).toBe("22023");
    // Even a subject kind mismatch (a board id offered as a candidate) fails.
    expect((await add(viewer, {}, wedding, board)).error?.code).toBe("55000");
  });

  it("rejects empty, whitespace and over-long text and trims stored text", async () => {
    expect((await add(viewer, { p_body: "" })).error?.code).toBe("22023");
    expect((await add(viewer, { p_body: "   \n " })).error?.code).toBe("22023");
    expect((await add(viewer, { p_body: "a".repeat(2001) })).error?.code).toBe("22023");
    const id = await post(viewer, "  padded  ");
    const row = await withSuperuser((db) =>
      db.query("select body from public.comments where id=$1", [id]),
    );
    expect(row.rows[0].body).toBe("padded");
  });

  it("refuses to comment on an archived subject", async () => {
    const b = await owner.client.rpc("create_design_board", { p_wedding: wedding, p_title: "Old" });
    const id = b.data as string;
    await withSuperuser((db) =>
      db.query("update public.design_boards set archived_at = now() where id=$1", [id]),
    );
    const r = await viewer.client.rpc("add_comment", {
      p_wedding: wedding,
      p_kind: "design_board",
      p_subject: id,
      p_body: "late",
    });
    expect(r.error?.code).toBe("55000");
  });
});

describe("idempotency and limits", () => {
  it("replays the same key to the same comment without a duplicate", async () => {
    const key = `key-${randomUUID()}`;
    const a = await add(editor, { p_body: "once", p_idempotency_key: key });
    const b = await add(editor, { p_body: "once", p_idempotency_key: key });
    expect(a.error).toBeNull();
    expect(b.data).toBe(a.data);
    const n = await withSuperuser((db) =>
      db.query("select count(*) from public.comments where body='once' and author_id=$1", [
        editor.id,
      ]),
    );
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it("rejects the same key with different text", async () => {
    const key = `key-${randomUUID()}`;
    await add(editor, { p_body: "first", p_idempotency_key: key });
    const r = await add(editor, { p_body: "second", p_idempotency_key: key });
    expect(r.error?.code).toBe("23505");
  });

  it("creates exactly one comment from five concurrent submits of one key", async () => {
    const key = `key-${randomUUID()}`;
    const user = await join(wedding, "viewer", "c-burst");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => add(user, { p_body: "burst", p_idempotency_key: key })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    const n = await withSuperuser((db) =>
      db.query("select count(*) from public.comments where author_id=$1", [user.id]),
    );
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it("limits one person to 20 comments a minute", async () => {
    const user = await join(wedding, "viewer", "c-spam");
    for (let i = 0; i < 20; i++) await post(user, `n${i}`);
    expect((await add(user, { p_body: "21st" })).error?.code).toBe("54000");
  });
});

describe("editing and deleting", () => {
  it("lets only the author edit, with version checks", async () => {
    const id = await post(viewer, "draft");
    for (const other of [owner, partner, editor, outsider]) {
      const r = await other.client.rpc("edit_comment", {
        p_wedding: wedding,
        p_comment: id,
        p_expected_version: 1,
        p_body: "hijack",
      });
      expect(r.error?.code).toBe("42501");
    }
    const ok = await viewer.client.rpc("edit_comment", {
      p_wedding: wedding,
      p_comment: id,
      p_expected_version: 1,
      p_body: "final",
    });
    expect(ok.data).toBe(2);
    const stale = await viewer.client.rpc("edit_comment", {
      p_wedding: wedding,
      p_comment: id,
      p_expected_version: 1,
      p_body: "again",
    });
    expect(stale.error?.code).toBe("55000");
    const same = await viewer.client.rpc("edit_comment", {
      p_wedding: wedding,
      p_comment: id,
      p_expected_version: 2,
      p_body: "final",
    });
    expect(same.data).toBe(2);
    const bad = await viewer.client.rpc("edit_comment", {
      p_wedding: wedding,
      p_comment: id,
      p_expected_version: 2,
      p_body: " ",
    });
    expect(bad.error?.code).toBe("22023");
  });

  it("lets the author and owner/partner delete, but not editors or viewers deleting others", async () => {
    const id = await post(viewer, "mine");
    for (const other of [editor, outsider]) {
      expect(
        (await other.client.rpc("delete_comment", { p_wedding: wedding, p_comment: id })).error
          ?.code,
      ).toBe("42501");
    }
    expect(
      (await viewer.client.rpc("delete_comment", { p_wedding: wedding, p_comment: id })).error,
    ).toBeNull();
    const again = await viewer.client.rpc("delete_comment", { p_wedding: wedding, p_comment: id });
    expect(again.error?.code).toBe("42501");

    const second = await post(viewer, "moderate me");
    expect(
      (await partner.client.rpc("delete_comment", { p_wedding: wedding, p_comment: second })).error,
    ).toBeNull();
    const third = await post(editor, "also moderate");
    expect(
      (await owner.client.rpc("delete_comment", { p_wedding: wedding, p_comment: third })).error,
    ).toBeNull();
    const other = await post(owner, "owner's");
    expect(
      (await viewer.client.rpc("delete_comment", { p_wedding: wedding, p_comment: other })).error
        ?.code,
    ).toBe("42501");
  });

  it("writes audit events that name the subject kind but never the text", async () => {
    const secret = `private-words-${randomUUID()}`;
    const id = await post(viewer, secret);
    await viewer.client.rpc("edit_comment", {
      p_wedding: wedding,
      p_comment: id,
      p_expected_version: 1,
      p_body: `${secret}!`,
    });
    await partner.client.rpc("delete_comment", { p_wedding: wedding, p_comment: id });
    const rows = await withSuperuser((db) =>
      db.query(
        "select action, actor_id, safe_changes from public.audit_events where entity_id=$1 order by occurred_at, id",
        [id],
      ),
    ).catch(async () =>
      withSuperuser((db) =>
        db.query(
          "select action, actor_id, safe_changes from public.audit_events where entity_id=$1",
          [id],
        ),
      ),
    );
    expect(rows.rows.map((r) => r.action).sort()).toEqual([
      "comment.created",
      "comment.deleted",
      "comment.edited",
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain(secret);
    const del = rows.rows.find((r) => r.action === "comment.deleted");
    expect(del.actor_id).toBe(partner.id);
    expect(del.safe_changes).toMatchObject({ subject_kind: "candidate", moderated: true });
  });
});

describe("reading and isolation", () => {
  it("lists a thread for members with author flags, and denies outsiders", async () => {
    const id = await post(viewer, "listed");
    const mine = await viewer.client.rpc("list_comments", {
      p_wedding: wedding,
      p_kind: "candidate",
      p_subject: candidate,
    });
    const row = (mine.data as { id: string; is_mine: boolean; body: string }[]).find(
      (r) => r.id === id,
    );
    expect(row?.is_mine).toBe(true);
    const theirs = await owner.client.rpc("list_comments", {
      p_wedding: wedding,
      p_kind: "candidate",
      p_subject: candidate,
    });
    expect(
      (theirs.data as { id: string; is_mine: boolean }[]).find((r) => r.id === id)?.is_mine,
    ).toBe(false);
    const denied = await outsider.client.rpc("list_comments", {
      p_wedding: wedding,
      p_kind: "candidate",
      p_subject: candidate,
    });
    expect(denied.error?.code).toBe("42501");
    const recent = await outsider.client.rpc("recent_comments", { p_wedding: wedding });
    expect(recent.error?.code).toBe("42501");
  });

  it("returns recent comments with the subject title", async () => {
    await post(viewer, "recent one");
    const r = await viewer.client.rpc("recent_comments", { p_wedding: wedding, p_limit: 500 });
    const rows = r.data as { subject_title: string; body: string }[];
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.some((x) => x.body === "recent one" && x.subject_title === "Barn")).toBe(true);
  });

  it("hides rows from outsiders and denies every direct write", async () => {
    const id = await post(viewer, "rls");
    const seen = await outsider.client.from("comments").select("id").eq("id", id);
    expect(seen.data).toEqual([]);
    const own = await viewer.client.from("comments").select("id").eq("id", id);
    expect(own.data).toHaveLength(1);
    const ins = await viewer.client.from("comments").insert({
      wedding_id: wedding,
      subject_kind: "candidate",
      subject_id: candidate,
      body: "direct",
      author_id: viewer.id,
    });
    expect(ins.error).not.toBeNull();
    const upd = await viewer.client
      .from("comments")
      .update({ body: "direct" })
      .eq("id", id)
      .select();
    expect(upd.data ?? []).toEqual([]);
    const del = await viewer.client.from("comments").delete().eq("id", id).select();
    expect(del.data ?? []).toEqual([]);
    expect(await count()).toBeGreaterThan(0);
    const still = await withSuperuser((db) =>
      db.query("select body from public.comments where id=$1", [id]),
    );
    expect(still.rows[0].body).toBe("rls");
    const anonRead = await anonClient().from("comments").select("id").limit(1);
    expect(anonRead.error !== null || (anonRead.data ?? []).length === 0).toBe(true);
  });

  it("stops a removed member immediately", async () => {
    const user = await join(wedding, "viewer", "c-removed");
    await post(user, "before removal");
    await withSuperuser((db) =>
      db.query(
        "update public.memberships set status='removed' where wedding_id=$1 and user_id=$2",
        [wedding, user.id],
      ),
    );
    expect((await add(user)).error?.code).toBe("42501");
    const list = await user.client.rpc("list_comments", {
      p_wedding: wedding,
      p_kind: "candidate",
      p_subject: candidate,
    });
    expect(list.error?.code).toBe("42501");
    const seen = await user.client.from("comments").select("id");
    expect(seen.data ?? []).toEqual([]);
  });

  it("keeps a comment but shows no name when its author is gone", async () => {
    const user = await join(wedding, "viewer", "c-gone");
    const id = await post(user, "orphan");
    // Deleting an auth user is blocked by the append-only audit log, so simulate what the
    // `on delete set null` foreign key would leave behind.
    await withSuperuser((db) =>
      db.query("update public.comments set author_id = null where id=$1", [id]),
    );
    const r = await owner.client.rpc("list_comments", {
      p_wedding: wedding,
      p_kind: "candidate",
      p_subject: candidate,
    });
    const row = (r.data as { id: string; author_name: string | null; is_mine: boolean }[]).find(
      (x) => x.id === id,
    );
    expect(row?.is_mine).toBe(false);
    expect(row?.author_name).toBeNull();
  });
});
