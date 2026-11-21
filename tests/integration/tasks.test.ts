import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

type Item = {
  key: string;
  title: string;
  notes?: string | null;
  phase: string;
  offsetDays: number;
};
const ITEMS: Item[] = [
  { key: "book-venue", title: "Decide on a venue", phase: "nine-to-twelve", offsetDays: -300 },
  { key: "send-invites", title: "Send invitations", phase: "final-weeks", offsetDays: -60 },
  { key: "final-counts", title: "Final headcounts", phase: "final-weeks", offsetDays: -14 },
];

let owner: TestUser;

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  date_kind: string;
  offset_days: number | null;
  template_key: string | null;
  archived_at: string | null;
  version: number;
  assignee_user_id: string | null;
};

async function tasks(wedding: string): Promise<TaskRow[]> {
  return withSuperuser(async (db) => {
    const r = await db.query<TaskRow>(
      "select id, title, status, due_date::text, date_kind, offset_days, template_key, archived_at::text, version, assignee_user_id from public.tasks where wedding_id=$1 order by sort_order, created_at",
      [wedding],
    );
    return r.rows;
  });
}
async function byKey(wedding: string, key: string): Promise<TaskRow> {
  const t = (await tasks(wedding)).find((x) => x.template_key === key);
  if (!t) throw new Error(`no task ${key}`);
  return t;
}
async function newWedding(date: string | null = "2027-09-10", user = owner) {
  return createWedding(user, { date });
}
function generate(user: TestUser, wedding: string, items: unknown = ITEMS) {
  return user.client.rpc("generate_checklist", { p_wedding: wedding, p_items: items });
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
function setDate(wedding: string, version: number, date: string | null) {
  return owner.client.rpc("update_wedding_settings", {
    p_wedding: wedding,
    p_expected_version: version,
    p_name: "Test Wedding",
    p_timezone: "America/Chicago",
    p_base_currency: "USD",
    ...(date !== null && { p_date: date }),
  });
}
async function auditActions(wedding: string): Promise<string[]> {
  return withSuperuser(async (db) => {
    const r = await db.query<{ action: string }>(
      "select action from public.audit_events where wedding_id=$1 order by occurred_at, id",
      [wedding],
    );
    return r.rows.map((x) => x.action);
  });
}

beforeAll(async () => {
  owner = await createUser("tasks-owner");
});

describe("generate_checklist", () => {
  it("schedules relative to the wedding date using day offsets", async () => {
    const w = await newWedding("2027-09-10");
    const { data, error } = await generate(owner, w);
    expect(error).toBeNull();
    expect(data).toBe(3);
    expect((await byKey(w, "book-venue")).due_date).toBe("2026-11-14");
    expect((await byKey(w, "final-counts")).due_date).toBe("2027-08-27");
    expect((await byKey(w, "send-invites")).date_kind).toBe("relative");
  });

  it("leaves tasks unscheduled (null) when the wedding date is unknown", async () => {
    const w = await newWedding(null);
    await generate(owner, w);
    const rows = await tasks(w);
    expect(rows).toHaveLength(3);
    expect(rows.every((t) => t.due_date === null && t.offset_days !== null)).toBe(true);
  });

  it("never duplicates: repeat and concurrent generation add each task once", async () => {
    const w = await newWedding();
    const results = await Promise.all(Array.from({ length: 5 }, () => generate(owner, w)));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.reduce((n, r) => n + (r.data as number), 0)).toBe(3);
    expect(await tasks(w)).toHaveLength(3);
    const again = await generate(owner, w);
    expect(again.data).toBe(0);
  });

  it("keeps customizations and does not resurrect archived tasks", async () => {
    const w = await newWedding();
    await generate(owner, w);
    const venue = await byKey(w, "book-venue");
    const invites = await byKey(w, "send-invites");
    await owner.client.rpc("update_task", {
      p_wedding: w,
      p_task: venue.id,
      p_expected_version: venue.version,
      p_title: "Lock in the venue",
      p_due_date: "2026-12-01",
    });
    await owner.client.rpc("archive_task", {
      p_wedding: w,
      p_task: invites.id,
      p_expected_version: invites.version,
    });
    const again = await generate(owner, w);
    expect(again.data).toBe(0);
    const rows = await tasks(w);
    expect(rows).toHaveLength(3);
    expect((await byKey(w, "book-venue")).title).toBe("Lock in the venue");
    expect((await byKey(w, "send-invites")).archived_at).not.toBeNull();
  });

  it("adds only the missing items when the template grows", async () => {
    const w = await newWedding();
    await generate(owner, w, ITEMS.slice(0, 2));
    const r = await generate(owner, w, ITEMS);
    expect(r.data).toBe(1);
    expect(await tasks(w)).toHaveLength(3);
  });

  it.each([
    ["not an array", { key: "a" }],
    ["bad key", [{ key: "Bad Key", title: "x", phase: "p", offsetDays: 1 }]],
    ["empty title", [{ key: "ok", title: "  ", phase: "p", offsetDays: 1 }]],
    ["offset out of range", [{ key: "ok", title: "x", phase: "p", offsetDays: 9999 }]],
    ["fractional offset", [{ key: "ok", title: "x", phase: "p", offsetDays: 1.5 }]],
    ["string offset", [{ key: "ok", title: "x", phase: "p", offsetDays: "5" }]],
    ["overlong phase", [{ key: "ok", title: "x", phase: "p".repeat(33), offsetDays: 1 }]],
    ["one bad item among good", [...ITEMS, { key: "BAD", title: "x", phase: "p", offsetDays: 1 }]],
  ])("rejects %s and writes nothing", async (_label, items) => {
    const w = await newWedding();
    const { error } = await generate(owner, w, items);
    expect(error).not.toBeNull();
    expect(await tasks(w)).toHaveLength(0);
  });

  it("audits additions once and nothing on a no-op", async () => {
    const w = await newWedding();
    await generate(owner, w);
    await generate(owner, w);
    expect((await auditActions(w)).filter((a) => a === "tasks.checklist_generated")).toHaveLength(
      1,
    );
  });
});

