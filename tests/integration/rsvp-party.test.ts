import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

// UX-06: one link per party. Real local Postgres, PostgREST and RLS.

let owner: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  owner = await createUser("party-owner");
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function n(sql: string, params: unknown[]) {
  return Number((await q<{ n: string }>(sql, params))[0]!.n);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

async function household(w: string, name: string) {
  return (
    await q<{ id: string }>(
      "insert into public.households (wedding_id, name) values ($1,$2) returning id",
      [w, name],
    )
  )[0]!.id;
}
async function guest(w: string, name: string, hh?: string) {
  return (await ok(
    owner.client.rpc("create_guest", {
      p_wedding: w,
      p_guest: { name },
      ...(hh && { p_household: hh }),
    }),
  )) as string;
}
async function event(w: string, name: string) {
  return (await ok(
    owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "other" } }),
  )) as string;
}
async function meal(w: string, e: string, name: string) {
  return (await ok(
    owner.client.rpc("add_meal_option", { p_wedding: w, p_event_id: e, p_name: name }),
  )) as string;
}
async function invite(
  w: string,
  e: string,
  guestIds: string[],
  householdId: string | null,
  opts: { quota?: number; deadline?: string; expires?: string } = {},
) {
  const t = newToken();
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: e,
      p_groups: [{ guestIds, householdId }],
      p_plus_one_quota: opts.quota ?? 0,
      p_expires_at: opts.expires ?? future(30),
      p_token_hashes: [t.hash],
      p_idempotency_key: `key-${randomUUID()}`,
      ...(opts.deadline && { p_deadline: opts.deadline }),
    }),
  )) as { o_invitation_id: string }[];
  return { id: rows[0]!.o_invitation_id, token: t };
}
function makeParty(
  u: TestUser,
  w: string,
  ids: string[],
  opts: { key?: string; expires?: string; token?: { hash: string } } = {},
) {
  const t = opts.token ?? newToken();
  return u.client.rpc("create_party_link", {
    p_wedding: w,
    p_invitation_ids: ids,
    p_expires_at: opts.expires ?? future(30),
    p_token_hash: t.hash,
    p_idempotency_key: opts.key ?? `party-${randomUUID()}`,
  });
}

type PEvent = {
  invitationId: string;
  version: number;
  closed: boolean;
  plusOneRemaining: number;
  event: { name: string };
  mealOptions: { id: string; name: string }[];
  members: {
    id: string;
    name: string;
    status: string;
    mealOptionId: string | null;
    isPlusOne: boolean;
  }[];
};
type PView = { workspaceId: string; weddingName: string; label: string; events: PEvent[] };

async function partyView(raw: string, c = client()) {
  const r = await adminClient().rpc("rsvp_party_view", { p_token_hash: sha(raw), p_client: c });
  return { ...r, view: r.data as PView | null };
}
function partySubmit(raw: string, replies: unknown, c = client()) {
  return adminClient().rpc("rsvp_party_submit", {
    p_token_hash: sha(raw),
    p_client: c,
    p_replies: replies,
  });
}
const reply = (
  e: PEvent,
  answers: Record<string, "accepted" | "declined">,
  meals: Record<string, string> = {},
  plusOne: { name: string; mealOptionId: string | null } | null = null,
) => ({
  invitationId: e.invitationId,
  expectedVersion: e.version,
  responses: e.members
    .filter((m) => answers[m.name])
    .map((m) => ({ memberId: m.id, status: answers[m.name], mealOptionId: meals[m.name] ?? null })),
  plusOne,
});

/** The Examples (Ada, Bo) invited to Ceremony and Reception (meals, one plus-one place). */
async function setup(opts: { receptionDeadline?: string } = {}) {
  const w = await createWedding(owner, { name: "Party (example)" });
  const hh = await household(w, "The Examples");
  const ada = await guest(w, "Ada Example", hh);
  const bo = await guest(w, "Bo Example", hh);
  const ceremony = await event(w, "Ceremony");
  const reception = await event(w, "Reception");
  const chicken = await meal(w, reception, "Chicken");
  const c = await invite(w, ceremony, [ada, bo], hh, { quota: 1 });
  const r = await invite(w, reception, [ada, bo], hh, {
    quota: 1,
    ...(opts.receptionDeadline && { deadline: opts.receptionDeadline }),
  });
  const token = newToken();
  const made = await makeParty(owner, w, [c.id, r.id], { token });
  if (made.error) throw new Error(made.error.message);
  const v = (await partyView(token.raw)).view!;
  const byName = (name: string) => v.events.find((e) => e.event.name === name)!;
  return {
    w,
    hh,
    ada,
    bo,
    ceremony,
    reception,
    chicken,
    c,
    r,
    token,
    partyId: (made.data as { o_party_id: string }[])[0]!.o_party_id,
    v,
    cer: byName("Ceremony"),
    rec: byName("Reception"),
  };
}

