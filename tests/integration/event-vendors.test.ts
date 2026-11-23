import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-07: vendors assigned to events (ADR-031 D4). The link points at the vendor, so a contract
// amendment cannot break it. The database refuses a vendor or event from another wedding, a venue,
// and a new link to a vendor that is archived or passed; an existing link to such a vendor stays.

let owner: TestUser;
let partner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let wedding: string;
let other: TestUser;
let otherWedding: string;
let reception: string;
let ceremony: string;
let brunch: string;
let lens: string; // photographer
let notes: string; // music
let barn: string; // venue
let foreignVendor: string;
let foreignEvent: string;
let category: string;
let item: string;

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as NonNullable<T>;
}
async function addMember(w: string, role: "partner" | "editor" | "viewer", label: string) {
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
const vendor = async (user: TestUser, w: string, name: string, category = "photographer") =>
  (await ok(
    user.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "vendor",
      p_category: category,
      p_name: name,
    }),
  )) as string;
const event = async (user: TestUser, w: string, name: string, kind = "reception") =>
  (await ok(user.client.rpc("create_event", { p_wedding: w, p_event: { name, kind } }))) as string;

const fromVendor = (
  user: TestUser,
  w: string,
  v: string,
  add: string[] = [],
  remove: string[] = [],
) =>
  user.client.rpc("set_vendor_events", {
    p_wedding: w,
    p_candidate: v,
    p_add: add,
    p_remove: remove,
  });
const fromEvent = (
  user: TestUser,
  w: string,
  e: string,
  add: string[] = [],
  remove: string[] = [],
) =>
  user.client.rpc("set_event_vendors", { p_wedding: w, p_event: e, p_add: add, p_remove: remove });

const links = (w: string) =>
  withSuperuser(async (db) => {
    const r = await db.query<{ event_id: string; candidate_id: string }>(
      "select event_id, candidate_id from public.event_vendors where wedding_id=$1 order by created_at, event_id",
      [w],
    );
    return r.rows;
  });
const linkCount = async (w: string) => (await links(w)).length;
const audits = (entity: string) =>
  withSuperuser(async (db) => {
    const r = await db.query(
      "select safe_changes from public.audit_events where entity_id=$1 and action='event_vendors.changed' order by occurred_at, id",
      [entity],
    );
    return r.rows.map((x) => x.safe_changes as Record<string, unknown>);
  });
const setStage = (id: string, stage: string) =>
  withSuperuser((db) => db.query("update public.candidates set stage=$2 where id=$1", [id, stage]));
const archive = (id: string) =>
  withSuperuser((db) =>
    db.query("update public.candidates set archived_at=now() where id=$1", [id]),
  );
const clearLinks = (w: string) =>
  withSuperuser((db) => db.query("delete from public.event_vendors where wedding_id=$1", [w]));

beforeAll(async () => {
  owner = await createUser("ev-owner");
  wedding = await createWedding(owner, { name: "Vendor Wedding", guests: 100 });
  partner = await addMember(wedding, "partner", "ev-partner");
  editor = await addMember(wedding, "editor", "ev-editor");
  viewer = await addMember(wedding, "viewer", "ev-viewer");
  stranger = await createUser("ev-stranger");
  other = await createUser("ev-other");
  otherWedding = await createWedding(other, { name: "Elsewhere" });
  reception = await event(owner, wedding, "Reception");
  ceremony = await event(owner, wedding, "Ceremony", "ceremony");
  brunch = await event(owner, wedding, "Brunch", "other");
  lens = await vendor(owner, wedding, "Lens Co");
  notes = await vendor(owner, wedding, "Good Notes", "music");
  barn = (await ok(
    owner.client.rpc("create_candidate", {
      p_wedding: wedding,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Old Barn",
    }),
  )) as string;
  foreignVendor = await vendor(other, otherWedding, "Foreign Photo");
  foreignEvent = await event(other, otherWedding, "Foreign Party");
  category = (await ok(
    owner.client.rpc("create_budget_category", { p_wedding: wedding, p_name: "Photo" }),
  )) as string;
  item = (await ok(
    owner.client.rpc("create_budget_item", {
      p_wedding: wedding,
      p_category: category,
      p_name: "Photo package",
      p_amount_minor: 500_000,
    }),
  )) as string;
});

