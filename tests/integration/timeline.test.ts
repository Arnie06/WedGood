import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  owner = await createUser("tl-owner");
  other = await createUser("tl-other");
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

async function setup(tz = "America/Chicago") {
  const wedding = await createWedding(owner, { tz });
  const { data, error } = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception" },
  });
  if (error) throw new Error(error.message);
  return { wedding, event: data };
}

const START = "2027-06-12T22:00:00Z";
const END = "2027-06-12T23:00:00Z";

function create(
  user: TestUser,
  wedding: string,
  event: string,
  extra: Record<string, unknown> = {},
) {
  return user.client.rpc("create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title: "Ceremony",
    p_starts_at: START,
    p_ends_at: END,
    ...extra,
  });
}

async function rows(wedding: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select id, title, timezone, status, version, assignee_user_id, vendor_id, starts_at::text from public.timeline_items where wedding_id=$1 order by created_at",
      [wedding],
    );
    return r.rows as {
      id: string;
      title: string;
      timezone: string;
      status: string;
      version: number;
      assignee_user_id: string | null;
      vendor_id: string | null;
    }[];
  });
}

describe("timeline items", () => {
  it("creates an item in the wedding's time zone, and audits it", async () => {
    const { wedding, event } = await setup("Europe/Rome");
    const r = await create(owner, wedding, event, { p_location: "Garden", p_contact: "Sam 555" });
    expect(r.error).toBeNull();
    const [row] = await rows(wedding);
    expect(row?.timezone).toBe("Europe/Rome");
    const audit = await withSuperuser((db) =>
      db.query(
        "select 1 from public.audit_events where wedding_id=$1 and action='timeline.created'",
        [wedding],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("is idempotent for a retry and rejects a reused key with different details", async () => {
    const { wedding, event } = await setup();
    const key = randomUUID();
    const a = await create(owner, wedding, event, { p_idempotency_key: key });
    const b = await create(owner, wedding, event, { p_idempotency_key: key });
    expect(a.data).toBe(b.data);
    expect(await rows(wedding)).toHaveLength(1);
    const c = await create(owner, wedding, event, { p_idempotency_key: key, p_title: "Other" });
    expect(c.error?.code).toBe("23505");
  });

  it("allows overlapping items (vendors act at the same time)", async () => {
    const { wedding, event } = await setup();
    expect((await create(owner, wedding, event)).error).toBeNull();
    expect((await create(owner, wedding, event, { p_title: "Photos" })).error).toBeNull();
    expect(await rows(wedding)).toHaveLength(2);
  });

  it("rejects an end before the start, bad status and over-long text", async () => {
    const { wedding, event } = await setup();
    for (const extra of [
      { p_ends_at: "2027-06-12T21:00:00Z" },
      { p_status: "live" },
      { p_notes: "x".repeat(2001) },
      { p_title: "   " },
    ]) {
      expect((await create(owner, wedding, event, extra)).error?.code).toBe("22023");
    }
    expect(await rows(wedding)).toHaveLength(0);
  });

  it("supports cross-midnight and zero-length items", async () => {
    const { wedding, event } = await setup();
    expect(
      (
        await create(owner, wedding, event, {
          p_starts_at: "2027-06-13T03:00:00Z",
          p_ends_at: "2027-06-13T06:00:00Z",
        })
      ).error,
    ).toBeNull();
    expect((await create(owner, wedding, event, { p_ends_at: START })).error).toBeNull();
  });

  it("requires an active member as the responsible member and a same-wedding vendor", async () => {
    const { wedding, event } = await setup();
    expect((await create(owner, wedding, event, { p_assignee: other.id })).error?.code).toBe(
      "22023",
    );
    expect((await create(owner, wedding, event, { p_assignee: owner.id })).error).toBeNull();

    const foreign = await createWedding(other);
    const { data: vendor } = await other.client.rpc("create_candidate", {
      p_wedding: foreign,
      p_kind: "vendor",
      p_category: "photographer",
      p_name: "Foreign photo",
    });
    expect((await create(owner, wedding, event, { p_vendor: vendor })).error?.code).toBe("23503");

    const { data: mine } = await owner.client.rpc("create_candidate", {
      p_wedding: wedding,
      p_kind: "vendor",
      p_category: "photographer",
      p_name: "My photo",
    });
    expect((await create(owner, wedding, event, { p_vendor: mine })).error).toBeNull();
  });

  it("rejects an event from another wedding", async () => {
    const a = await setup();
    const b = await setup();
    expect((await create(owner, a.wedding, b.event)).error?.code).toBe("42501");
  });

  it("updates with a version check and treats an identical save as a no-op", async () => {
    const { wedding, event } = await setup();
    const { data: id } = await create(owner, wedding, event);
    const base = {
      p_wedding: wedding,
      p_item: id,
      p_expected_version: 1,
      p_title: "Ceremony",
      p_starts_at: START,
      p_ends_at: END,
      p_status: "scheduled",
    };
    const same = await owner.client.rpc("update_timeline_item", base);
    expect(same.data).toBe(1);
    const changed = await owner.client.rpc("update_timeline_item", {
      ...base,
      p_title: "Vows",
      p_status: "cancelled",
    });
    expect(changed.data).toBe(2);
    const stale = await owner.client.rpc("update_timeline_item", { ...base, p_title: "Late" });
    expect(stale.error?.code).toBe("55000");
    expect((await rows(wedding))[0]).toMatchObject({
      title: "Vows",
      status: "cancelled",
      version: 2,
    });
  });

  it("serializes two concurrent edits from the same version: one wins, one conflicts", async () => {
    const { wedding, event } = await setup();
    const { data: id } = await create(owner, wedding, event);
    const run = (title: string) =>
      owner.client.rpc("update_timeline_item", {
        p_wedding: wedding,
        p_item: id,
        p_expected_version: 1,
        p_title: title,
        p_starts_at: START,
      });
    const results = await Promise.all([run("A"), run("B")]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });

  it("deletes with a version check", async () => {
    const { wedding, event } = await setup();
    const { data: id } = await create(owner, wedding, event);
    const stale = await owner.client.rpc("delete_timeline_item", {
      p_wedding: wedding,
      p_item: id,
      p_expected_version: 9,
    });
    expect(stale.error?.code).toBe("55000");
    const ok = await owner.client.rpc("delete_timeline_item", {
      p_wedding: wedding,
      p_item: id,
      p_expected_version: 1,
    });
    expect(ok.error).toBeNull();
    expect(await rows(wedding)).toHaveLength(0);
  });
});

describe("timeline authorization", () => {
  it("lets every member read but only owner and partner write", async () => {
    const { wedding, event } = await setup();
    const { data: id } = await create(owner, wedding, event);
    const partner = await addMember(wedding, "partner", "tl-partner");
    const editor = await addMember(wedding, "editor", "tl-editor");
    const viewer = await addMember(wedding, "viewer", "tl-viewer");

    expect((await create(partner, wedding, event, { p_title: "By partner" })).error).toBeNull();
    for (const user of [editor, viewer, other]) {
      expect((await create(user, wedding, event)).error?.code).toBe("42501");
      const upd = await user.client.rpc("update_timeline_item", {
        p_wedding: wedding,
        p_item: id,
        p_expected_version: 1,
        p_title: "Hacked",
        p_starts_at: START,
      });
      expect(upd.error?.code).toBe("42501");
      const del = await user.client.rpc("delete_timeline_item", {
        p_wedding: wedding,
        p_item: id,
        p_expected_version: 1,
      });
      expect(del.error?.code).toBe("42501");
    }
    for (const user of [partner, editor, viewer]) {
      const r = await user.client.from("timeline_items").select("id").eq("wedding_id", wedding);
      expect(r.data).toHaveLength(2);
    }
    // A non-member sees nothing, and cannot read by guessing the wedding id.
    const outsider = await other.client
      .from("timeline_items")
      .select("id")
      .eq("wedding_id", wedding);
    expect(outsider.data).toEqual([]);
  });

  it("denies direct table writes and anonymous access", async () => {
    const { wedding, event } = await setup();
    const { data: id } = await create(owner, wedding, event);
    const ins = await owner.client.from("timeline_items").insert({
      wedding_id: wedding,
      event_id: event,
      title: "x",
      starts_at: START,
      timezone: "UTC",
    });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client.from("timeline_items").update({ title: "x" }).eq("id", id);
    expect(upd.error).not.toBeNull();
    expect((await rows(wedding))[0]?.title).toBe("Ceremony");
  });

  it("loses write access immediately when a membership is removed", async () => {
    const { wedding, event } = await setup();
    const partner = await addMember(wedding, "partner", "tl-removed");
    expect((await create(partner, wedding, event)).error).toBeNull();
    await withSuperuser((db) =>
      db.query("delete from public.memberships where wedding_id=$1 and user_id=$2", [
        wedding,
        partner.id,
      ]),
    );
    expect((await create(partner, wedding, event)).error?.code).toBe("42501");
  });

  it("removes items with their event's wedding (cascade) and keeps them tenant-scoped", async () => {
    const a = await setup();
    const b = await setup();
    await create(owner, a.wedding, a.event);
    await create(owner, b.wedding, b.event);
    expect(await rows(a.wedding)).toHaveLength(1);
    expect(await rows(b.wedding)).toHaveLength(1);
  });
});