const statuses = (w: string) =>
  q<{ event: string; name: string; rsvp_status: string; meal: string | null }>(
    `select e.name event, g.full_name name, im.rsvp_status, mo.name meal
       from public.invitation_members im
       join public.events e on e.id = im.event_id
       join public.guests g on g.id = im.guest_id
       left join public.meal_options mo on mo.id = im.meal_option_id
      where im.wedding_id = $1 and im.active order by e.name, g.full_name`,
    [w],
  );

describe("creating a party link", () => {
  it("groups the household's invitations; the view shows both events and only their members", async () => {
    const s = await setup();
    expect(s.v.label).toBe("The Examples");
    expect(s.v.events.map((e) => e.event.name).sort()).toEqual(["Ceremony", "Reception"]);
    for (const e of s.v.events) {
      expect(e.members.map((m) => m.name)).toEqual(["Ada Example", "Bo Example"]);
    }
    expect(s.rec.mealOptions.map((m) => m.name)).toEqual(["Chicken"]);
    // No contact details, household id, tokens or other households anywhere in the projection.
    const text = JSON.stringify(s.v);
    expect(text).not.toMatch(/email|phone|address|token|household/i);
    // workspaceId is stripped by the server before anything reaches the guest.
    expect(Object.keys(s.v).sort()).toEqual(["events", "label", "weddingName", "workspaceId"]);
    // An audit row without names.
    const audit = await q<{ safe_changes: unknown }>(
      "select safe_changes from public.audit_events where wedding_id=$1 and action='invitation_party.created'",
      [s.w],
    );
    expect(audit).toEqual([{ safe_changes: { invitations: 2 } }]);
  });

  it("replays the same key to the same party and writes nothing new", async () => {
    const w = await createWedding(owner);
    const hh = await household(w, "Replay");
    const a = await guest(w, "Cy Example", hh);
    const e1 = await event(w, "One");
    const e2 = await event(w, "Two");
    const i1 = await invite(w, e1, [a], hh);
    const i2 = await invite(w, e2, [a], hh);
    const key = `party-${randomUUID()}`;
    const expires = future(20);
    const first = await makeParty(owner, w, [i1.id, i2.id], { key, expires });
    const again = await makeParty(owner, w, [i2.id, i1.id], { key, expires });
    expect(first.error).toBeNull();
    expect(again.error).toBeNull();
    const [f] = first.data as { o_party_id: string; o_replayed: boolean }[];
    const [g] = again.data as { o_party_id: string; o_replayed: boolean }[];
    expect(g!.o_party_id).toBe(f!.o_party_id);
    expect([f!.o_replayed, g!.o_replayed]).toEqual([false, true]);
    expect(
      await n("select count(*) n from public.invitation_parties where wedding_id=$1", [w]),
    ).toBe(1);
  });

  it("refuses invalid groupings and writes nothing", async () => {
    const w = await createWedding(owner);
    const h1 = await household(w, "One house");
    const h2 = await household(w, "Other house");
    const a = await guest(w, "Ada Example", h1);
    const b = await guest(w, "Bo Example", h2);
    const solo1 = await guest(w, "Cy Example");
    const solo2 = await guest(w, "Di Example");
    const e1 = await event(w, "One");
    const e2 = await event(w, "Two");
    const e3 = await event(w, "Three");
    const a1 = await invite(w, e1, [a], h1);
    const a2 = await invite(w, e2, [a], h1);
    const b3 = await invite(w, e3, [b], h2);
    const c1 = await invite(w, e1, [solo1], null);
    const d2 = await invite(w, e2, [solo2], null);
    const c3 = await invite(w, e3, [solo1], null);
    const late = await guest(w, "Ed Example", h1);
    const a1b = await invite(w, e1, [late], h1);

    const cases: [string, string[], string][] = [
      ["one invitation", [a1.id], "22023"],
      ["two households", [a1.id, b3.id], "22023"],
      ["household and no household", [a2.id, c3.id], "22023"],
      ["different people without a household", [c1.id, d2.id], "22023"],
      ["same event twice", [a1.id, a1b.id], "22023"],
      ["unknown invitation", [a1.id, randomUUID()], "42501"],
      ["duplicate id", [a1.id, a1.id], "22023"],
    ];
    for (const [label, ids, code] of cases) {
      const r = await makeParty(owner, w, ids);
      expect(r.error?.code, label).toBe(code);
    }
    // A revoked or expired invitation can't join.
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: w,
        p_invitation_id: a2.id,
        p_expected_version: 1,
      }),
    );
    expect((await makeParty(owner, w, [a1.id, a2.id])).error?.code).toBe("22023");
    // Bad expiry and token digest.
    expect((await makeParty(owner, w, [c1.id, c3.id], { expires: future(-1) })).error?.code).toBe(
      "22023",
    );
    expect(
      (await makeParty(owner, w, [c1.id, c3.id], { token: { hash: "nope" } })).error?.code,
    ).toBe("22023");
    expect(
      await n("select count(*) n from public.invitation_parties where wedding_id=$1", [w]),
    ).toBe(0);
    expect(
      await n(
        "select count(*) n from public.invitations where wedding_id=$1 and party_id is not null",
        [w],
      ),
    ).toBe(0);
    // Same person without a household is fine.
    expect((await makeParty(owner, w, [c1.id, c3.id])).error).toBeNull();
  });

  it("refuses an invitation already in a live party link, but allows it after a revoke", async () => {
    const s = await setup();
    expect((await makeParty(owner, s.w, [s.c.id, s.r.id])).error?.code).toBe("23505");
    await ok(
      owner.client.rpc("revoke_party_link", {
        p_wedding: s.w,
        p_party_id: s.partyId,
        p_expected_version: 1,
      }),
    );
    expect((await makeParty(owner, s.w, [s.c.id, s.r.id])).error).toBeNull();
  });

  it("refuses invitations from another wedding", async () => {
    const s = await setup();
    const other = await createWedding(owner);
    const r = await makeParty(owner, other, [s.c.id, s.r.id]);
    expect(r.error?.code).toBe("42501");
  });
});

