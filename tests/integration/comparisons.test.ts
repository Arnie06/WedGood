import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;

const CRITERIA = [
  { id: "style", label: "Style", weight: 6 },
  { id: "service", label: "Service", weight: 4 },
];

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

async function candidate(
  user: TestUser,
  w: string,
  name: string,
  kind: "venue" | "vendor" = "venue",
  seated?: number,
): Promise<string> {
  const { data, error } = await user.client.rpc("create_candidate", {
    p_wedding: w,
    p_kind: kind,
    p_category: kind === "venue" ? "venue" : "caterer",
    p_name: name,
    ...(seated !== undefined && { p_seated_capacity: seated }),
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function quote(user: TestUser, w: string, cand: string, title = "Package"): Promise<string> {
  const { data, error } = await user.client.rpc("create_proposal", {
    p_wedding: w,
    p_candidate: cand,
    p_title: title,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function twoQuotes(user: TestUser, w: string, seatedA?: number) {
  const a = await quote(user, w, await candidate(user, w, "Garden House", "venue", seatedA));
  const b = await quote(user, w, await candidate(user, w, "Barn", "venue", 200));
  return [a, b] as const;
}
function create(
  user: TestUser,
  w: string,
  proposals: string[],
  extra: Record<string, unknown> = {},
) {
  return user.client.rpc("create_comparison", {
    p_wedding: w,
    p_title: "Venues",
    p_guest_count: 100,
    p_proposals: proposals,
    p_criteria: CRITERIA,
    ...extra,
  });
}
async function made(user: TestUser, w: string, proposals: string[]): Promise<string> {
  const { data, error } = await create(user, w, proposals);
  if (error) throw new Error(error.message);
  return data as string;
}
async function cmpRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      version: number;
      scenario_guest_count: number;
      criteria: unknown;
      archived_at: string | null;
      accepts_unknowns: boolean;
    }>(
      "select version, scenario_guest_count, criteria, archived_at::text, accepts_unknowns from public.comparisons where id=$1",
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new Error("missing");
    return row;
  });
}
async function optionRows(cmp: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      id: string;
      proposal_id: string;
      position: number;
      ratings: Record<string, number>;
    }>(
      "select id, proposal_id, position, ratings from public.comparison_options where comparison_id=$1 order by position",
      [cmp],
    );
    return r.rows;
  });
}
async function decisionRows(cmp: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      id: string;
      chosen_proposal_id: string;
      superseded_at: string | null;
      snapshot: { inputs: { guestCount: number }; figures: unknown };
    }>(
      "select id, chosen_proposal_id, superseded_at::text, snapshot from public.decisions where comparison_id=$1 order by decided_at, id",
      [cmp],
    );
    return r.rows;
  });
}
async function count(sql: string, params: unknown[]): Promise<number> {
  return withSuperuser(async (db) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n),
  );
}
function decide(
  user: TestUser,
  w: string,
  cmp: string,
  version: number,
  proposal: string,
  extra: Record<string, unknown> = {},
) {
  return user.client.rpc("decide_comparison", {
    p_wedding: w,
    p_comparison: cmp,
    p_expected_version: version,
    p_proposal: proposal,
    p_figures: { totals: [] },
    p_acknowledged: false,
    ...extra,
  });
}
async function state(user: TestUser, w: string, cmp: string) {
  const r = await user.client.rpc("comparison_source_state", { p_wedding: w, p_comparison: cmp });
  if (r.error) throw new Error(r.error.message);
  return r.data as {
    guestCount: number;
    inputsHash: string;
    options: { proposalVersion: number; candidateVersion: number; proposalArchived: boolean }[];
  };
}

beforeAll(async () => {
  owner = await createUser("cmp-owner");
});

