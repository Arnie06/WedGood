import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-17 lodging, L2: guests say where they are staying through their RSVP link (single and party).
// A new public write path behind rsvp_submit / rsvp_party_submit. Real local Postgres. Synthetic names.

let owner: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  owner = await createUser("stay-owner");
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

type Stay = { kind: string; hotelId: string | null } | null;
type Member = { id: string; name: string; status: string; isPlusOne: boolean; stay: Stay };
type View = {
  version: number;
  members: Member[];
  hotels: { id: string; name: string; bookBy: string | null }[];
};

const hotel = async (w: string, over: object = {}) =>
  (await ok(
    owner.client.rpc("add_lodging_hotel", {
      p_wedding: w,
      p_hotel: { name: "Harbour Inn", showToGuests: true, ...over },
    }),
  )) as string;

async function setup(quota = 0) {
  const w = await createWedding(owner);
  const e = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "other" },
    }),
  )) as string;
  const g = async (name: string) =>
    (await ok(owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }))) as string;
  const ada = await g("Ada Example");
  const bo = await g("Bo Example");
  const t = newToken();
  await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: e,
      p_groups: [{ guestIds: [ada, bo], householdId: null }],
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [t.hash],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  );
  const h = await hotel(w);
  const read = async () =>
    (await adminClient().rpc("rsvp_view", { p_token_hash: t.hash, p_client: client() }))
      .data as View;
  const submit = (version: number, responses: unknown[], plusOne?: unknown) =>
    adminClient().rpc("rsvp_submit", {
      p_token_hash: t.hash,
      p_client: client(),
      p_expected_version: version,
      p_responses: responses,
      ...(plusOne ? { p_plus_one: plusOne } : {}),
    });
  const v = await read();
  const id = (name: string) => v.members.find((m) => m.name === name)!.id;
  return { w, e, ada, bo, h, read, submit, v, adaM: id("Ada Example"), boM: id("Bo Example") };
}

const stays = (w: string) =>
  q<Record<string, unknown>>(
    `select g.full_name name, s.guest_kind, s.guest_hotel_id, s.planner_kind,
            s.guest_answered_at is not null answered
       from public.lodging_stays s join public.guests g on g.id = s.guest_id
      where s.wedding_id = $1 order by g.full_name`,
    [w],
  );

describe("the guest view", () => {
  it("lists hotels marked for guests and each person's own saved stay, nothing else", async () => {
    const s = await setup();
    await hotel(s.w, { name: "Hidden Inn", showToGuests: false });
    const block = {
      checkIn: "2027-06-11",
      checkOut: "2027-06-13",
      roomsPerNight: 20,
      nightlyRateMinor: 18_900,
      cutoffDate: "2027-05-10",
      attritionAllowedBp: 2_000,
    };
    await ok(
      owner.client.rpc("add_lodging_block", { p_wedding: s.w, p_hotel_id: s.h, p_block: block }),
    );
    const v = await s.read();
    expect(v.hotels).toEqual([{ id: s.h, name: "Harbour Inn", bookBy: "2027-05-10" }]);
    expect(v.members.every((m) => m.stay === null)).toBe(true);
    const text = JSON.stringify(v);
    for (const secret of ["18900", "rooms", "attrition", "Hidden Inn"])
      expect(text).not.toContain(secret);
  });
});

describe("saving a stay", () => {
  it("stores the guest's answer for attending people only, and shows it back", async () => {
    const s = await setup();
    const res = await s.submit(s.v.version, [
      {
        memberId: s.adaM,
        status: "accepted",
        mealOptionId: null,
        stay: { kind: "hotel", hotelId: s.h },
      },
      {
        memberId: s.boM,
        status: "declined",
        mealOptionId: null,
        stay: { kind: "hotel", hotelId: s.h },
      },
    ]);
    expect(res.error).toBeNull();
    expect(await stays(s.w)).toEqual([
      {
        name: "Ada Example",
        guest_kind: "hotel",
        guest_hotel_id: s.h,
        planner_kind: null,
        answered: true,
      },
    ]);
    const after = await s.read();
    expect(after.members.find((m) => m.id === s.adaM)?.stay).toEqual({
      kind: "hotel",
      hotelId: s.h,
    });
  });

  it("a stay-only change moves the version; a retry writes nothing; a stale tab is refused", async () => {
    const s = await setup();
    await ok(s.submit(s.v.version, [{ memberId: s.adaM, status: "accepted", mealOptionId: null }]));
    const v1 = await s.read();
    const body = [
      { memberId: s.adaM, status: "accepted", mealOptionId: null, stay: { kind: "elsewhere" } },
    ];
    await ok(s.submit(v1.version, body));
    const v2 = await s.read();
    expect(v2.version).toBe(v1.version + 1);
    const answeredAt = (
      await q<{ t: string }>(
        "select guest_answered_at::text t from public.lodging_stays where wedding_id=$1",
        [s.w],
      )
    )[0]!.t;
    await ok(s.submit(v2.version, body));
    expect((await s.read()).version).toBe(v2.version);
    expect(
      (
        await q<{ t: string }>(
          "select guest_answered_at::text t from public.lodging_stays where wedding_id=$1",
          [s.w],
        )
      )[0]!.t,
    ).toBe(answeredAt);
    const stale = await s.submit(v1.version, [
      { memberId: s.adaM, status: "accepted", mealOptionId: null, stay: { kind: "not_staying" } },
    ]);
    expect(stale.error?.code).toBe("55000");
  });

  it("never changes what the couple set, and the couple's choice still wins", async () => {
    const s = await setup();
    await ok(
      owner.client.rpc("set_lodging_stays", {
        p_wedding: s.w,
        p_guests: [s.ada],
        p_kind: "not_staying",
      }),
    );
    await ok(
      s.submit(s.v.version, [
        {
          memberId: s.adaM,
          status: "accepted",
          mealOptionId: null,
          stay: { kind: "hotel", hotelId: s.h },
        },
      ]),
    );
    expect(await stays(s.w)).toEqual([
      {
        name: "Ada Example",
        guest_kind: "hotel",
        guest_hotel_id: s.h,
        planner_kind: "not_staying",
        answered: true,
      },
    ]);
  });

  it("saves the stay of a plus-one added in the same send", async () => {
    const s = await setup(1);
    await ok(
      s.submit(
        s.v.version,
        [
          {
            memberId: s.adaM,
            status: "accepted",
            mealOptionId: null,
            stay: { kind: "hotel", hotelId: s.h },
          },
        ],
        { name: "Cy Example", mealOptionId: null, stay: { kind: "hotel", hotelId: s.h } },
      ),
    );
    expect((await stays(s.w)).map((r) => r.name)).toEqual(["Ada Example", "Cy Example"]);
  });
});

