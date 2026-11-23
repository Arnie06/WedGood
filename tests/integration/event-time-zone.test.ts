import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-12: an event may have its own IANA zone; null follows the wedding. Agenda items are always
// read in their event's effective zone, and changing a zone never moves an instant.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("tz-owner");
  stranger = await createUser("tz-stranger");
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

async function setup(weddingZone = "America/Chicago", eventExtra: Record<string, unknown> = {}) {
  const wedding = await createWedding(owner, { tz: weddingZone });
  const { data, error } = await owner.client.rpc("create_event", {
    p_wedding: wedding,
    p_event: { name: "Reception", kind: "reception", ...eventExtra },
  });
  if (error) throw new Error(error.message);
  return { wedding, event: data as string };
}

const START = "2027-06-12T22:00:00Z";
const END = "2027-06-12T23:00:00Z";

function addItem(wedding: string, event: string, extra: Record<string, unknown> = {}) {
  return owner.client.rpc("create_timeline_item", {
    p_wedding: wedding,
    p_event: event,
    p_title: "Toasts",
    p_starts_at: START,
    p_ends_at: END,
    ...extra,
  });
}

function updateEvent(
  wedding: string,
  event: string,
  version: number,
  payload: Record<string, unknown>,
  user: TestUser = owner,
) {
  return user.client.rpc("update_event", {
    p_wedding: wedding,
    p_event_id: event,
    p_expected_version: version,
    p_event: { name: "Reception", kind: "reception", ...payload },
  });
}

async function items(wedding: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select id, timezone, version, starts_at::text as starts, ends_at::text as ends from public.timeline_items where wedding_id=$1 order by created_at",
      [wedding],
    );
    return r.rows as {
      id: string;
      timezone: string;
      version: number;
      starts: string;
      ends: string | null;
    }[];
  });
}

async function eventRow(event: string) {
  return withSuperuser(async (db) => {
    const r = await db.query("select time_zone, version from public.events where id=$1", [event]);
    return r.rows[0] as { time_zone: string | null; version: number };
  });
}

async function audits(event: string) {
  return withSuperuser(async (db) => {
    const r = await db.query(
      "select action, safe_changes from public.audit_events where entity_id=$1 and entity_type='event' order by occurred_at",
      [event],
    );
    return r.rows as { action: string; safe_changes: Record<string, unknown> }[];
  });
}

describe("event time zone: storing and validating", () => {
  it("defaults to following the wedding", async () => {
    const { wedding, event } = await setup("Europe/Rome");
    expect((await eventRow(event)).time_zone).toBeNull();
    const { data, error } = await owner.client.rpc("list_event_labels", { p_wedding: wedding });
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ time_zone: null, effective_time_zone: "Europe/Rome" });
  });

  it("stores an event's own zone on create and reports both zones", async () => {
    const { wedding, event } = await setup("America/Chicago", { timeZone: "Europe/Rome" });
    expect((await eventRow(event)).time_zone).toBe("Europe/Rome");
    const { data } = await owner.client.rpc("list_event_labels", { p_wedding: wedding });
    expect(data?.[0]).toMatchObject({
      time_zone: "Europe/Rome",
      effective_time_zone: "Europe/Rome",
    });
  });

  it("treats blank and JSON null as follow-the-wedding", async () => {
    const a = await setup("America/Chicago", { timeZone: "" });
    expect((await eventRow(a.event)).time_zone).toBeNull();
    const b = await setup("America/Chicago", { timeZone: null });
    expect((await eventRow(b.event)).time_zone).toBeNull();
  });

  it("refuses an unknown zone, a wrong type and an overlong name, writing nothing", async () => {
    const wedding = await createWedding(owner);
    for (const timeZone of ["Mars/Olympus", "america/chicago", 5, "x".repeat(65)]) {
      const r = await owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name: `E ${String(timeZone).slice(0, 8)}`, timeZone },
      });
      expect(r.error?.code).toBe("22023");
    }
    const count = await withSuperuser((db) =>
      db.query("select count(*)::int as n from public.events where wedding_id=$1", [wedding]),
    );
    expect(count.rows[0].n).toBe(0);

    const own = await setup();
    const bad2 = await updateEvent(own.wedding, own.event, 1, { timeZone: "Mars/Olympus" });
    expect(bad2.error?.code).toBe("22023");
    expect((await eventRow(own.event)).version).toBe(1);
  });

  it("is also refused by the database for any writer, superuser included", async () => {
    const { event } = await setup();
    await expect(
      withSuperuser((db) =>
        db.query("update public.events set time_zone='Mars/Olympus' where id=$1", [event]),
      ),
    ).rejects.toThrow(/unknown time zone/);
    await expect(
      withSuperuser((db) => db.query("update public.events set time_zone='' where id=$1", [event])),
    ).rejects.toThrow();
  });
});