describe("assigning vendors to events", () => {
  it("links from the vendor side and reads back through RLS", async () => {
    const r = await ok(fromVendor(owner, wedding, lens, [reception, ceremony]));
    expect(r).toEqual({ added: 2, removed: 0 });
    const seen = await ok(
      viewer.client
        .from("event_vendors")
        .select("event_id, candidate_id")
        .eq("wedding_id", wedding),
    );
    expect(seen.map((x) => x.event_id).sort()).toEqual([ceremony, reception].sort());
    expect(seen.every((x) => x.candidate_id === lens)).toBe(true);
  });

  it("links from the event side and removes", async () => {
    await clearLinks(wedding);
    expect(await ok(fromEvent(owner, wedding, reception, [lens, notes]))).toEqual({
      added: 2,
      removed: 0,
    });
    expect(await ok(fromEvent(owner, wedding, reception, [], [notes]))).toEqual({
      added: 0,
      removed: 1,
    });
    expect((await links(wedding)).map((l) => l.candidate_id)).toEqual([lens]);
  });

  it("keeps one row per pair: adding again changes nothing and writes no audit entry", async () => {
    await clearLinks(wedding);
    await ok(fromVendor(owner, wedding, lens, [reception]));
    const before = (await audits(lens)).length;
    expect(await ok(fromVendor(owner, wedding, lens, [reception, reception]))).toEqual({
      added: 0,
      removed: 0,
    });
    expect(await ok(fromEvent(owner, wedding, reception, [lens]))).toEqual({
      added: 0,
      removed: 0,
    });
    expect(await linkCount(wedding)).toBe(1);
    expect((await audits(lens)).length).toBe(before);
  });

  it("removing a link that is not there is a no-op", async () => {
    await clearLinks(wedding);
    expect(await ok(fromVendor(owner, wedding, lens, [], [reception]))).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("audits ids and counts only", async () => {
    await clearLinks(wedding);
    await ok(fromVendor(owner, wedding, notes, [reception, brunch]));
    const a = await audits(notes);
    expect(a.at(-1)).toEqual({ added: 2, removed: 0 });
    expect(JSON.stringify(a)).not.toContain("Good Notes");
  });

  it("two people adding the same pair at once leave one row and no error", async () => {
    await clearLinks(wedding);
    const results = await Promise.all([
      fromVendor(owner, wedding, lens, [brunch]),
      fromEvent(partner, wedding, brunch, [lens]),
      fromVendor(owner, wedding, lens, [brunch]),
    ]);
    for (const r of results) expect(r.error).toBeNull();
    expect(await linkCount(wedding)).toBe(1);
  });

  it("changes to different links do not undo each other", async () => {
    await clearLinks(wedding);
    await ok(fromVendor(owner, wedding, lens, [reception]));
    // Two people started from "reception only"; one adds ceremony, one adds brunch.
    await Promise.all([
      ok(fromVendor(owner, wedding, lens, [ceremony])),
      ok(fromVendor(partner, wedding, lens, [brunch])),
    ]);
    expect((await links(wedding)).map((l) => l.event_id).sort()).toEqual(
      [reception, ceremony, brunch].sort(),
    );
  });
});

describe("what is refused", () => {
  it("refuses an event or vendor from another wedding and writes nothing", async () => {
    await clearLinks(wedding);
    expect((await fromVendor(owner, wedding, lens, [foreignEvent])).error?.code).toBe("42501");
    expect((await fromVendor(owner, wedding, foreignVendor, [reception])).error?.code).toBe(
      "42501",
    );
    expect((await fromEvent(owner, wedding, foreignEvent, [lens])).error?.code).toBe("42501");
    expect((await fromEvent(owner, wedding, reception, [foreignVendor])).error?.code).toBe("42501");
    // Using the other wedding's id does not help either.
    expect((await fromVendor(owner, otherWedding, foreignVendor, [foreignEvent])).error?.code).toBe(
      "42501",
    );
    expect(await linkCount(wedding)).toBe(0);
    expect(await linkCount(otherWedding)).toBe(0);
  });

  it("a mixed list with one foreign event writes none of it", async () => {
    await clearLinks(wedding);
    const r = await fromVendor(owner, wedding, lens, [reception, foreignEvent]);
    expect(r.error?.code).toBe("42501");
    expect(await linkCount(wedding)).toBe(0);
  });

  it("a foreign id in the remove list matches nothing", async () => {
    await clearLinks(wedding);
    await ok(fromVendor(owner, wedding, lens, [reception]));
    expect(await ok(fromVendor(owner, wedding, lens, [], [foreignEvent]))).toEqual({
      added: 0,
      removed: 0,
    });
    expect(await linkCount(wedding)).toBe(1);
  });

  it("refuses a venue: it is placed with the event's location instead", async () => {
    expect((await fromVendor(owner, wedding, barn, [reception])).error?.code).toBe("42501");
    expect((await fromEvent(owner, wedding, reception, [barn])).error?.code).toBe("42501");
  });

  it("refuses an add and a remove of the same id, and more than 50 ids", async () => {
    expect((await fromVendor(owner, wedding, lens, [reception], [reception])).error?.code).toBe(
      "22023",
    );
    const many = Array.from({ length: 51 }, () => randomUUID());
    expect((await fromVendor(owner, wedding, lens, many)).error?.code).toBe("22023");
  });

  it("refuses an unknown event or vendor", async () => {
    expect((await fromVendor(owner, wedding, lens, [randomUUID()])).error?.code).toBe("42501");
    expect((await fromVendor(owner, wedding, randomUUID(), [reception])).error?.code).toBe("42501");
  });

  it("the database itself refuses a link across weddings, even for a superuser", async () => {
    const bad = withSuperuser((db) =>
      db.query(
        "insert into public.event_vendors (event_id, candidate_id, wedding_id) values ($1,$2,$3)",
        [reception, foreignVendor, wedding],
      ),
    );
    await expect(bad).rejects.toThrow();
    const badKind = withSuperuser((db) =>
      db.query(
        "insert into public.event_vendors (event_id, candidate_id, wedding_id) values ($1,$2,$3)",
        [reception, barn, wedding],
      ),
    );
    await expect(badKind).rejects.toThrow();
  });
});

describe("who may change links", () => {
  it("allows owner and partner; refuses editor, viewer and a stranger", async () => {
    await clearLinks(wedding);
    expect((await fromVendor(partner, wedding, lens, [reception])).error).toBeNull();
    expect((await fromEvent(owner, wedding, ceremony, [lens])).error).toBeNull();
    for (const u of [editor, viewer, stranger]) {
      expect((await fromVendor(u, wedding, lens, [brunch])).error?.code, "vendor side").toBe(
        "42501",
      );
      expect((await fromEvent(u, wedding, brunch, [lens])).error?.code, "event side").toBe("42501");
      expect((await fromVendor(u, wedding, lens, [], [reception])).error?.code, "remove").toBe(
        "42501",
      );
    }
    expect(await linkCount(wedding)).toBe(2);
  });

  it("a stranger reads nothing, and no member can write the table directly", async () => {
    const seen = await ok(
      stranger.client.from("event_vendors").select("event_id").eq("wedding_id", wedding),
    );
    expect(seen).toEqual([]);
    for (const u of [owner, partner, editor, viewer]) {
      const ins = await u.client
        .from("event_vendors")
        .insert({ event_id: brunch, candidate_id: lens, wedding_id: wedding });
      expect(ins.error, "insert").not.toBeNull();
      // A delete is hidden by RLS (no error, no rows); the count check below proves it.
      await u.client.from("event_vendors").delete().eq("wedding_id", wedding);
    }
    expect(await linkCount(wedding)).toBe(2);
  });

  it("an unauthenticated caller is refused", async () => {
    const r = await anonClient().rpc("set_vendor_events", {
      p_wedding: wedding,
      p_candidate: lens,
      p_add: [brunch],
      p_remove: [],
    });
    expect(r.error).not.toBeNull();
    expect(await linkCount(wedding)).toBe(2);
  });
});

describe("stale vendors", () => {
  it("a passed vendor can't be newly linked, but an existing link stays and can be removed", async () => {
    await clearLinks(wedding);
    const v = await vendor(owner, wedding, "Cancelled Cakes", "bakery");
    await ok(fromVendor(owner, wedding, v, [reception]));
    await setStage(v, "declined");
    expect((await fromVendor(owner, wedding, v, [ceremony])).error?.code).toBe("22023");
    expect((await fromEvent(owner, wedding, ceremony, [v])).error?.code).toBe("22023");
    expect((await links(wedding)).map((l) => l.event_id)).toEqual([reception]);
    expect(await ok(fromVendor(owner, wedding, v, [], [reception]))).toEqual({
      added: 0,
      removed: 1,
    });
  });

  it("an archived vendor keeps its links; adding is refused, removing works", async () => {
    await clearLinks(wedding);
    const v = await vendor(owner, wedding, "Old Florist", "florist");
    await ok(fromVendor(owner, wedding, v, [reception, ceremony]));
    await archive(v);
    expect(await linkCount(wedding)).toBe(2);
    expect((await fromVendor(owner, wedding, v, [brunch])).error?.code).toBe("22023");
    expect(await ok(fromEvent(owner, wedding, ceremony, [], [v]))).toEqual({
      added: 0,
      removed: 1,
    });
  });

  it("a booked or shortlisted vendor can be linked", async () => {
    await clearLinks(wedding);
    const v = await vendor(owner, wedding, "Booked Band", "music");
    await setStage(v, "booked");
    expect((await fromVendor(owner, wedding, v, [reception])).error).toBeNull();
    const w = await vendor(owner, wedding, "Shortlisted DJ", "music");
    await setStage(w, "considering");
    expect((await fromVendor(owner, wedding, w, [reception])).error).toBeNull();
  });
});

describe("contract amendments", () => {
  it("leave the link alone, because it points at the vendor", async () => {
    await clearLinks(wedding);
    const v = await vendor(owner, wedding, "Amended Photo");
    await ok(fromVendor(owner, wedding, v, [reception, ceremony]));
    const { data: c1, error: e1 } = await owner.client.rpc("book_commitment", {
      p_wedding: wedding,
      p_candidate: v,
      p_expected_candidate_version: 1,
      p_title: "Photo contract",
      p_amount_minor: 500_000,
      p_allocations: [{ itemId: item, amountMinor: 500_000 }],
      p_installments: [{ dueOn: "2027-05-08", amountMinor: 500_000 }],
      p_confirmed: true,
    });
    expect(e1).toBeNull();
    const before = await links(wedding);
    const { data: c2, error: e2 } = await owner.client.rpc("amend_commitment", {
      p_wedding: wedding,
      p_commitment: c1 as string,
      p_expected_version: 1,
      p_title: "Photo contract v2",
      p_amount_minor: 600_000,
      p_allocations: [{ itemId: item, amountMinor: 600_000 }],
      p_installments: [{ dueOn: "2027-06-01", amountMinor: 600_000 }],
      p_confirmed: true,
    });
    expect(e2).toBeNull();
    expect(c2).not.toBe(c1);
    expect(await links(wedding)).toEqual(before);
    expect((await links(wedding)).every((l) => l.candidate_id === v)).toBe(true);
    // The vendor now has a superseded and an active commitment, and still the same two events.
    const rows = await withSuperuser(async (db) =>
      (
        await db.query<{ status: string }>(
          "select status from public.commitments where candidate_id=$1 order by created_at",
          [v],
        )
      ).rows.map((r) => r.status),
    );
    expect(rows).toEqual(["superseded", "active"]);
  });
});

describe("deleting an event", () => {
  it("takes its links with it and leaves the vendor", async () => {
    await clearLinks(wedding);
    const e = await event(owner, wedding, "Welcome drinks", "other");
    await ok(fromEvent(owner, wedding, e, [lens]));
    expect(await linkCount(wedding)).toBe(1);
    await withSuperuser((db) => db.query("delete from public.events where id=$1", [e]));
    expect(await linkCount(wedding)).toBe(0);
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select id from public.candidates where id=$1", [lens])).rowCount,
    );
    expect(v).toBe(1);
  });
});
