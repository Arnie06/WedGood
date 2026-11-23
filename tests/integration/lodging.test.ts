import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-17 lodging (L1): hotels, room blocks, who is staying where, the Budget page's possible costs
// and hotels on the published guest website. Real local Postgres, PostgREST and RLS. Synthetic names.

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("lodging-owner");
  stranger = await createUser("lodging-stranger");
});

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
const code = async (p: PromiseLike<{ error: { code?: string } | null }>) =>
  (await p).error?.code ?? null;
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}

async function addMember(w: string, role: "partner" | "editor" | "viewer", permissions = {}) {
  const user = await createUser(`lodging-${role}`);
  await q(
    "insert into public.memberships (wedding_id, user_id, role, permissions) values ($1,$2,$3,$4)",
    [w, user.id, role, JSON.stringify(permissions)],
  );
  return user;
}

const HOTEL = {
  name: "Harbour Inn",
  address: "1 Quay Street",
  websiteUrl: "https://example.test/inn",
  guestNote: "Ask for the wedding rate.",
  showToGuests: true,
  showRate: false,
};
const BLOCK = {
  checkIn: "2027-06-11",
  checkOut: "2027-06-13",
  roomsPerNight: 20,
  nightlyRateMinor: 18_900,
  attritionAllowedBp: 2_000,
  cutoffDate: "2027-05-10",
  bookingCode: "SMITHWED",
};

const addHotel = (w: string, over: object = {}, as: TestUser = owner) =>
  as.client.rpc("add_lodging_hotel", { p_wedding: w, p_hotel: { ...HOTEL, ...over } });
const mkHotel = async (w: string, over: object = {}) => (await ok(addHotel(w, over))) as string;
const addBlock = (w: string, hotel: string, over: object = {}, as: TestUser = owner) =>
  as.client.rpc("add_lodging_block", {
    p_wedding: w,
    p_hotel_id: hotel,
    p_block: { ...BLOCK, ...over },
  });
const mkBlock = async (w: string, hotel: string, over: object = {}) =>
  (await ok(addBlock(w, hotel, over))) as string;
async function guest(w: string, name: string) {
  return (await ok(
    owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }),
  )) as string;
}

describe("hotels", () => {
  it("adds, updates with a version check, and refuses bad input", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const [row] = await q<Record<string, unknown>>(
      "select * from public.lodging_hotels where id=$1",
      [h],
    );
    expect(row).toMatchObject({
      name: "Harbour Inn",
      show_to_guests: true,
      show_rate: false,
      version: 1,
    });

    expect(
      await ok(
        owner.client.rpc("update_lodging_hotel", {
          p_wedding: w,
          p_hotel_id: h,
          p_expected_version: 1,
          p_hotel: { ...HOTEL, showRate: true },
        }),
      ),
    ).toBe(2);
    expect(
      await code(
        owner.client.rpc("update_lodging_hotel", {
          p_wedding: w,
          p_hotel_id: h,
          p_expected_version: 1,
          p_hotel: HOTEL,
        }),
      ),
    ).toBe("55000");
    // Saving the same values again changes nothing.
    expect(
      await ok(
        owner.client.rpc("update_lodging_hotel", {
          p_wedding: w,
          p_hotel_id: h,
          p_expected_version: 2,
          p_hotel: { ...HOTEL, showRate: true },
        }),
      ),
    ).toBe(2);

    for (const bad of [
      { name: "  " },
      { websiteUrl: "http://example.test" },
      { websiteUrl: "javascript:alert(1)" },
      { guestNote: "x".repeat(501) },
      { showToGuests: "yes" },
      { extra: 1 },
    ]) {
      expect(await code(addHotel(w, bad))).toBe("22023");
    }
  });

  it("refuses another wedding's vendor and audits field names only", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(owner);
    const vendor = (await ok(
      owner.client.rpc("create_candidate", {
        p_wedding: other,
        p_kind: "vendor",
        p_category: "other",
        p_name: "Elsewhere Hotels",
      }),
    )) as string;
    expect(await code(addHotel(w, { candidateId: vendor }))).toBe("42501");
    const h = await mkHotel(w, { guestNote: "SENTINEL note" });
    const audit = await q<{ t: string }>(
      "select safe_changes::text t from public.audit_events where wedding_id=$1",
      [w],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.map((a) => a.t).join(" ")).not.toContain("SENTINEL");
    void h;
  });

  it("archives instead of deleting, and keeps answers that name the hotel", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const g = await guest(w, "Ada Example");
    await ok(
      owner.client.rpc("set_lodging_stays", {
        p_wedding: w,
        p_guests: [g],
        p_kind: "hotel",
        p_hotel_id: h,
      }),
    );
    expect(
      await ok(
        owner.client.rpc("set_lodging_hotel_archived", {
          p_wedding: w,
          p_hotel_id: h,
          p_expected_version: 1,
          p_archived: true,
        }),
      ),
    ).toBe(2);
    expect(
      (
        await q("select 1 from public.lodging_stays where guest_id=$1 and planner_hotel_id=$2", [
          g,
          h,
        ])
      ).length,
    ).toBe(1);
    // An archived hotel cannot be chosen again.
    const g2 = await guest(w, "Bo Example");
    expect(
      await code(
        owner.client.rpc("set_lodging_stays", {
          p_wedding: w,
          p_guests: [g2],
          p_kind: "hotel",
          p_hotel_id: h,
        }),
      ),
    ).toBe("42501");
  });
});