describe("event time zone: update_event", () => {
  it("sets, changes and clears the zone, audits from and to, and bumps the version", async () => {
    const { wedding, event } = await setup("America/Chicago");
    expect((await updateEvent(wedding, event, 1, { timeZone: "Europe/Rome" })).error).toBeNull();
    expect(await eventRow(event)).toEqual({ time_zone: "Europe/Rome", version: 2 });
    expect((await updateEvent(wedding, event, 2, { timeZone: "Asia/Tokyo" })).error).toBeNull();
    expect((await updateEvent(wedding, event, 3, { timeZone: "" })).error).toBeNull();
    expect(await eventRow(event)).toEqual({ time_zone: null, version: 4 });
    const a = (await audits(event)).filter((x) => x.action === "event.updated");
    expect(a.map((x) => x.safe_changes.timeZone)).toEqual([
      { from: null, to: "Europe/Rome" },
      { from: "Europe/Rome", to: "Asia/Tokyo" },
      { from: "Asia/Tokyo", to: null },
    ]);
    expect(a.every((x) => (x.safe_changes.changed as string[]).includes("timeZone"))).toBe(true);
  });

  it("keeps the stored zone when the key is absent, and a same-zone save changes nothing", async () => {
    const { wedding, event } = await setup("America/Chicago", { timeZone: "Europe/Rome" });
    const renamed = await updateEvent(wedding, event, 1, { name: "Dinner" });
    expect(renamed.error).toBeNull();
    expect(await eventRow(event)).toEqual({ time_zone: "Europe/Rome", version: 2 });
    const same = await updateEvent(wedding, event, 2, { name: "Dinner", timeZone: "Europe/Rome" });
    expect(same.error).toBeNull();
    expect((await eventRow(event)).version).toBe(2);
    const before = (await audits(event)).length;
    await updateEvent(wedding, event, 2, { name: "Dinner", timeZone: "Europe/Rome" });
    expect((await audits(event)).length).toBe(before);
  });

  it("refuses a stale version without changing the zone", async () => {
    const { wedding, event } = await setup();
    await updateEvent(wedding, event, 1, { timeZone: "Europe/Rome" });
    const stale = await updateEvent(wedding, event, 1, { timeZone: "Asia/Tokyo" });
    expect(stale.error?.code).toBe("55000");
    expect((await eventRow(event)).time_zone).toBe("Europe/Rome");
  });

  it("is limited to guest managers; a viewer or stranger cannot change it", async () => {
    const { wedding, event } = await setup();
    const viewer = await addMember(wedding, "viewer", "tz-viewer");
    const r1 = await updateEvent(wedding, event, 1, { timeZone: "Asia/Tokyo" }, viewer);
    expect(r1.error?.code).toBe("42501");
    const r2 = await updateEvent(wedding, event, 1, { timeZone: "Asia/Tokyo" }, stranger);
    expect(r2.error?.code).toBe("42501");
    expect((await eventRow(event)).time_zone).toBeNull();
    // Clients have no direct write on events; the update matches nothing or is refused.
    await owner.client.from("events").update({ time_zone: "Asia/Tokyo" }).eq("id", event);
    expect((await eventRow(event)).time_zone).toBeNull();
  });
});