describe("create_task", () => {
  it("creates a fixed manual task with unknown date as null", async () => {
    const w = await newWedding();
    const { data, error } = await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "  Call florist ",
    });
    expect(error).toBeNull();
    const [t] = await tasks(w);
    expect(t).toMatchObject({
      id: data,
      title: "Call florist",
      date_kind: "fixed",
      due_date: null,
      template_key: null,
    });
  });

  it("replays for one key (even concurrently) and rejects a changed body", async () => {
    const w = await newWedding();
    const key = randomUUID();
    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        owner.client.rpc("create_task", { p_wedding: w, p_title: "Once", p_idempotency_key: key }),
      ),
    );
    expect(new Set(calls.map((c) => c.data)).size).toBe(1);
    expect(await tasks(w)).toHaveLength(1);
    const changed = await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "Other",
      p_idempotency_key: key,
    });
    expect(changed.error?.message).toMatch(/different request/);
    expect(await tasks(w)).toHaveLength(1);
  });

  it("validates title, notes and date and writes nothing on failure", async () => {
    const w = await newWedding();
    for (const args of [
      { p_title: " " },
      { p_title: "x".repeat(161) },
      { p_title: "ok", p_notes: "n".repeat(2001) },
      { p_title: "ok", p_due_date: "1800-01-01" },
    ]) {
      const { error } = await owner.client.rpc("create_task", { p_wedding: w, ...args });
      expect(error).not.toBeNull();
    }
    expect(await tasks(w)).toHaveLength(0);
  });

  it("only assigns to active members of the same wedding", async () => {
    const w = await newWedding();
    const partner = await addMember(w, "partner", "tasks-assignee");
    const outsider = await createUser("tasks-assign-out");
    const ok = await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "Mine",
      p_assignee: partner.id,
    });
    expect(ok.error).toBeNull();
    const bad = await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "Theirs",
      p_assignee: outsider.id,
    });
    expect(bad.error).not.toBeNull();
    await withSuperuser((db) =>
      db.query(
        "update public.memberships set status='removed' where wedding_id=$1 and user_id=$2",
        [w, partner.id],
      ),
    );
    const removed = await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "Gone",
      p_assignee: partner.id,
    });
    expect(removed.error).not.toBeNull();
    expect(await tasks(w)).toHaveLength(1);
  });
});