describe("blocks", () => {
  it("adds and updates blocks with checked dates, rooms and money", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const b = await mkBlock(w, h);
    const [row] = await q<Record<string, unknown>>(
      "select * from public.lodging_blocks where id=$1",
      [b],
    );
    expect(row).toMatchObject({
      rooms_per_night: 20,
      nightly_rate_minor: "18900",
      attrition_allowed_bp: 2000,
    });
    for (const bad of [
      { checkOut: "2027-06-11" },
      { checkOut: "2027-07-12" },
      { roomsPerNight: 0 },
      { roomsPerNight: 501 },
      { nightlyRateMinor: 0 },
      { nightlyRateMinor: 18.5 },
      { attritionAllowedBp: 10_001 },
      { bookingUrl: "http://x.test" },
      { checkIn: "2027-02-30" },
    ]) {
      expect(await code(addBlock(w, h, bad))).toBe("22023");
    }
    expect(
      await ok(
        owner.client.rpc("update_lodging_block", {
          p_wedding: w,
          p_block_id: b,
          p_expected_version: 1,
          p_block: { ...BLOCK, roomsPerNight: 25 },
        }),
      ),
    ).toBe(2);
  });

  it("refuses another wedding's hotel or budget category, and archived categories", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(owner);
    const otherHotel = await mkHotel(other);
    expect(await code(addBlock(w, otherHotel))).toBe("42501");
    const h = await mkHotel(w);
    const foreignCat = (await ok(
      owner.client.rpc("create_budget_category", { p_wedding: other, p_name: "Rooms" }),
    )) as string;
    expect(await code(addBlock(w, h, { budgetCategoryId: foreignCat }))).toBe("42501");
    const cat = (await ok(
      owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Accommodation" }),
    )) as string;
    expect(await code(addBlock(w, h, { budgetCategoryId: cat }))).toBeNull();
    await ok(
      owner.client.rpc("archive_budget_category", {
        p_wedding: w,
        p_category: cat,
        p_expected_version: 1,
      }),
    );
    expect(await code(addBlock(w, h, { budgetCategoryId: cat }))).toBe("42501");
  });

  it("records the hotel's pickup report within the room-nights held", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const b = await mkBlock(w, h);
    const pickup = (v: number, n: number | null, asOf: string | null) =>
      owner.client.rpc("record_lodging_pickup", {
        p_wedding: w,
        p_block_id: b,
        p_expected_version: v,
        ...(n !== null && { p_room_nights: n }),
        ...(asOf !== null && { p_as_of: asOf }),
      });
    expect(await code(pickup(1, 41, "2026-01-01"))).toBe("LG409");
    expect(await code(pickup(1, 10, null))).toBe("22023");
    expect(await code(pickup(1, 10, "2999-01-01"))).toBe("22023");
    expect(await ok(pickup(1, 26, "2026-01-01"))).toBe(2);
    // Shrinking the block below the reported pickup is refused, not silently clamped.
    expect(
      await code(
        owner.client.rpc("update_lodging_block", {
          p_wedding: w,
          p_block_id: b,
          p_expected_version: 2,
          p_block: { ...BLOCK, roomsPerNight: 10 },
        }),
      ),
    ).toBe("LG409");
    expect(await ok(pickup(2, null, null))).toBe(3);
    const [row] = await q<Record<string, unknown>>(
      "select picked_up_room_nights, picked_up_as_of from public.lodging_blocks where id=$1",
      [b],
    );
    expect(row).toEqual({ picked_up_room_nights: null, picked_up_as_of: null });
  });

  it("removes a block with a version check", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const b = await mkBlock(w, h);
    expect(
      await code(
        owner.client.rpc("remove_lodging_block", {
          p_wedding: w,
          p_block_id: b,
          p_expected_version: 9,
        }),
      ),
    ).toBe("55000");
    await ok(
      owner.client.rpc("remove_lodging_block", {
        p_wedding: w,
        p_block_id: b,
        p_expected_version: 1,
      }),
    );
    expect(await q("select 1 from public.lodging_blocks where id=$1", [b])).toEqual([]);
  });
});