describe("event time zone: agenda items follow their event", () => {
  it("labels a new item with the event's own zone, else the wedding's", async () => {
    const own = await setup("America/Chicago", { timeZone: "Asia/Tokyo" });
    expect((await addItem(own.wedding, own.event)).error).toBeNull();
    expect((await items(own.wedding))[0]?.timezone).toBe("Asia/Tokyo");
    const follow = await setup("Europe/Rome");
    expect((await addItem(follow.wedding, follow.event)).error).toBeNull();
    expect((await items(follow.wedding))[0]?.timezone).toBe("Europe/Rome");
  });

  it("ignores a zone supplied by an insert that bypasses the RPC", async () => {
    const { wedding, event } = await setup("America/Chicago", { timeZone: "Asia/Tokyo" });
    await withSuperuser((db) =>
      db.query(
        "insert into public.timeline_items (wedding_id, event_id, title, starts_at, timezone) values ($1,$2,'Raw',$3,'UTC')",
        [wedding, event, START],
      ),
    );
    expect((await items(wedding))[0]?.timezone).toBe("Asia/Tokyo");
  });

  it("re-labels items when the event's zone changes, without moving a single instant", async () => {
    const { wedding, event } = await setup("America/Chicago");
    await addItem(wedding, event);
    await addItem(wedding, event, { p_title: "Dance", p_ends_at: null });
    const before = await items(wedding);
    expect(before.map((i) => i.timezone)).toEqual(["America/Chicago", "America/Chicago"]);

    expect((await updateEvent(wedding, event, 1, { timeZone: "Europe/Rome" })).error).toBeNull();
    const after = await items(wedding);
    expect(after.map((i) => i.timezone)).toEqual(["Europe/Rome", "Europe/Rome"]);
    expect(after.map((i) => [i.starts, i.ends])).toEqual(before.map((i) => [i.starts, i.ends]));
    expect(after.map((i) => i.version)).toEqual(before.map((i) => i.version + 1));

    // Dropping the zone returns to the wedding's, still the same moments.
    expect((await updateEvent(wedding, event, 2, { timeZone: "" })).error).toBeNull();
    const back = await items(wedding);
    expect(back.map((i) => i.timezone)).toEqual(["America/Chicago", "America/Chicago"]);
    expect(back.map((i) => i.starts)).toEqual(before.map((i) => i.starts));
  });

  it("leaves items alone when an event save does not change the zone", async () => {
    const { wedding, event } = await setup("America/Chicago");
    await addItem(wedding, event);
    const before = await items(wedding);
    await updateEvent(wedding, event, 1, { name: "Dinner" });
    expect(await items(wedding)).toEqual(before);
  });

  it("only re-labels the changed event's items, in its own wedding", async () => {
    const a = await setup("America/Chicago");
    const other = await owner.client.rpc("create_event", {
      p_wedding: a.wedding,
      p_event: { name: "Brunch", kind: "brunch" },
    });
    const brunch = other.data as string;
    await addItem(a.wedding, a.event);
    await addItem(a.wedding, brunch);
    const elsewhere = await setup("America/Chicago");
    await addItem(elsewhere.wedding, elsewhere.event);

    await updateEvent(a.wedding, a.event, 1, { timeZone: "Asia/Tokyo" });
    const rows = await withSuperuser(async (db) => {
      const r = await db.query(
        "select e.name, i.timezone from public.timeline_items i join public.events e on e.id=i.event_id where i.wedding_id = any($1) order by i.wedding_id, e.name",
        [[a.wedding, elsewhere.wedding]],
      );
      return r.rows.map((x) => `${x.name}:${x.timezone}`).sort();
    });
    expect(rows).toEqual([
      "Brunch:America/Chicago",
      "Reception:America/Chicago",
      "Reception:Asia/Tokyo",
    ]);
  });

  it("moves events that follow the wedding when its zone changes, and not events with their own", async () => {
    const { wedding, event } = await setup("America/Chicago");
    const own = await owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Rehearsal", kind: "rehearsal", timeZone: "Asia/Tokyo" },
    });
    await addItem(wedding, event);
    await addItem(wedding, own.data as string);
    const before = await items(wedding);

    const r = await owner.client.rpc("update_wedding_settings", {
      p_wedding: wedding,
      p_expected_version: 1,
      p_name: "Test Wedding",
      p_timezone: "Europe/Lisbon",
      p_base_currency: "USD",
    });
    expect(r.error).toBeNull();
    const after = await withSuperuser(async (db) => {
      const q = await db.query(
        "select e.name, i.timezone, i.starts_at::text as starts from public.timeline_items i join public.events e on e.id=i.event_id where i.wedding_id=$1 order by e.name",
        [wedding],
      );
      return q.rows as { name: string; timezone: string; starts: string }[];
    });
    expect(after.map((x) => `${x.name}:${x.timezone}`)).toEqual([
      "Reception:Europe/Lisbon",
      "Rehearsal:Asia/Tokyo",
    ]);
    expect(after.map((x) => x.starts).sort()).toEqual(before.map((x) => x.starts).sort());
  });
});

