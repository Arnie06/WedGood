import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rewritePlace } from "../../src/domain/events/location";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-06: spaces under a venue and one place per event. The database, not the app, refuses a space
// from another venue or wedding; a stale (archived) choice is kept and never invented away.

let owner: TestUser;
let wedding: string;
let other: TestUser;
let otherWedding: string;
let reception: string;
let ceremony: string;
let barn: string; // venue
let hall: string; // venue
let photographer: string; // vendor, not a venue
let foreignVenue: string;

const START = "2027-06-12T20:00:00Z";

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
const venue = async (
  user: TestUser,
  w: string,
  name: string,
  extra: Record<string, unknown> = {},
) =>
  (await ok(
    user.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: name,
      ...extra,
    }),
  )) as string;
const space = (
  user: TestUser,
  w: string,
  v: string,
  name: string,
  extra: Record<string, unknown> = {},
) =>
  user.client.rpc("create_venue_space", { p_wedding: w, p_candidate: v, p_name: name, ...extra });
const spaceId = async (
  user: TestUser,
  w: string,
  v: string,
  name: string,
  extra: Record<string, unknown> = {},
) => (await ok(space(user, w, v, name, extra))) as string;
const setLoc = (
  user: TestUser,
  w: string,
  event: string,
  version: number,
  v: string | null,
  s: string | null = null,
  agenda = false,
) =>
  user.client.rpc("set_event_location", {
    p_wedding: w,
    p_event: event,
    p_expected_version: version,
    ...(v && { p_candidate: v }),
    ...(s && { p_space: s }),
    p_update_agenda: agenda,
  });
const locRow = (event: string) =>
  withSuperuser(async (db) => {
    const r = await db.query("select * from public.event_locations where event_id=$1", [event]);
    return r.rows[0] as
      { candidate_id: string; space_id: string | null; version: number } | undefined;
  });
const audits = (entity: string, action: string) =>
  withSuperuser(async (db) => {
    const r = await db.query(
      "select safe_changes from public.audit_events where entity_id=$1 and action=$2 order by occurred_at, id",
      [entity, action],
    );
    return r.rows.map((x) => x.safe_changes as Record<string, unknown>);
  });
const agendaItem = (event: string, title: string, location: string | null, status = "scheduled") =>
  withSuperuser(async (db) => {
    const r = await db.query(
      `insert into public.timeline_items (wedding_id, event_id, title, starts_at, timezone, location, status)
       select wedding_id, id, $2, $3, 'UTC', $4, $5 from public.events where id=$1 returning id`,
      [event, title, START, location, status],
    );
    return r.rows[0].id as string;
  });
const itemLocation = (id: string) =>
  withSuperuser(async (db) => {
    const r = await db.query("select location, version from public.timeline_items where id=$1", [
      id,
    ]);
    return r.rows[0] as { location: string | null; version: number };
  });

beforeAll(async () => {
  owner = await createUser("loc-owner");
  wedding = await createWedding(owner, { name: "Location Wedding" });
  other = await createUser("loc-other");
  otherWedding = await createWedding(other, { name: "Elsewhere" });
  reception = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  ceremony = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Ceremony", kind: "ceremony" },
    }),
  )) as string;
  barn = await venue(owner, wedding, "Old Barn", { p_seated_capacity: 140 });
  hall = await venue(owner, wedding, "Rose Hall", { p_seated_capacity: 90 });
  photographer = (await ok(
    owner.client.rpc("create_candidate", {
      p_wedding: wedding,
      p_kind: "vendor",
      p_category: "photographer",
      p_name: "Lens Co",
    }),
  )) as string;
  foreignVenue = await venue(other, otherWedding, "Foreign Hall");
});