describe("who is staying where", () => {
  it("sets and clears the planner's choice for many guests, all or nothing", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const a = await guest(w, "Ada Example");
    const b = await guest(w, "Bo Example");
    const set = (guests: string[], kind?: string, hotel?: string) =>
      owner.client.rpc("set_lodging_stays", {
        p_wedding: w,
        p_guests: guests,
        ...(kind && { p_kind: kind }),
        ...(hotel && { p_hotel_id: hotel }),
      });
    expect(await ok(set([a, b], "hotel", h))).toBe(2);
    expect(await ok(set([a, b], "hotel", h))).toBe(0); // a repeat changes nothing
    expect(await code(set([a], "hotel"))).toBe("22023");
    expect(await code(set([a], "elsewhere", h))).toBe("22023");
    expect(await code(set([a], "camping"))).toBe("22023");
    const other = await createWedding(owner);
    const foreign = await guest(other, "Cy Example");
    expect(await code(set([a, foreign], "elsewhere"))).toBe("42501");
    expect(
      (
        await q<{ planner_kind: string }>(
          "select planner_kind from public.lodging_stays where guest_id=$1",
          [a],
        )
      )[0]!.planner_kind,
    ).toBe("hotel");
    expect(await ok(set([a]))).toBe(1);
    expect(await q("select 1 from public.lodging_stays where guest_id=$1", [a])).toEqual([]);
  });

  it("clearing the planner's choice keeps the guest's own answer", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    const a = await guest(w, "Ada Example");
    // Stands in for a guest's RSVP answer (the guest path arrives in the next migration).
    await q(
      `insert into public.lodging_stays (wedding_id, guest_id, guest_kind, guest_answered_at)
       values ($1, $2, 'elsewhere', now())`,
      [w, a],
    );
    await ok(
      owner.client.rpc("set_lodging_stays", {
        p_wedding: w,
        p_guests: [a],
        p_kind: "hotel",
        p_hotel_id: h,
      }),
    );
    await ok(owner.client.rpc("set_lodging_stays", { p_wedding: w, p_guests: [a] }));
    const [row] = await q<Record<string, unknown>>(
      "select planner_kind, guest_kind from public.lodging_stays where guest_id=$1",
      [a],
    );
    expect(row).toEqual({ planner_kind: null, guest_kind: "elsewhere" });
  });
});

describe("authorization", () => {
  it("lets owner, partner and a planner with the guests grant manage lodging, nobody else", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner");
    const planner = await addMember(w, "editor", { guests: true });
    const plain = await addMember(w, "editor", { budget: true });
    const viewer = await addMember(w, "viewer");
    expect(await code(addHotel(w, {}, partner))).toBeNull();
    const h = (await ok(addHotel(w, {}, planner))) as string;
    expect(await code(addBlock(w, h, {}, planner))).toBeNull();
    for (const u of [plain, viewer, stranger]) {
      expect(await code(addHotel(w, {}, u))).toBe("42501");
      expect(await code(addBlock(w, h, {}, u))).toBe("42501");
      expect(
        await code(
          u.client.rpc("set_lodging_stays", {
            p_wedding: w,
            p_guests: [randomUUID()],
            p_kind: "elsewhere",
          }),
        ),
      ).toBe("42501");
      for (const t of ["lodging_hotels", "lodging_blocks", "lodging_stays"] as const) {
        expect((await u.client.from(t).select("id").eq("wedding_id", w)).data).toEqual([]);
      }
    }
    expect(await code(addHotel(w, {}, { ...owner, client: anonClient() }))).not.toBeNull();
  });

  it("allows no direct writes, even for the owner", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    expect(
      (await owner.client.from("lodging_hotels").insert({ wedding_id: w, name: "x" })).error,
    ).not.toBeNull();
    const upd = await owner.client
      .from("lodging_hotels")
      .update({ show_rate: true })
      .eq("id", h)
      .select("id");
    expect(upd.data ?? []).toEqual([]);
    expect(
      (
        await q<{ show_rate: boolean }>("select show_rate from public.lodging_hotels where id=$1", [
          h,
        ])
      )[0]!.show_rate,
    ).toBe(false);
  });
});