describe("answering through a party link", () => {
  it("saves every event in one send, through the same rows the per-event links use", async () => {
    const s = await setup();
    const res = await partySubmit(s.token.raw, [
      reply(s.cer, { "Ada Example": "accepted", "Bo Example": "accepted" }),
      reply(
        s.rec,
        { "Ada Example": "accepted", "Bo Example": "declined" },
        { "Ada Example": s.chicken },
      ),
    ]);
    expect(res.error).toBeNull();
    expect(await statuses(s.w)).toEqual([
      { event: "Ceremony", name: "Ada Example", rsvp_status: "accepted", meal: null },
      { event: "Ceremony", name: "Bo Example", rsvp_status: "accepted", meal: null },
      { event: "Reception", name: "Ada Example", rsvp_status: "accepted", meal: "Chicken" },
      { event: "Reception", name: "Bo Example", rsvp_status: "declined", meal: null },
    ]);
    // Four history rows, all from the guest; one audit row per event, flagged as the party link.
    expect(
      await n(
        "select count(*) n from public.rsvp_changes where wedding_id=$1 and source='guest' and actor_id is null",
        [s.w],
      ),
    ).toBe(4);
    const audits = await q<{ safe_changes: Record<string, unknown> }>(
      "select safe_changes from public.audit_events where wedding_id=$1 and action='rsvp.responded' order by entity_id",
      [s.w],
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.safe_changes.party_link === true)).toBe(true);
    // The per-event link shows the same answers.
    const single = await adminClient().rpc("rsvp_view", {
      p_token_hash: s.r.token.hash,
      p_client: client(),
    });
    const members = (single.data as PEvent).members.map((m) => [m.name, m.status]);
    expect(members).toEqual([
      ["Ada Example", "accepted"],
      ["Bo Example", "declined"],
    ]);
  });

  it("writes nothing when a retry changes nothing", async () => {
    const s = await setup();
    const replies = [reply(s.cer, { "Ada Example": "accepted" })];
    await ok(partySubmit(s.token.raw, replies));
    const before = await q("select revision from public.weddings where id=$1", [s.w]);
    const v2 = (await partyView(s.token.raw)).view!;
    const cer2 = v2.events.find((e) => e.event.name === "Ceremony")!;
    expect(
      (await partySubmit(s.token.raw, [reply(cer2, { "Ada Example": "accepted" })])).error,
    ).toBeNull();
    expect(await q("select revision from public.weddings where id=$1", [s.w])).toEqual(before);
    expect(await n("select count(*) n from public.rsvp_changes where wedding_id=$1", [s.w])).toBe(
      1,
    );
  });

  it("refuses the whole send when one event is stale, and saves nothing", async () => {
    const s = await setup();
    // Someone answers the reception through its own link first.
    await ok(
      adminClient().rpc("rsvp_submit", {
        p_token_hash: s.r.token.hash,
        p_client: client(),
        p_expected_version: s.rec.version,
        p_responses: [{ memberId: s.rec.members[0]!.id, status: "declined", mealOptionId: null }],
      }),
    );
    const res = await partySubmit(s.token.raw, [
      reply(s.cer, { "Ada Example": "accepted" }),
      reply(s.rec, { "Bo Example": "accepted" }),
    ]);
    expect(res.error?.code).toBe("55000");
    const rows = await statuses(s.w);
    expect(rows.filter((r) => r.event === "Ceremony").map((r) => r.rsvp_status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(rows.filter((r) => r.event === "Reception").map((r) => r.rsvp_status)).toEqual([
      "declined",
      "pending",
    ]);
  });

  it("refuses a closed event (RS410) and saves nothing; leaving it out saves the rest", async () => {
    const s = await setup({ receptionDeadline: future(1) });
    await q("update public.invitations set deadline = now() - interval '1 minute' where id=$1", [
      s.r.id,
    ]);
    const v = (await partyView(s.token.raw)).view!;
    const rec = v.events.find((e) => e.event.name === "Reception")!;
    const cer = v.events.find((e) => e.event.name === "Ceremony")!;
    expect([rec.closed, cer.closed]).toEqual([true, false]);
    const both = await partySubmit(s.token.raw, [
      reply(cer, { "Ada Example": "accepted" }),
      reply(rec, { "Ada Example": "accepted" }),
    ]);
    expect(both.error?.code).toBe("RS410");
    expect(await n("select count(*) n from public.rsvp_changes where wedding_id=$1", [s.w])).toBe(
      0,
    );
    expect(
      (await partySubmit(s.token.raw, [reply(cer, { "Ada Example": "accepted" })])).error,
    ).toBeNull();
    expect(await n("select count(*) n from public.rsvp_changes where wedding_id=$1", [s.w])).toBe(
      1,
    );
  });

  it("refuses forged and malformed payloads and saves nothing", async () => {
    const s = await setup();
    const other = await setup();
    const valid = reply(s.cer, { "Ada Example": "accepted" });
    const cases: [string, unknown][] = [
      ["another party's invitation", [valid, reply(other.rec, { "Ada Example": "accepted" })]],
      [
        "a member of the other event",
        [
          valid,
          {
            ...reply(s.rec, {}),
            responses: [{ memberId: s.cer.members[1]!.id, status: "accepted", mealOptionId: null }],
          },
        ],
      ],
      ["the same invitation twice", [valid, valid]],
      [
        "a meal from another event",
        [
          valid,
          {
            ...reply(s.cer, {}),
            responses: [
              { memberId: s.cer.members[1]!.id, status: "accepted", mealOptionId: other.chicken },
            ],
          },
        ],
      ],
      [
        "an empty entry",
        [
          valid,
          {
            invitationId: s.rec.invitationId,
            expectedVersion: s.rec.version,
            responses: [],
            plusOne: null,
          },
        ],
      ],
      ["no entries", []],
      ["not an array", { invitationId: s.cer.invitationId }],
      ["a bad status", [{ ...valid, responses: [{ ...valid.responses[0], status: "pending" }] }]],
      ["a text version", [{ ...valid, expectedVersion: "1" }]],
      [
        "no responses array",
        [{ invitationId: s.cer.invitationId, expectedVersion: s.cer.version }],
      ],
    ];
    for (const [label, payload] of cases) {
      const res = await partySubmit(s.token.raw, payload);
      expect(res.error?.code, label).toBe("22023");
    }
    expect(await n("select count(*) n from public.rsvp_changes where wedding_id=$1", [s.w])).toBe(
      0,
    );
    expect(
      await n("select count(*) n from public.rsvp_changes where wedding_id=$1", [other.w]),
    ).toBe(0);
  });

  it("makes one guest for a plus-one named on two events, and none more on retry", async () => {
    const s = await setup();
    const p = (meal: string | null) => ({ name: "  Cy   Example ", mealOptionId: meal });
    await ok(
      partySubmit(s.token.raw, [
        reply(s.cer, { "Ada Example": "accepted" }, {}, p(null)),
        reply(s.rec, { "Ada Example": "accepted" }, {}, { ...p(s.chicken), name: "cy example" }),
      ]),
    );
    const plus = await q<{ id: string; full_name: string; household_id: string }>(
      "select id, full_name, household_id from public.guests where wedding_id=$1 and 'plus-one' = any(tags)",
      [s.w],
    );
    expect(plus).toHaveLength(1);
    expect(plus[0]).toMatchObject({ full_name: "Cy Example", household_id: s.hh });
    expect(
      await n(
        "select count(*) n from public.invitation_members where guest_id=$1 and active and rsvp_status='accepted'",
        [plus[0]!.id],
      ),
    ).toBe(2);
    // Retry with fresh versions: no new guest, no new members, quota used once per event.
    const v = (await partyView(s.token.raw)).view!;
    await ok(
      partySubmit(
        s.token.raw,
        v.events.map((e) => reply(e, { "Ada Example": "accepted" }, {}, p(null))),
      ),
    );
    expect(await n("select count(*) n from public.guests where wedding_id=$1", [s.w])).toBe(3);
    expect(
      await n(
        "select count(*) n from public.invitation_members where wedding_id=$1 and is_plus_one",
        [s.w],
      ),
    ).toBe(2);
    expect(
      (
        await q<{ plus_ones_used: number }>(
          "select plus_ones_used from public.invitations where party_id=$1 order by id",
          [s.partyId],
        )
      ).map((r) => r.plus_ones_used),
    ).toEqual([1, 1]);
  });

  it("refuses a second plus-one when the place is used, and saves nothing for the other event", async () => {
    const s = await setup();
    await ok(
      partySubmit(s.token.raw, [
        reply(s.rec, { "Ada Example": "accepted" }, {}, { name: "Cy Example", mealOptionId: null }),
      ]),
    );
    const v = (await partyView(s.token.raw)).view!;
    const res = await partySubmit(
      s.token.raw,
      v.events.map((e) =>
        reply(
          e,
          { "Bo Example": "accepted" },
          {},
          e.event.name === "Reception" ? { name: "Di Example", mealOptionId: null } : null,
        ),
      ),
    );
    expect(res.error?.code).toBe("RS422");
    const cer = (await statuses(s.w)).filter((r) => r.event === "Ceremony");
    expect(cer.map((r) => r.rsvp_status)).toEqual(["pending", "pending"]);
  });

  it("exactly one of two sends at the same version wins", async () => {
    const s = await setup();
    const results = await Promise.all([
      partySubmit(s.token.raw, [
        reply(s.cer, { "Ada Example": "accepted" }),
        reply(s.rec, { "Ada Example": "accepted" }),
      ]),
      partySubmit(s.token.raw, [
        reply(s.cer, { "Ada Example": "declined" }),
        reply(s.rec, { "Ada Example": "declined" }),
      ]),
    ]);
    const codes = results.map((r) => r.error?.code ?? "ok").sort();
    expect(codes).toEqual(["55000", "ok"]);
    const ada = (await statuses(s.w))
      .filter((r) => r.name === "Ada Example")
      .map((r) => r.rsvp_status);
    expect(new Set(ada).size).toBe(1);
  });

  it("drops a revoked event from the link and refuses answers to it", async () => {
    const s = await setup();
    await ok(
      owner.client.rpc("revoke_invitation", {
        p_wedding: s.w,
        p_invitation_id: s.r.id,
        p_expected_version: s.rec.version,
      }),
    );
    const v = (await partyView(s.token.raw)).view!;
    expect(v.events.map((e) => e.event.name)).toEqual(["Ceremony"]);
    expect(
      (await partySubmit(s.token.raw, [reply(s.rec, { "Ada Example": "accepted" })])).error?.code,
    ).toBe("22023");
  });
});

describe("link lifecycle and access", () => {
  it("revoking the party link stops only that link; each event's link still works", async () => {
    const s = await setup();
    await ok(
      owner.client.rpc("revoke_party_link", {
        p_wedding: s.w,
        p_party_id: s.partyId,
        p_expected_version: 1,
      }),
    );
    expect((await partyView(s.token.raw)).view).toBeNull();
    expect(
      (await partySubmit(s.token.raw, [reply(s.cer, { "Ada Example": "accepted" })])).data,
    ).toBeNull();
    const single = await adminClient().rpc("rsvp_view", {
      p_token_hash: s.c.token.hash,
      p_client: client(),
    });
    expect(single.data).not.toBeNull();
    // A stale revoke is refused.
    const again = await owner.client.rpc("revoke_party_link", {
      p_wedding: s.w,
      p_party_id: s.partyId,
      p_expected_version: 1,
    });
    expect(again.error?.code).toBe("55000");
  });

  it("a new link replaces the old one at once", async () => {
    const s = await setup();
    const fresh = newToken();
    await ok(
      owner.client.rpc("reissue_party_link", {
        p_wedding: s.w,
        p_party_id: s.partyId,
        p_expected_version: 1,
        p_token_hash: fresh.hash,
      }),
    );
    expect((await partyView(s.token.raw)).view).toBeNull();
    expect((await partyView(fresh.raw)).view?.events).toHaveLength(2);
  });

  it("an expired party link is indistinguishable from an unknown one", async () => {
    const s = await setup();
    await q(
      "update public.invitation_parties set expires_at = now() - interval '1 second' where id=$1",
      [s.partyId],
    );
    const expired = await partyView(s.token.raw);
    const unknown = await partyView(newToken().raw);
    expect([expired.data, expired.error, unknown.data, unknown.error]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("throttles repeated failed guesses", async () => {
    const c = client();
    for (let i = 0; i < 20; i++) await partyView(newToken().raw, c);
    const r = await partyView(newToken().raw, c);
    expect(r.error?.code).toBe("RS429");
  });

  it("only owner and partner manage party links; clients can't call the guest RPCs or read tokens", async () => {
    const s = await setup();
    const mk = async (role: string) => {
      const u = await createUser(`party-${role}`);
      await q("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3)", [
        s.w,
        u.id,
        role,
      ]);
      return u;
    };
    const partner = await mk("partner");
    const viewer = await mk("viewer");
    const editor = await mk("editor");
    const stranger = await createUser("party-stranger");

    for (const u of [viewer, editor, stranger]) {
      expect((await makeParty(u, s.w, [s.c.id, s.r.id])).error?.code).toBe("42501");
      const rv = await u.client.rpc("revoke_party_link", {
        p_wedding: s.w,
        p_party_id: s.partyId,
        p_expected_version: 1,
      });
      expect(rv.error?.code).toBe("42501");
      const rows = await u.client.from("invitation_parties").select("id").eq("wedding_id", s.w);
      expect(rows.data ?? []).toEqual([]);
    }
    const anon = anonClient();
    expect(
      (
        await anon.rpc("create_party_link", {
          p_wedding: s.w,
          p_invitation_ids: [s.c.id, s.r.id],
          p_expires_at: future(5),
          p_token_hash: newToken().hash,
          p_idempotency_key: `party-${randomUUID()}`,
        })
      ).error,
    ).not.toBeNull();
    for (const c of [anon, partner.client]) {
      expect(
        (await c.rpc("rsvp_party_view", { p_token_hash: s.token.hash, p_client: client() })).error,
      ).not.toBeNull();
      expect(
        (
          await c.rpc("rsvp_party_submit", {
            p_token_hash: s.token.hash,
            p_client: client(),
            p_replies: [],
          })
        ).error,
      ).not.toBeNull();
    }
    // The partner sees the party but never its token.
    const seen = await partner.client
      .from("invitation_parties")
      .select("id, label")
      .eq("wedding_id", s.w);
    expect(seen.data).toEqual([{ id: s.partyId, label: "The Examples" }]);
    expect(
      (await partner.client.from("invitation_parties").select("token_hash")).error,
    ).not.toBeNull();
    // No direct writes.
    const write = await partner.client
      .from("invitation_parties")
      .update({ label: "x" })
      .eq("id", s.partyId);
    expect(write.error).not.toBeNull();
    const link = await partner.client
      .from("invitations")
      .update({ party_id: null })
      .eq("id", s.c.id);
    expect(link.error).not.toBeNull();
    // The partner can make one for another household.
    await ok(
      owner.client.rpc("revoke_party_link", {
        p_wedding: s.w,
        p_party_id: s.partyId,
        p_expected_version: 1,
      }),
    );
    expect((await makeParty(partner, s.w, [s.c.id, s.r.id])).error).toBeNull();
  });
});