describe("venue spaces", () => {
  it("adds a space with unknown capacity left null, not zero", async () => {
    const id = await spaceId(owner, wedding, barn, "Garden terrace");
    const row = await withSuperuser(
      async (db) => (await db.query("select * from public.venue_spaces where id=$1", [id])).rows[0],
    );
    expect(row.seated_capacity).toBeNull();
    expect(row.standing_capacity).toBeNull();
    expect(row.version).toBe(1);
    expect((await audits(id, "venue_space.created")).length).toBe(1);
  });

  it("refuses bad input and leaves no row", async () => {
    const before = await withSuperuser(async (db) =>
      Number((await db.query("select count(*) n from public.venue_spaces")).rows[0].n),
    );
    for (const extra of [
      { p_seated_capacity: 0 },
      { p_seated_capacity: 100001 },
      { p_standing_capacity: -1 },
      { p_notes: "x".repeat(501) },
    ]) {
      const r = await space(owner, wedding, barn, `Bad ${randomUUID()}`, extra);
      expect(r.error?.code, JSON.stringify(extra)).toBe("22023");
    }
    expect((await space(owner, wedding, barn, "   ")).error?.code).toBe("22023");
    expect((await space(owner, wedding, barn, "x".repeat(81))).error?.code).toBe("22023");
    const after = await withSuperuser(async (db) =>
      Number((await db.query("select count(*) n from public.venue_spaces")).rows[0].n),
    );
    expect(after).toBe(before);
  });

  it("only attaches to an active venue of this wedding", async () => {
    expect((await space(owner, wedding, photographer, "Studio")).error?.code).toBe("42501");
    expect((await space(owner, wedding, foreignVenue, "Sneaky")).error?.code).toBe("42501");
    expect((await space(owner, wedding, randomUUID(), "Nowhere")).error?.code).toBe("42501");
    const gone = await venue(owner, wedding, "Closed Down");
    await ok(
      owner.client.rpc("archive_candidate", {
        p_wedding: wedding,
        p_candidate: gone,
        p_expected_version: 1,
      }),
    );
    expect((await space(owner, wedding, gone, "Lobby")).error?.code).toBe("42501");
  });

  it("names are unique per venue ignoring case, reusable on another venue and after removal", async () => {
    const a = await spaceId(owner, wedding, barn, "Loft");
    expect((await space(owner, wedding, barn, "LOFT")).error?.code).toBe("23505");
    await spaceId(owner, wedding, hall, "Loft");
    await ok(
      owner.client.rpc("archive_venue_space", {
        p_wedding: wedding,
        p_space: a,
        p_expected_version: 1,
      }),
    );
    await spaceId(owner, wedding, barn, "Loft");
  });

  it("idempotent replay creates one space; a changed payload with the same key is refused", async () => {
    const key = randomUUID();
    const [x, y, z] = await Promise.all(
      [0, 1, 2].map(() => space(owner, wedding, barn, "Cellar", { p_idempotency_key: key })),
    );
    expect([x, y, z].every((r) => r && !r.error)).toBe(true);
    expect(new Set([x?.data, y?.data, z?.data]).size).toBe(1);
    const changed = await space(owner, wedding, barn, "Cellar", {
      p_idempotency_key: key,
      p_seated_capacity: 10,
    });
    expect(changed.error?.code).toBe("23505");
  });

  it("limits a venue to 30 active spaces", async () => {
    const v = await venue(owner, wedding, "Maze");
    for (let i = 0; i < 30; i++) await spaceId(owner, wedding, v, `Room ${i}`);
    expect((await space(owner, wedding, v, "One too many")).error?.code).toBe("54000");
  });

  it("updates with a version check; a no-op keeps the version; a stale version is refused", async () => {
    const id = await spaceId(owner, wedding, hall, "Conservatory", { p_seated_capacity: 40 });
    const call = (version: number, name: string, seated: number | null) =>
      owner.client.rpc("update_venue_space", {
        p_wedding: wedding,
        p_space: id,
        p_expected_version: version,
        p_name: name,
        ...(seated !== null && { p_seated_capacity: seated }),
      });
    expect(await ok(call(1, "Conservatory", 40))).toBe(1);
    expect(await ok(call(1, "Conservatory", 60))).toBe(2);
    expect((await call(1, "Conservatory", 70)).error?.code).toBe("55000");
    const cleared = await ok(call(2, "Conservatory", null));
    expect(cleared).toBe(3);
    const row = await withSuperuser(
      async (db) =>
        (await db.query("select seated_capacity from public.venue_spaces where id=$1", [id]))
          .rows[0],
    );
    expect(row.seated_capacity).toBeNull();
    const logged = await audits(id, "venue_space.updated");
    expect(logged.length).toBe(2);
    expect(JSON.stringify(logged)).not.toContain("Conservatory");
  });

  it("archive keeps the row, is idempotent and refuses a stale version", async () => {
    const id = await spaceId(owner, wedding, hall, "Chapel");
    expect(
      (
        await owner.client.rpc("archive_venue_space", {
          p_wedding: wedding,
          p_space: id,
          p_expected_version: 9,
        })
      ).error?.code,
    ).toBe("55000");
    const v = await ok(
      owner.client.rpc("archive_venue_space", {
        p_wedding: wedding,
        p_space: id,
        p_expected_version: 1,
      }),
    );
    expect(v).toBe(2);
    expect(
      await ok(
        owner.client.rpc("archive_venue_space", {
          p_wedding: wedding,
          p_space: id,
          p_expected_version: 1,
        }),
      ),
    ).toBe(2);
    expect((await audits(id, "venue_space.archived")).length).toBe(1);
    const row = await withSuperuser(
      async (db) =>
        (await db.query("select archived_at from public.venue_spaces where id=$1", [id])).rows[0],
    );
    expect(row.archived_at).not.toBeNull();
  });

  it("role matrix: owner and partner write; editor, viewer and strangers cannot; everyone in the wedding reads", async () => {
    const partner = await addMember(wedding, "partner", "loc-partner");
    const editor = await addMember(wedding, "editor", "loc-editor");
    const viewer = await addMember(wedding, "viewer", "loc-viewer");
    await spaceId(partner, wedding, barn, `By partner ${randomUUID().slice(0, 6)}`);
    for (const u of [editor, viewer, other]) {
      expect((await space(u, wedding, barn, "Nope")).error?.code).toBe("42501");
    }
    const target = await spaceId(owner, wedding, hall, "Read me");
    for (const u of [editor, viewer]) {
      const seen = await ok(u.client.from("venue_spaces").select("id").eq("id", target));
      expect(seen.length).toBe(1);
      expect(
        (
          await u.client.rpc("update_venue_space", {
            p_wedding: wedding,
            p_space: target,
            p_expected_version: 1,
            p_name: "Renamed",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await u.client.rpc("archive_venue_space", {
            p_wedding: wedding,
            p_space: target,
            p_expected_version: 1,
          })
        ).error?.code,
      ).toBe("42501");
    }
    expect((await ok(other.client.from("venue_spaces").select("id").eq("id", target))).length).toBe(
      0,
    );
    // A stranger cannot edit it through their own wedding either: the id is not theirs.
    expect(
      (
        await other.client.rpc("update_venue_space", {
          p_wedding: otherWedding,
          p_space: target,
          p_expected_version: 1,
          p_name: "Mine now",
        })
      ).error?.code,
    ).toBe("42501");
  });

  it("clients cannot write the tables directly", async () => {
    const ins = await owner.client
      .from("venue_spaces")
      .insert({ wedding_id: wedding, candidate_id: barn, name: "Direct" });
    expect(ins.error).not.toBeNull();
    const loc = await owner.client
      .from("event_locations")
      .insert({ event_id: reception, wedding_id: wedding, candidate_id: barn });
    expect(loc.error).not.toBeNull();
  });
});

describe("event location", () => {
  it("sets a venue, then a space, clears it, and an event has at most one place", async () => {
    const terrace = await spaceId(owner, wedding, barn, "Terrace", { p_seated_capacity: 110 });
    const r1 = (await ok(setLoc(owner, wedding, reception, 0, barn))) as { version: number };
    expect(r1.version).toBe(1);
    const r2 = (await ok(setLoc(owner, wedding, reception, 1, barn, terrace))) as {
      version: number;
    };
    expect(r2.version).toBe(2);
    expect((await locRow(reception))?.space_id).toBe(terrace);
    const count = await withSuperuser(async (db) =>
      Number(
        (
          await db.query("select count(*) n from public.event_locations where event_id=$1", [
            reception,
          ])
        ).rows[0].n,
      ),
    );
    expect(count).toBe(1);
    const cleared = (await ok(setLoc(owner, wedding, reception, 2, null))) as { version: number };
    expect(cleared.version).toBe(0);
    expect(await locRow(reception)).toBeUndefined();
    const logged = await audits(reception, "event.location_set");
    expect(logged.length).toBe(3);
  });

  it("a no-op writes nothing: same place keeps the version and adds no audit entry", async () => {
    await ok(setLoc(owner, wedding, ceremony, 0, hall));
    const before = (await audits(ceremony, "event.location_set")).length;
    const again = (await ok(setLoc(owner, wedding, ceremony, 1, hall))) as { version: number };
    expect(again.version).toBe(1);
    expect((await audits(ceremony, "event.location_set")).length).toBe(before);
    // Clearing an event that has no place is also a no-op.
    const bare = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name: "Brunch", kind: "brunch" },
      }),
    )) as string;
    const none = (await ok(setLoc(owner, wedding, bare, 0, null))) as { version: number };
    expect(none.version).toBe(0);
    expect((await audits(bare, "event.location_set")).length).toBe(0);
  });

  it("refuses a space from another venue, another wedding, an archived one, or without a venue", async () => {
    const hallSpace = await spaceId(owner, wedding, hall, "Library");
    const foreignSpace = await spaceId(other, otherWedding, foreignVenue, "Foreign room");
    const reset = async () => {
      await withSuperuser((db) =>
        db.query("delete from public.event_locations where event_id=$1", [reception]),
      );
    };
    await reset();
    expect((await setLoc(owner, wedding, reception, 0, barn, hallSpace)).error?.code).toBe("22023");
    expect((await setLoc(owner, wedding, reception, 0, barn, foreignSpace)).error?.code).toBe(
      "22023",
    );
    expect((await setLoc(owner, wedding, reception, 0, null, hallSpace)).error?.code).toBe("22023");
    await ok(
      owner.client.rpc("archive_venue_space", {
        p_wedding: wedding,
        p_space: hallSpace,
        p_expected_version: 1,
      }),
    );
    expect((await setLoc(owner, wedding, reception, 0, hall, hallSpace)).error?.code).toBe("22023");
    expect(await locRow(reception)).toBeUndefined();
  });

  it("refuses a vendor, a venue from another wedding, an archived venue and an unknown id", async () => {
    expect((await setLoc(owner, wedding, reception, 0, photographer)).error?.code).toBe("42501");
    expect((await setLoc(owner, wedding, reception, 0, foreignVenue)).error?.code).toBe("42501");
    expect((await setLoc(owner, wedding, reception, 0, randomUUID())).error?.code).toBe("42501");
    const closed = await venue(owner, wedding, "Shut Hall");
    await ok(
      owner.client.rpc("archive_candidate", {
        p_wedding: wedding,
        p_candidate: closed,
        p_expected_version: 1,
      }),
    );
    expect((await setLoc(owner, wedding, reception, 0, closed)).error?.code).toBe("42501");
    // An event of another wedding is indistinguishable from an unknown one.
    expect((await setLoc(owner, wedding, randomUUID(), 0, barn)).error?.code).toBe("42501");
    expect(await locRow(reception)).toBeUndefined();
  });

  it("the database itself refuses a space from another venue, even from a superuser", async () => {
    const barnSpace = await spaceId(owner, wedding, barn, "FK probe");
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.event_locations (event_id, wedding_id, candidate_id, space_id) values ($1,$2,$3,$4)",
          [reception, wedding, hall, barnSpace],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.event_locations (event_id, wedding_id, candidate_id) values ($1,$2,$3)",
          [reception, wedding, foreignVenue],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a stale version is refused; two writers with the same version have exactly one winner", async () => {
    const ev = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name: "Race", kind: "other" },
      }),
    )) as string;
    const results = await Promise.all([
      setLoc(owner, wedding, ev, 0, barn),
      setLoc(owner, wedding, ev, 0, hall),
    ]);
    expect(results.filter((r) => !r.error).length).toBe(1);
    expect(results.filter((r) => r.error?.code === "55000").length).toBe(1);
    expect((await setLoc(owner, wedding, ev, 0, barn)).error?.code).toBe("55000");
  });

  it("an archived space stays on the event (a stale choice), and can still be replaced", async () => {
    const ev = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name: "Stale", kind: "other" },
      }),
    )) as string;
    const s = await spaceId(owner, wedding, barn, "Soon gone");
    await ok(setLoc(owner, wedding, ev, 0, barn, s));
    await ok(
      owner.client.rpc("archive_venue_space", {
        p_wedding: wedding,
        p_space: s,
        p_expected_version: 1,
      }),
    );
    expect((await locRow(ev))?.space_id).toBe(s);
    const seen = await ok(
      owner.client.from("venue_spaces").select("name, archived_at").eq("id", s),
    );
    expect(seen[0]?.archived_at).not.toBeNull();
    const fixed = (await ok(setLoc(owner, wedding, ev, 1, barn, null))) as { version: number };
    expect(fixed.version).toBe(2);
  });

  it("role matrix: owner and partner set it; editor, viewer and strangers cannot; members can read it", async () => {
    const partner = await addMember(wedding, "partner", "loc2-partner");
    const editor = await addMember(wedding, "editor", "loc2-editor");
    const viewer = await addMember(wedding, "viewer", "loc2-viewer");
    const ev = (await ok(
      owner.client.rpc("create_event", {
        p_wedding: wedding,
        p_event: { name: "Roles", kind: "other" },
      }),
    )) as string;
    for (const u of [editor, viewer, other]) {
      expect((await setLoc(u, wedding, ev, 0, barn)).error?.code).toBe("42501");
    }
    await ok(setLoc(partner, wedding, ev, 0, barn));
    for (const u of [editor, viewer]) {
      const seen = await ok(u.client.from("event_locations").select("event_id").eq("event_id", ev));
      expect(seen.length).toBe(1);
    }
    expect(
      (await ok(other.client.from("event_locations").select("event_id").eq("event_id", ev))).length,
    ).toBe(0);
  });

  describe("agenda places", () => {
    async function freshEvent(name: string) {
      return (await ok(
        owner.client.rpc("create_event", {
          p_wedding: wedding,
          p_event: { name, kind: "other" },
        }),
      )) as string;
    }

    it("rewrites only this event's scheduled places that name the old venue, when asked", async () => {
      const ev = await freshEvent("Agenda A");
      const elsewhere = await freshEvent("Agenda B");
      await ok(setLoc(owner, wedding, ev, 0, barn));
      const named = await agendaItem(ev, "Dinner", "Garden terrace at old barn");
      const plain = await agendaItem(ev, "Toast", "The lawn");
      const nothing = await agendaItem(ev, "Cake", null);
      const cancelled = await agendaItem(ev, "Old plan", "Old Barn", "cancelled");
      const otherEvent = await agendaItem(elsewhere, "Other", "Old Barn");
      const r = (await ok(setLoc(owner, wedding, ev, 1, hall, null, true))) as {
        agenda_updated: number;
      };
      expect(r.agenda_updated).toBe(1);
      expect((await itemLocation(named)).location).toBe("Garden terrace at Rose Hall");
      expect((await itemLocation(named)).version).toBe(2);
      expect((await itemLocation(plain)).location).toBe("The lawn");
      expect((await itemLocation(nothing)).location).toBeNull();
      expect((await itemLocation(cancelled)).location).toBe("Old Barn");
      expect((await itemLocation(otherEvent)).location).toBe("Old Barn");
      const logged = await audits(ev, "event.location_set");
      expect(logged.at(-1)?.agendaUpdated).toBe(1);
    });

    it("leaves the agenda alone unless asked, and on a space-only change", async () => {
      const ev = await freshEvent("Agenda C");
      const s1 = await spaceId(owner, wedding, barn, `S1 ${randomUUID().slice(0, 5)}`);
      const s2 = await spaceId(owner, wedding, barn, `S2 ${randomUUID().slice(0, 5)}`);
      await ok(setLoc(owner, wedding, ev, 0, barn, s1));
      const item = await agendaItem(ev, "Dinner", "Old Barn terrace");
      const space = (await ok(setLoc(owner, wedding, ev, 1, barn, s2, true))) as {
        agenda_updated: number;
      };
      expect(space.agenda_updated).toBe(0);
      const moved = (await ok(setLoc(owner, wedding, ev, 2, hall, null, false))) as {
        agenda_updated: number;
      };
      expect(moved.agenda_updated).toBe(0);
      expect((await itemLocation(item)).location).toBe("Old Barn terrace");
    });

    it("skips a place whose rewritten text would be over 200 characters", async () => {
      const ev = await freshEvent("Agenda D");
      await ok(setLoc(owner, wedding, ev, 0, barn));
      const long = await agendaItem(ev, "Long", `Old Barn ${"x".repeat(191)}`);
      const r = (await ok(setLoc(owner, wedding, ev, 1, hall, null, true))) as {
        agenda_updated: number;
      };
      expect(r.agenda_updated).toBe(0);
      expect((await itemLocation(long)).location?.startsWith("Old Barn")).toBe(true);
    });

    it("rewrite_place matches the app's preview rule", async () => {
      const cases: [string | null, string, string][] = [
        ["Garden terrace at old barn", "Old Barn", "Rose Hall"],
        ["Old Barn, Old Barn lawn", "old barn", "X"],
        ["The lawn", "Old Barn", "Rose Hall"],
        [null, "Old Barn", "X"],
        ["Café Müller patio", "CAFÉ MÜLLER", "Rose Hall"],
        ["50% off_barn", "%", "pct"],
        [`Old Barn ${"x".repeat(191)}`, "Old Barn", "A longer name"],
      ];
      for (const [loc, oldName, newName] of cases) {
        const sql = await withSuperuser(
          async (db) =>
            (
              await db.query("select app_private.rewrite_place($1,$2,$3) as r", [
                loc,
                oldName,
                newName,
              ])
            ).rows[0].r as string | null,
        );
        const app = rewritePlace(loc, oldName, newName);
        // The database leaves the 200-character guard to the caller's update, the app folds it in.
        const sqlGuarded = sql !== null && sql.length > 200 ? null : sql;
        expect(app, JSON.stringify([loc, oldName, newName])).toBe(sqlGuarded);
      }
    });
  });
});