describe("possible costs for the Budget page", () => {
  it("gives any member raw block numbers and no guest or booking details", async () => {
    const w = await createWedding(owner);
    const h = await mkHotel(w);
    await mkBlock(w, h);
    const viewer = await addMember(w, "viewer");
    const rows = (await ok(
      viewer.client.rpc("lodging_possible_costs", { p_wedding: w }),
    )) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hotel_name: "Harbour Inn",
      rooms_per_night: 20,
      attrition_allowed_bp: 2000,
    });
    expect(Object.keys(rows[0]!)).not.toContain("booking_code");
    expect(Object.keys(rows[0]!)).not.toContain("booking_url");
    expect(
      (await ok(stranger.client.rpc("lodging_possible_costs", { p_wedding: w }))) as unknown[],
    ).toEqual([]);
  });
});

describe("guest website", () => {
  it("publishes only hotels marked for guests, never pickup or attrition, and the rate only when allowed", async () => {
    const w = await createWedding(owner);
    const shown = await mkHotel(w, { name: "Shown Inn", showRate: false });
    const withRate = await mkHotel(w, { name: "Rate Inn", showRate: true });
    await mkHotel(w, { name: "Hidden Inn", showToGuests: false });
    const archived = await mkHotel(w, { name: "Old Inn" });
    await ok(
      owner.client.rpc("set_lodging_hotel_archived", {
        p_wedding: w,
        p_hotel_id: archived,
        p_expected_version: 1,
        p_archived: true,
      }),
    );
    await mkBlock(w, shown);
    const rb = await mkBlock(w, withRate);
    await ok(
      owner.client.rpc("record_lodging_pickup", {
        p_wedding: w,
        p_block_id: rb,
        p_expected_version: 1,
        p_room_nights: 26,
        p_as_of: "2026-01-01",
      }),
    );
    const draft = { template: "classic", title: "Example wedding", hotels: true };
    expect(
      await code(
        owner.client.rpc("save_site_draft", {
          p_wedding: w,
          p_expected_version: 0,
          p_draft: { ...draft, hotels: "yes" },
        }),
      ),
    ).toBe("22023");
    await ok(
      owner.client.rpc("save_site_draft", { p_wedding: w, p_expected_version: 0, p_draft: draft }),
    );
    const slug = `lodging-${randomUUID().slice(0, 8)}`;
    await ok(
      owner.client.rpc("publish_site", { p_wedding: w, p_expected_version: 1, p_slug: slug }),
    );
    const site = (await withSuperuser(
      async (db) => (await db.query("select public.public_site_view($1) v", [slug])).rows[0].v,
    )) as { hotels: { name: string; blocks: Record<string, unknown>[] }[] };
    expect(site.hotels.map((h) => h.name)).toEqual(["Shown Inn", "Rate Inn"]);
    expect(site.hotels[0]!.blocks[0]).toEqual({
      checkIn: "2027-06-11",
      checkOut: "2027-06-13",
      bookBy: "2027-05-10",
      bookingCode: "SMITHWED",
    });
    expect(site.hotels[1]!.blocks[0]).toMatchObject({
      nightlyRateMinor: 18_900,
      currency: expect.any(String),
    });
    const text = JSON.stringify(site);
    for (const secret of ["rooms", "picked", "attrition", "26", shown, withRate]) {
      expect(text).not.toContain(secret);
    }

    // Without the switch in the draft, no hotels are published.
    await ok(
      owner.client.rpc("save_site_draft", {
        p_wedding: w,
        p_expected_version: 2,
        p_draft: { ...draft, hotels: false },
      }),
    );
    await ok(
      owner.client.rpc("publish_site", { p_wedding: w, p_expected_version: 3, p_slug: slug }),
    );
    const again = (await withSuperuser(
      async (db) => (await db.query("select public.public_site_view($1) v", [slug])).rows[0].v,
    )) as Record<string, unknown>;
    expect(again.hotels).toBeUndefined();
  });
});