describe("update_task and set_task_status", () => {
  async function one(w: string) {
    await generate(owner, w);
    return byKey(w, "send-invites");
  }
  const args = (w: string, t: TaskRow, over: Record<string, unknown> = {}) => ({
    p_wedding: w,
    p_task: t.id,
    p_expected_version: t.version,
    p_title: t.title,
    p_due_date: t.due_date,
    ...over,
  });

  it("editing the date of a relative task makes it fixed; other edits keep it relative", async () => {
    const w = await newWedding();
    const t = await one(w);
    const note = await owner.client.rpc("update_task", args(w, t, { p_notes: "see folder" }));
    expect(note.data).toBe(t.version + 1);
    expect((await byKey(w, "send-invites")).date_kind).toBe("relative");
    const t2 = await byKey(w, "send-invites");
    await owner.client.rpc("update_task", args(w, t2, { p_due_date: "2027-07-01" }));
    expect(await byKey(w, "send-invites")).toMatchObject({
      date_kind: "fixed",
      due_date: "2027-07-01",
    });
  });

  it("a no-op save changes no version and writes no audit", async () => {
    const w = await newWedding();
    const t = await one(w);
    const r = await owner.client.rpc("update_task", args(w, t));
    expect(r.data).toBe(t.version);
    expect((await auditActions(w)).filter((a) => a === "task.updated")).toHaveLength(0);
  });

  it("refuses a stale version without overwriting, and exactly one concurrent writer wins", async () => {
    const w = await newWedding();
    const t = await one(w);
    const results = await Promise.all(
      ["A", "B", "C"].map((n) =>
        owner.client.rpc("update_task", args(w, t, { p_title: `Title ${n}` })),
      ),
    );
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(2);
    const stale = await owner.client.rpc("update_task", args(w, t, { p_title: "Stale" }));
    expect(stale.error?.code).toBe("55000");
    expect((await byKey(w, "send-invites")).title).toMatch(/^Title [ABC]$/);
  });

  it("completes and reopens idempotently with audit", async () => {
    const w = await newWedding();
    const t = await one(w);
    const done = await owner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
      p_done: true,
    });
    expect(done.data).toBe(t.version + 1);
    const replay = await owner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
      p_done: true,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(t.version + 1);
    expect((await byKey(w, "send-invites")).status).toBe("done");
    const reopen = await owner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version + 1,
      p_done: false,
    });
    expect(reopen.error).toBeNull();
    expect((await byKey(w, "send-invites")).status).toBe("open");
    const actions = await auditActions(w);
    expect(actions.filter((a) => a === "task.completed")).toHaveLength(1);
    expect(actions.filter((a) => a === "task.reopened")).toHaveLength(1);
  });

  it("rejects a stale status change that would actually change state", async () => {
    const w = await newWedding();
    const t = await one(w);
    await owner.client.rpc("update_task", args(w, t, { p_notes: "x" }));
    const r = await owner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
      p_done: true,
    });
    expect(r.error?.code).toBe("55000");
    expect((await byKey(w, "send-invites")).status).toBe("open");
  });

  it("refuses edits to an archived task", async () => {
    const w = await newWedding();
    const t = await one(w);
    await owner.client.rpc("archive_task", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
    });
    const again = await owner.client.rpc("archive_task", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
    });
    expect(again.error).toBeNull();
    const r = await owner.client.rpc(
      "update_task",
      args(w, t, { p_title: "Zombie", p_expected_version: t.version + 1 }),
    );
    expect(r.error?.code).toBe("55000");
  });
});