describe("event time zone: writing an item against a zone that changed", () => {
  it("refuses a create typed against a zone that is no longer the event's, writing nothing", async () => {
    const { wedding, event } = await setup("America/Chicago");
    await updateEvent(wedding, event, 1, { timeZone: "Europe/Rome" });
    const stale = await addItem(wedding, event, { p_expected_zone: "America/Chicago" });
    expect(stale.error?.code).toBe("55000");
    expect(await items(wedding)).toEqual([]);
    const ok = await addItem(wedding, event, { p_expected_zone: "Europe/Rome" });
    expect(ok.error).toBeNull();
    expect((await items(wedding))[0]?.timezone).toBe("Europe/Rome");
    // The expected zone is optional.
    expect((await addItem(wedding, event, { p_title: "Cake" })).error).toBeNull();
  });

  it("makes an edit form opened before a zone change conflict instead of saving misread clock times", async () => {
    const { wedding, event } = await setup("America/Chicago");
    await addItem(wedding, event);
    const [item] = await items(wedding);
    await updateEvent(wedding, event, 1, { timeZone: "Europe/Rome" });
    const stale = await owner.client.rpc("update_timeline_item", {
      p_wedding: wedding,
      p_item: item!.id,
      p_expected_version: item!.version,
      p_title: "Toasts",
      p_starts_at: "2027-06-12T10:00:00Z",
    });
    expect(stale.error?.code).toBe("55000");
    expect((await items(wedding))[0]?.starts).toBe(item!.starts);
    const fresh = (await items(wedding))[0]!;
    const ok = await owner.client.rpc("update_timeline_item", {
      p_wedding: wedding,
      p_item: item!.id,
      p_expected_version: fresh.version,
      p_title: "Toasts",
      p_starts_at: "2027-06-12T10:00:00Z",
    });
    expect(ok.error).toBeNull();
  });

  it("keeps the idempotent retry of an item create from adding a second item", async () => {
    const { wedding, event } = await setup("America/Chicago", { timeZone: "Asia/Tokyo" });
    const key = `tz-key-${Date.now()}`;
    const one = await addItem(wedding, event, {
      p_idempotency_key: key,
      p_expected_zone: "Asia/Tokyo",
    });
    const two = await addItem(wedding, event, {
      p_idempotency_key: key,
      p_expected_zone: "Asia/Tokyo",
    });
    expect(one.error).toBeNull();
    expect(two.data).toBe(one.data);
    expect(await items(wedding)).toHaveLength(1);
  });
});

describe("event time zone: who can read it", () => {
  it("is visible to every member of the wedding and to nobody else", async () => {
    const { wedding } = await setup("America/Chicago", { timeZone: "Asia/Tokyo" });
    const viewer = await addMember(wedding, "viewer", "tz-viewer2");
    const seen = await viewer.client.rpc("list_event_labels", { p_wedding: wedding });
    expect(seen.data?.[0]).toMatchObject({ effective_time_zone: "Asia/Tokyo" });
    const none = await stranger.client.rpc("list_event_labels", { p_wedding: wedding });
    expect(none.data ?? []).toEqual([]);
  });

  it("keeps the events table itself closed to a viewer", async () => {
    const { wedding } = await setup("America/Chicago", { timeZone: "Asia/Tokyo" });
    const viewer = await addMember(wedding, "viewer", "tz-viewer3");
    const direct = await viewer.client.from("events").select("time_zone").eq("wedding_id", wedding);
    expect(direct.data ?? []).toEqual([]);
  });
});