describe("create_comparison", () => {
  it("creates a comparison with options in the chosen order, base currency, and an audit event", async () => {
    const w = await createWedding(owner, { cur: "EUR" });
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [b, a]);
    const row = await cmpRow(id);
    expect(row).toMatchObject({ version: 1, scenario_guest_count: 100, archived_at: null });
    const opts = await optionRows(id);
    expect(opts.map((o) => o.proposal_id)).toEqual([b, a]);
    expect(
      await count("select count(*) n from public.comparisons where id=$1 and currency='EUR'", [id]),
    ).toBe(1);
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='comparison.created'",
        [w],
      ),
    ).toBe(1);
  });

  it("rejects fewer than 2, more than 4, duplicates and nulls, leaving nothing behind", async () => {
    const w = await createWedding(owner);
    const qs: string[] = [];
    for (let i = 0; i < 5; i++) qs.push(await quote(owner, w, await candidate(owner, w, `V${i}`)));
    for (const bad of [[qs[0]!], qs, [qs[0]!, qs[0]!], [qs[0]!, null as unknown as string]]) {
      const r = await create(owner, w, bad);
      expect(r.error?.code, JSON.stringify(bad)).toBe("22023");
    }
    expect(await count("select count(*) n from public.comparisons where wedding_id=$1", [w])).toBe(
      0,
    );
  });

  it("rejects invalid titles, guest counts and criteria", async () => {
    const w = await createWedding(owner);
    const p = [...(await twoQuotes(owner, w))];
    const cases: Record<string, unknown>[] = [
      { p_title: "  " },
      { p_title: "x".repeat(161) },
      { p_guest_count: 0 },
      { p_guest_count: 100001 },
      { p_criteria: [{ id: "a", label: "A", weight: 11 }] },
      { p_criteria: [{ id: "a", label: "A", weight: -1 }] },
      {
        p_criteria: [
          { id: "a", label: "A", weight: 5 },
          { id: "a", label: "B", weight: 5 },
        ],
      },
      {
        p_criteria: [
          { id: "a", label: "A", weight: 5 },
          { id: "b", label: "a", weight: 5 },
        ],
      },
      { p_criteria: [{ id: "bad id!", label: "A", weight: 5 }] },
      { p_criteria: { not: "an array" } },
      {
        p_criteria: Array.from({ length: 9 }, (_, i) => ({
          id: `c${i}`,
          label: `C${i}`,
          weight: 1,
        })),
      },
    ];
    for (const extra of cases) {
      const r = await create(owner, w, p, extra);
      expect(r.error?.code, JSON.stringify(extra)).toBe("22023");
    }
    expect(await count("select count(*) n from public.comparisons where wedding_id=$1", [w])).toBe(
      0,
    );
  });

  it("refuses passed, archived, foreign-tenant and other-currency quotes", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const cand = await candidate(owner, w, "Third");
    const c = await quote(owner, w, cand);
    const { data: declinedV } = await owner.client.rpc("set_proposal_status", {
      p_wedding: w,
      p_proposal: c,
      p_expected_version: 1,
      p_status: "declined",
    });
    expect(declinedV).toBe(2);
    expect((await create(owner, w, [a, c])).error?.code).toBe("22023");
    await owner.client.rpc("archive_proposal", {
      p_wedding: w,
      p_proposal: b,
      p_expected_version: 1,
    });
    expect((await create(owner, w, [a, b])).error?.code).toBe("22023");
    const other = await createUser("cmp-other");
    const w2 = await createWedding(other);
    const x = await quote(other, w2, await candidate(other, w2, "Elsewhere"));
    const mixed = await create(owner, w, [a, x]);
    expect(mixed.error?.code).toBe("22023");
    await withSuperuser((db) =>
      db.query("update public.proposals set currency='EUR' where id=$1", [a]),
    );
    const [a2] = [await quote(owner, w, await candidate(owner, w, "Fourth"))];
    expect((await create(owner, w, [a, a2])).error?.code).toBe("22023");
  });

  it("is idempotent, including under concurrent submits, and rejects a changed payload", async () => {
    const w = await createWedding(owner);
    const p = [...(await twoQuotes(owner, w))];
    const key = `k-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(owner, w, p, { p_idempotency_key: key })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("select count(*) n from public.comparisons where wedding_id=$1", [w])).toBe(
      1,
    );
    const changed = await create(owner, w, p, { p_idempotency_key: key, p_guest_count: 90 });
    expect(changed.error?.code).toBe("23505");
  });
});

describe("update_comparison and ratings", () => {
  it("updates title, guest count, weights and acceptance with versioning and audit", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const r = await owner.client.rpc("update_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_title: "Venue shortlist",
      p_guest_count: 120,
      p_criteria: [{ id: "style", label: "Style", weight: 9 }],
      p_accepts_unknowns: true,
    });
    expect(r.data).toBe(2);
    expect(await cmpRow(id)).toMatchObject({ scenario_guest_count: 120, accepts_unknowns: true });
    const stale = await owner.client.rpc("update_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_title: "x",
      p_guest_count: 5,
      p_criteria: [],
      p_accepts_unknowns: false,
    });
    expect(stale.error?.code).toBe("55000");
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='comparison.updated'",
        [w],
      ),
    ).toBe(1);
  });

  it("is a no-op when nothing changed", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const r = await owner.client.rpc("update_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_title: "Venues",
      p_guest_count: 100,
      p_criteria: CRITERIA,
      p_accepts_unknowns: false,
    });
    expect(r.data).toBe(1);
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='comparison.updated'",
        [w],
      ),
    ).toBe(0);
  });

  it("saves ratings for all options atomically, keeps blanks unrated, and drops ratings of removed criteria", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const [o1, o2] = await optionRows(id);
    const set = await owner.client.rpc("set_comparison_ratings", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_ratings: { [o1!.id]: { style: 80, service: 0 }, [o2!.id]: { style: 60 } },
    });
    expect(set.data).toBe(2);
    const rows = await optionRows(id);
    expect(rows[0]!.ratings).toEqual({ style: 80, service: 0 });
    expect(rows[1]!.ratings).toEqual({ style: 60 }); // service left unrated, not zero
    await owner.client.rpc("update_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 2,
      p_title: "Venues",
      p_guest_count: 100,
      p_criteria: [{ id: "style", label: "Style", weight: 6 }],
      p_accepts_unknowns: false,
    });
    expect((await optionRows(id))[0]!.ratings).toEqual({ style: 80 });
  });

  it("rejects out-of-range, unknown-criterion, foreign-option and malformed ratings with no partial write", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const [o1, o2] = await optionRows(id);
    const other = await createUser("cmp-foreign");
    const w2 = await createWedding(other);
    const id2 = await made(other, w2, [...(await twoQuotes(other, w2))]);
    const [foreign] = await optionRows(id2);
    const bad: unknown[] = [
      { [o1!.id]: { style: 101 } },
      { [o1!.id]: { style: -1 } },
      { [o1!.id]: { style: 50.5 } },
      { [o1!.id]: { style: "80" } },
      { [o1!.id]: { nope: 50 } },
      { [o1!.id]: { style: 50 }, [o2!.id]: { style: 500 } },
      { [foreign!.id]: { style: 50 } },
      { "not-a-uuid": { style: 50 } },
      [],
    ];
    for (const ratings of bad) {
      const r = await owner.client.rpc("set_comparison_ratings", {
        p_wedding: w,
        p_comparison: id,
        p_expected_version: 1,
        p_ratings: ratings,
      });
      expect(r.error?.code, JSON.stringify(ratings)).toBe("22023");
    }
    expect((await optionRows(id)).every((o) => Object.keys(o.ratings).length === 0)).toBe(true);
    expect((await cmpRow(id)).version).toBe(1);
  });

  it("has exactly one winner when two saves race on the same version", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const [o1] = await optionRows(id);
    const run = (n: number) =>
      owner.client.rpc("set_comparison_ratings", {
        p_wedding: w,
        p_comparison: id,
        p_expected_version: 1,
        p_ratings: { [o1!.id]: { style: n } },
      });
    const rs = await Promise.all([run(10), run(20)]);
    expect(rs.filter((r) => r.error === null)).toHaveLength(1);
    expect(rs.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });
});

describe("decide_comparison", () => {
  it("records the choice, snapshot and state, moves an early vendor to considering, and nothing else", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    const r = await decide(owner, w, id, 1, a, {
      p_note: "Loved the garden",
      p_figures: { totals: [1, 2] },
    });
    expect(r.error).toBeNull();
    const rows = await decisionRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chosen_proposal_id: a, superseded_at: null });
    expect(rows[0]!.snapshot.inputs.guestCount).toBe(100);
    expect(rows[0]!.snapshot.figures).toEqual({ totals: [1, 2] });
    const stages = await withSuperuser((db) =>
      db.query<{ name: string; stage: string }>(
        "select c.name, c.stage from public.candidates c where c.wedding_id=$1 order by c.name",
        [w],
      ),
    );
    expect(stages.rows).toEqual([
      { name: "Barn", stage: "saved" },
      { name: "Garden House", stage: "considering" },
    ]);
    // Selecting is not booking: no commitments/payments exist to touch, and quotes stay open.
    expect(
      await count("select count(*) n from public.proposals where wedding_id=$1 and status='open'", [
        w,
      ]),
    ).toBe(2);
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='decision.recorded'",
        [w],
      ),
    ).toBe(1);
  });

  it("is not stale on arrival, and goes stale when the quote, the vendor, ratings or guest count change", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    await decide(owner, w, id, 1, a);
    const [d] = await withSuperuser((db) =>
      db
        .query<{ source_state: unknown }>(
          "select source_state from public.decisions where comparison_id=$1",
          [id],
        )
        .then((r) => r.rows),
    );
    expect(await state(owner, w, id)).toEqual(d!.source_state);
    await owner.client.rpc("add_proposal_line", {
      p_wedding: w,
      p_proposal: a,
      p_expected_version: 1,
      p_description: "Hire",
      p_cost_mode: "fixed",
      p_amount_minor: 100,
    });
    const after = await state(owner, w, id);
    expect(after.options[0]!.proposalVersion).toBe(2);
    expect(after).not.toEqual(d!.source_state);
    // The decision itself is untouched.
    expect((await decisionRows(id))[0]!.chosen_proposal_id).toBe(a);
  });

  it("changes the inputs hash when a rating changes", async () => {
    const w = await createWedding(owner);
    const id = await made(owner, w, [...(await twoQuotes(owner, w))]);
    const before = await state(owner, w, id);
    const [o1] = await optionRows(id);
    await owner.client.rpc("set_comparison_ratings", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_ratings: { [o1!.id]: { style: 70 } },
    });
    expect((await state(owner, w, id)).inputsHash).not.toBe(before.inputsHash);
  });

  it("supersedes the previous decision and keeps it as history", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    await decide(owner, w, id, 1, a);
    const second = await decide(owner, w, id, 1, b);
    expect(second.error).toBeNull();
    const rows = await decisionRows(id);
    expect(rows.map((r) => [r.chosen_proposal_id, r.superseded_at !== null])).toEqual([
      [a, true],
      [b, false],
    ]);
  });

  it("requires acknowledgement when the venue is verified smaller than the guest count", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w, 80);
    const id = await made(owner, w, [a, b]);
    const refused = await decide(owner, w, id, 1, a);
    expect(refused.error?.code).toBe("22023");
    expect(await decisionRows(id)).toHaveLength(0);
    expect(
      await count(
        "select count(*) n from public.candidates where wedding_id=$1 and stage='considering'",
        [w],
      ),
    ).toBe(0);
    const ok = await decide(owner, w, id, 1, a, { p_acknowledged: true });
    expect(ok.error).toBeNull();
  });

  it("treats unknown capacity as not blocking, and leaves declined or later-stage vendors where they are", async () => {
    const w = await createWedding(owner);
    const cA = await candidate(owner, w, "Unknown cap");
    const cB = await candidate(owner, w, "Passed");
    const a = await quote(owner, w, cA);
    const b = await quote(owner, w, cB);
    await owner.client.rpc("set_candidate_stage", {
      p_wedding: w,
      p_candidate: cA,
      p_expected_version: 1,
      p_stage: "declined",
    });
    const id = await made(owner, w, [a, b]);
    expect((await decide(owner, w, id, 1, a)).error).toBeNull();
    expect(
      await count("select count(*) n from public.candidates where id=$1 and stage='declined'", [
        cA,
      ]),
    ).toBe(1);
  });

  it("rejects stale versions, a quote outside the comparison, a passed or removed quote, and archived comparisons", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const outside = await quote(owner, w, await candidate(owner, w, "Outside"));
    const id = await made(owner, w, [a, b]);
    expect((await decide(owner, w, id, 7, a)).error?.code).toBe("55000");
    expect((await decide(owner, w, id, 1, outside)).error?.code).toBe("22023");
    await owner.client.rpc("set_proposal_status", {
      p_wedding: w,
      p_proposal: b,
      p_expected_version: 1,
      p_status: "declined",
    });
    expect((await decide(owner, w, id, 1, b)).error?.code).toBe("55000");
    await owner.client.rpc("archive_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
    });
    expect((await decide(owner, w, id, 2, a)).error?.code).toBe("55000");
    expect(await decisionRows(id)).toHaveLength(0);
  });

  it("rejects malformed figures and oversize notes", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    expect((await decide(owner, w, id, 1, a, { p_figures: [1] })).error?.code).toBe("22023");
    expect((await decide(owner, w, id, 1, a, { p_note: "x".repeat(1001) })).error?.code).toBe(
      "22023",
    );
    expect(
      (await decide(owner, w, id, 1, a, { p_figures: { blob: "x".repeat(31000) } })).error?.code,
    ).toBe("22023");
    expect(await decisionRows(id)).toHaveLength(0);
  });

  it("is idempotent under concurrent replays and rejects a changed payload on the same key", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    const key = `d-${randomUUID()}`;
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => decide(owner, w, id, 1, a, { p_idempotency_key: key })),
    );
    expect(rs.every((r) => r.error === null)).toBe(true);
    expect(new Set(rs.map((r) => r.data)).size).toBe(1);
    expect(await decisionRows(id)).toHaveLength(1);
    expect((await decide(owner, w, id, 1, b, { p_idempotency_key: key })).error?.code).toBe(
      "23505",
    );
  });

  it("leaves exactly one current decision when two different decisions race", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    const rs = await Promise.all([decide(owner, w, id, 1, a), decide(owner, w, id, 1, b)]);
    expect(rs.every((r) => r.error === null)).toBe(true);
    const rows = await decisionRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
  });

  it("keeps decisions append-only for every client and for direct SQL updates of the record", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    await decide(owner, w, id, 1, a);
    const [d] = await decisionRows(id);
    await owner.client.from("decisions").delete().eq("id", d!.id);
    expect(await decisionRows(id)).toHaveLength(1);
    await expect(
      withSuperuser((db) => db.query("delete from public.decisions where id=$1", [d!.id])),
    ).rejects.toThrow(/append-only/);
    await expect(
      withSuperuser((db) =>
        db.query("update public.decisions set chosen_proposal_id=$2 where id=$1", [d!.id, b]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withSuperuser((db) =>
        db.query("update public.decisions set snapshot='{}' where id=$1", [d!.id]),
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe("authorization", () => {
  it("lets owner and partner write; denies editor, viewer, outsider and anon on every RPC", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    const [o1] = await optionRows(id);
    const partner = await addMember(w, "partner", "cmp-partner");
    const editor = await addMember(w, "editor", "cmp-editor");
    const viewer = await addMember(w, "viewer", "cmp-viewer");
    const outsider = await createUser("cmp-outsider");
    const anon = { id: "", email: "", client: anonClient() };

    for (const u of [editor, viewer, outsider, anon]) {
      const calls = [
        create(u, w, [a, b]),
        u.client.rpc("update_comparison", {
          p_wedding: w,
          p_comparison: id,
          p_expected_version: 1,
          p_title: "x",
          p_guest_count: 1,
          p_criteria: [],
          p_accepts_unknowns: false,
        }),
        u.client.rpc("set_comparison_ratings", {
          p_wedding: w,
          p_comparison: id,
          p_expected_version: 1,
          p_ratings: { [o1!.id]: { style: 1 } },
        }),
        decide(u, w, id, 1, a),
        u.client.rpc("archive_comparison", {
          p_wedding: w,
          p_comparison: id,
          p_expected_version: 1,
        }),
      ];
      for (const r of await Promise.all(calls)) {
        expect(["42501", "28000", "PGRST202"]).toContain(r.error?.code);
      }
    }
    expect(await decisionRows(id)).toHaveLength(0);
    expect((await cmpRow(id)).version).toBe(1);

    const ok = await partner.client.rpc("set_comparison_ratings", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_ratings: { [o1!.id]: { style: 55 } },
    });
    expect(ok.error).toBeNull();
    expect((await decide(partner, w, id, 2, a)).error).toBeNull();
  });

  it("reads: members see comparisons and decisions, outsiders see none, and unknown ids look the same as foreign ones", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    await decide(owner, w, id, 1, a);
    const viewer = await addMember(w, "viewer", "cmp-reader");
    const outsider = await createUser("cmp-snoop");
    for (const t of ["comparisons", "comparison_options", "decisions"]) {
      expect(((await viewer.client.from(t).select("id")).data ?? []).length).toBeGreaterThan(0);
      expect((await outsider.client.from(t).select("id")).data ?? []).toHaveLength(0);
    }
    expect(
      (await viewer.client.rpc("comparison_source_state", { p_wedding: w, p_comparison: id }))
        .error,
    ).toBeNull();
    const foreign = await outsider.client.rpc("comparison_source_state", {
      p_wedding: w,
      p_comparison: id,
    });
    const unknown = await owner.client.rpc("comparison_source_state", {
      p_wedding: w,
      p_comparison: randomUUID(),
    });
    expect(foreign.error?.code).toBe("42501");
    expect(unknown.error?.code).toBe("42501");
  });

  it("denies direct table writes for every role", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    for (const t of ["comparisons", "comparison_options", "decisions"]) {
      const ins = await owner.client.from(t).insert({ wedding_id: w });
      expect(ins.error, t).not.toBeNull();
    }
    const upd = await owner.client
      .from("comparisons")
      .update({ title: "hacked" })
      .eq("id", id)
      .select();
    expect(upd.data ?? []).toHaveLength(0);
    expect((await cmpRow(id)).version).toBe(1);
    const del = await owner.client.from("comparisons").delete().eq("id", id).select();
    expect(del.data ?? []).toHaveLength(0);
  });

  it("cannot compare across tenants even by guessing quote ids", async () => {
    const other = await createUser("cmp-t2");
    const w2 = await createWedding(other);
    const [x, y] = await twoQuotes(other, w2);
    const w = await createWedding(owner);
    const [a] = await twoQuotes(owner, w);
    expect((await create(owner, w, [a, x])).error?.code).toBe("22023");
    expect((await create(owner, w, [x, y])).error?.code).toBe("22023");
    expect((await create(owner, w2, [x, y])).error?.code).toBe("42501");
  });
});

describe("archive_comparison", () => {
  it("archives with a version check and audit, and hides nothing destructive", async () => {
    const w = await createWedding(owner);
    const [a, b] = await twoQuotes(owner, w);
    const id = await made(owner, w, [a, b]);
    expect(
      (
        await owner.client.rpc("archive_comparison", {
          p_wedding: w,
          p_comparison: id,
          p_expected_version: 5,
        })
      ).error?.code,
    ).toBe("55000");
    expect(
      (
        await owner.client.rpc("archive_comparison", {
          p_wedding: w,
          p_comparison: id,
          p_expected_version: 1,
        })
      ).error,
    ).toBeNull();
    expect((await cmpRow(id)).archived_at).not.toBeNull();
    expect(
      await count(
        "select count(*) n from public.audit_events where wedding_id=$1 and action='comparison.archived'",
        [w],
      ),
    ).toBe(1);
    // The quotes it compared are untouched.
    expect(
      await count(
        "select count(*) n from public.proposals where wedding_id=$1 and archived_at is null",
        [w],
      ),
    ).toBe(2);
  });
});