describe("reschedule_relative_tasks (T13)", () => {
  async function setup() {
    const w = await newWedding("2027-09-10");
    await generate(owner, w);
    await owner.client.rpc("create_task", {
      p_wedding: w,
      p_title: "Deposit due",
      p_due_date: "2027-01-15",
    });
    const venue = await byKey(w, "book-venue");
    await owner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: venue.id,
      p_expected_version: venue.version,
      p_done: true,
    });
    const before = await tasks(w);
    const moved = await setDate(w, 1, "2027-10-01");
    expect(moved.error).toBeNull();
    return { w, before };
  }
  const approve = (rows: TaskRow[]) => rows.map((t) => ({ id: t.id, version: t.version }));

  it("changing the wedding date alone moves no task", async () => {
    const { w, before } = await setup();
    expect(await tasks(w)).toEqual(before);
  });

  it("moves approved relative tasks, leaving fixed and completed ones untouched", async () => {
    const { w } = await setup();
    const rows = await tasks(w);
    const open = rows.filter((t) => t.date_kind === "relative" && t.status === "open");
    const r = await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(open),
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(2);
    expect((await byKey(w, "send-invites")).due_date).toBe("2027-08-02");
    expect((await byKey(w, "final-counts")).due_date).toBe("2027-09-17");
    expect((await byKey(w, "book-venue")).due_date).toBe("2026-11-14"); // completed: unchanged
    expect(rows.find((t) => t.title === "Deposit due")?.due_date).toBe("2027-01-15"); // fixed: unchanged
    expect((await tasks(w)).find((t) => t.title === "Deposit due")?.due_date).toBe("2027-01-15");
    expect(await auditActions(w)).toContain("tasks.rescheduled");
  });

  it("refuses to move fixed or completed tasks even when asked, and writes nothing", async () => {
    const { w } = await setup();
    const rows = await tasks(w);
    const before = rows;
    const fixed = rows.find((t) => t.title === "Deposit due")!;
    const done = rows.find((t) => t.template_key === "book-venue")!;
    for (const bad of [fixed, done]) {
      const r = await owner.client.rpc("reschedule_relative_tasks", {
        p_wedding: w,
        p_approved: approve([rows.find((t) => t.template_key === "send-invites")!, bad]),
      });
      expect(r.error?.code).toBe("55000");
    }
    expect(await tasks(w)).toEqual(before);
  });

  it("aborts the whole batch when any task changed since the preview", async () => {
    const { w } = await setup();
    const rows = await tasks(w);
    const stale = rows.find((t) => t.template_key === "send-invites")!;
    await owner.client.rpc("update_task", {
      p_wedding: w,
      p_task: stale.id,
      p_expected_version: stale.version,
      p_title: stale.title,
      p_due_date: stale.due_date,
      p_notes: "edited",
    });
    const open = rows.filter((t) => t.date_kind === "relative" && t.status === "open");
    const r = await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(open),
    });
    expect(r.error?.code).toBe("55000");
    expect((await byKey(w, "final-counts")).due_date).toBe("2027-08-27"); // sibling not moved
  });

  it("is idempotent: re-applying after success changes nothing more", async () => {
    const { w } = await setup();
    const open = (await tasks(w)).filter((t) => t.date_kind === "relative" && t.status === "open");
    await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(open),
    });
    const fresh = (await tasks(w)).filter((t) => t.date_kind === "relative" && t.status === "open");
    const again = await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(fresh),
    });
    expect(again.data).toBe(0);
  });

  it("unschedules relative tasks when the date is cleared and re-dates them when set again", async () => {
    const w = await newWedding("2027-09-10");
    await generate(owner, w);
    await setDate(w, 1, null);
    let open = (await tasks(w)).filter((t) => t.status === "open");
    await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(open),
    });
    expect((await tasks(w)).every((t) => t.due_date === null)).toBe(true);
    await setDate(w, 2, "2028-01-01");
    open = await tasks(w);
    await owner.client.rpc("reschedule_relative_tasks", {
      p_wedding: w,
      p_approved: approve(open),
    });
    expect((await byKey(w, "final-counts")).due_date).toBe("2027-12-18");
  });

  it("rejects malformed selections", async () => {
    const w = await newWedding();
    for (const bad of [{ id: "x" }, "nope", [{ id: randomUUID(), version: 1 }]]) {
      const r = await owner.client.rpc("reschedule_relative_tasks", {
        p_wedding: w,
        p_approved: bad,
      });
      expect(r.error).not.toBeNull();
    }
  });
});