describe("refusals", () => {
  it("refuses another wedding's hotel, a hidden or archived hotel and malformed stays, saving nothing", async () => {
    const s = await setup();
    const other = await createWedding(owner);
    const foreign = await hotel(other);
    const hidden = await hotel(s.w, { name: "Hidden Inn", showToGuests: false });
    const archived = await hotel(s.w, { name: "Old Inn" });
    await ok(
      owner.client.rpc("set_lodging_hotel_archived", {
        p_wedding: s.w,
        p_hotel_id: archived,
        p_expected_version: 1,
        p_archived: true,
      }),
    );
    const bad: unknown[] = [
      { kind: "hotel", hotelId: foreign },
      { kind: "hotel", hotelId: hidden },
      { kind: "hotel", hotelId: archived },
      { kind: "hotel", hotelId: randomUUID() },
      { kind: "hotel" },
      { kind: "elsewhere", hotelId: s.h },
      { kind: "camping" },
      { kind: "hotel", hotelId: "not-a-uuid" },
      { kind: "elsewhere", extra: 1 },
      "elsewhere",
    ];
    for (const stay of bad) {
      const res = await s.submit(s.v.version, [
        { memberId: s.adaM, status: "accepted", mealOptionId: null, stay },
      ]);
      expect(res.error?.code, JSON.stringify(stay)).toBe("22023");
    }
    expect(await stays(s.w)).toEqual([]);
    // The reply itself was refused too: one bad stay refuses the whole send.
    expect((await s.read()).members.every((m) => m.status === "pending")).toBe(true);
  });

  it("the helper cannot be called by signed-in users", async () => {
    const s = await setup();
    const call = await owner.client.rpc(
      "rsvp_save_stay" as never,
      { p_member: s.adaM, p_src: { stay: { kind: "elsewhere" } } } as never,
    );
    expect(call.error).not.toBeNull();
    expect(await stays(s.w)).toEqual([]);
  });
});

describe("a party link", () => {
  it("saves one stay per person across events in one send", async () => {
    const w = await createWedding(owner);
    const g = async (name: string) =>
      (await ok(owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name } }))) as string;
    const ada = await g("Ada Example");
    const ev = async (name: string) =>
      (await ok(
        owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "other" } }),
      )) as string;
    const ids: string[] = [];
    for (const name of ["Ceremony", "Reception"]) {
      const rows = (await ok(
        owner.client.rpc("create_invitations", {
          p_wedding: w,
          p_event_id: await ev(name),
          p_groups: [{ guestIds: [ada], householdId: null }],
          p_plus_one_quota: 0,
          p_expires_at: future(30),
          p_token_hashes: [newToken().hash],
          p_idempotency_key: `key-${randomUUID()}`,
        }),
      )) as { o_invitation_id: string }[];
      ids.push(rows[0]!.o_invitation_id);
    }
    const token = newToken();
    await ok(
      owner.client.rpc("create_party_link", {
        p_wedding: w,
        p_invitation_ids: ids,
        p_expires_at: future(30),
        p_token_hash: token.hash,
        p_idempotency_key: `party-${randomUUID()}`,
      }),
    );
    const h = await hotel(w);
    const view = (
      await adminClient().rpc("rsvp_party_view", { p_token_hash: token.hash, p_client: client() })
    ).data as { events: (View & { invitationId: string })[] };
    expect(view.events.every((e) => e.hotels.length === 1)).toBe(true);
    const res = await adminClient().rpc("rsvp_party_submit", {
      p_token_hash: token.hash,
      p_client: client(),
      p_replies: view.events.map((e) => ({
        invitationId: e.invitationId,
        expectedVersion: e.version,
        responses: e.members.map((m) => ({
          memberId: m.id,
          status: "accepted",
          mealOptionId: null,
          stay: { kind: "hotel", hotelId: h },
        })),
        plusOne: null,
      })),
    });
    expect(res.error).toBeNull();
    expect(await stays(w)).toEqual([
      {
        name: "Ada Example",
        guest_kind: "hotel",
        guest_hotel_id: h,
        planner_kind: null,
        answered: true,
      },
    ]);
  });
});