describe("authorization and tenant isolation", () => {
  it("lets any member read tasks but only owner and partner write", async () => {
    const w = await newWedding();
    await generate(owner, w);
    const t = await byKey(w, "send-invites");
    const partner = await addMember(w, "partner", "tasks-partner");
    const editor = await addMember(w, "editor", "tasks-editor");
    const viewer = await addMember(w, "viewer", "tasks-viewer");

    for (const u of [partner, editor, viewer]) {
      const { data } = await u.client.from("tasks").select("id").eq("wedding_id", w);
      expect(data).toHaveLength(3);
    }
    const attempts = (u: TestUser) => [
      u.client.rpc("generate_checklist", { p_wedding: w, p_items: ITEMS }),
      u.client.rpc("create_task", { p_wedding: w, p_title: "x" }),
      u.client.rpc("update_task", {
        p_wedding: w,
        p_task: t.id,
        p_expected_version: t.version,
        p_title: "x",
      }),
      u.client.rpc("set_task_status", {
        p_wedding: w,
        p_task: t.id,
        p_expected_version: t.version,
        p_done: true,
      }),
      u.client.rpc("archive_task", { p_wedding: w, p_task: t.id, p_expected_version: t.version }),
      u.client.rpc("reschedule_relative_tasks", { p_wedding: w, p_approved: [] }),
    ];
    for (const u of [editor, viewer]) {
      for (const r of await Promise.all(attempts(u))) expect(r.error?.code).toBe("42501");
    }
    const ok = await partner.client.rpc("set_task_status", {
      p_wedding: w,
      p_task: t.id,
      p_expected_version: t.version,
      p_done: true,
    });
    expect(ok.error).toBeNull();
    expect((await byKey(w, "send-invites")).status).toBe("done");
  });

  it("hides another wedding's tasks and denies cross-tenant writes with indistinguishable errors", async () => {
    const wa = await newWedding();
    await generate(owner, wa);
    const ta = await byKey(wa, "send-invites");
    const other = await createUser("tasks-other");
    const wb = await createWedding(other);

    expect((await other.client.from("tasks").select("id").eq("wedding_id", wa)).data).toEqual([]);
    expect((await other.client.from("tasks").select("id").eq("id", ta.id)).data).toEqual([]);

    const viaOwnWedding = await other.client.rpc("set_task_status", {
      p_wedding: wb,
      p_task: ta.id,
      p_expected_version: ta.version,
      p_done: true,
    });
    const viaForeignWedding = await other.client.rpc("set_task_status", {
      p_wedding: wa,
      p_task: ta.id,
      p_expected_version: ta.version,
      p_done: true,
    });
    const unknown = await other.client.rpc("set_task_status", {
      p_wedding: randomUUID(),
      p_task: ta.id,
      p_expected_version: 1,
      p_done: true,
    });
    for (const r of [viaOwnWedding, viaForeignWedding, unknown]) {
      expect(r.error?.code).toBe("42501");
      expect(r.error?.message).toBe("not permitted");
    }
    const create = await other.client.rpc("create_task", { p_wedding: wa, p_title: "intruder" });
    expect(create.error?.code).toBe("42501");
    expect((await byKey(wa, "send-invites")).status).toBe("open");
  });

  it("denies anonymous callers and direct table writes", async () => {
    const w = await newWedding();
    await generate(owner, w);
    const t = await byKey(w, "send-invites");
    const { anonClient } = await import("./helpers");
    const anon = anonClient();
    expect((await anon.rpc("create_task", { p_wedding: w, p_title: "x" })).error).not.toBeNull();
    expect((await anon.from("tasks").select("id")).data ?? []).toEqual([]);

    const ins = await owner.client.from("tasks").insert({ wedding_id: w, title: "direct" });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("tasks").update({ title: "direct" }).eq("id", t.id);
    expect(upd.error).not.toBeNull();
    const del = await owner.client.from("tasks").delete().eq("id", t.id);
    expect(del.error).not.toBeNull();
    expect((await byKey(w, "send-invites")).title).toBe("Send invitations");
  });
});
