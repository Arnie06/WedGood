import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-04: comparisons can start from an event's planning number and be repriced as a COPY.
// The saved comparison (count, ratings, decision) is a record and never changes by itself.

let owner: TestUser;

const CRITERIA = [
  { id: "style", label: "Style", weight: 6 },
  { id: "service", label: "Service", weight: 4 },
];

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data;
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
async function addEvent(user: TestUser, w: string, name = "Reception") {
  return (await ok(
    user.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "reception" } }),
  )) as string;
}
async function twoQuotes(user: TestUser, w: string) {
  const out: string[] = [];
  for (const name of ["Garden House", "Barn"]) {
    const cand = (await ok(
      user.client.rpc("create_candidate", {
        p_wedding: w,
        p_kind: "venue",
        p_category: "venue",
        p_name: name,
      }),
    )) as string;
    out.push(
      (await ok(
        user.client.rpc("create_proposal", { p_wedding: w, p_candidate: cand, p_title: "Package" }),
      )) as string,
    );
  }
  return out as [string, string];
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
    p_guest_count: 110,
    p_proposals: proposals,
    p_criteria: CRITERIA,
    ...extra,
  });
}
function reprice(
  user: TestUser,
  w: string,
  cmp: string,
  guests: number,
  key: string = randomUUID(),
) {
  return user.client.rpc("reprice_comparison", {
    p_wedding: w,
    p_comparison: cmp,
    p_guest_count: guests,
    p_idempotency_key: key,
  });
}
type Row = {
  title: string;
  version: number;
  scenario_guest_count: number;
  count_event_id: string | null;
  criteria: unknown;
  accepts_unknowns: boolean;
  archived_at: string | null;
};
async function row(id: string): Promise<Row> {
  return withSuperuser(async (db) => {
    const r = await db.query<Row>(
      "select title, version, scenario_guest_count, count_event_id, criteria, accepts_unknowns, archived_at::text from public.comparisons where id=$1",
      [id],
    );
    const found = r.rows[0];
    if (!found) throw new Error("missing");
    return found;
  });
}
async function options(cmp: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      proposal_id: string;
      position: number;
      ratings: Record<string, number>;
    }>(
      "select proposal_id, position, ratings from public.comparison_options where comparison_id=$1 order by position",
      [cmp],
    );
    return r.rows;
  });
}
async function n(sql: string, params: unknown[]): Promise<number> {
  return withSuperuser(async (db) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n),
  );
}
const comparisonCount = (w: string) =>
  n("select count(*) n from public.comparisons where wedding_id=$1", [w]);

/** A comparison started from an event, with one rating on its first option. */
async function followed(w: string, event: string, guests = 110) {
  const [a, b] = await twoQuotes(owner, w);
  const id = (await ok(
    create(owner, w, [a, b], { p_guest_count: guests, p_count_event: event }),
  )) as string;
  const first = await options(id);
  const optionId = await withSuperuser(
    async (db) =>
      (
        await db.query<{ id: string }>(
          "select id from public.comparison_options where comparison_id=$1 and position=0",
          [id],
        )
      ).rows[0]?.id,
  );
  await ok(
    owner.client.rpc("set_comparison_ratings", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: 1,
      p_ratings: { [optionId as string]: { style: 70 } },
    }),
  );
  return { id, a, b, first };
}

beforeAll(async () => {
  owner = await createUser("reprice-owner");
});

describe("create_comparison with an event", () => {
  it("stores the event it started from, and nothing when it did not", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const [a, b] = await twoQuotes(owner, w);
    const withEvent = (await ok(create(owner, w, [a, b], { p_count_event: event }))) as string;
    const without = (await ok(create(owner, w, [a, b]))) as string;
    expect((await row(withEvent)).count_event_id).toBe(event);
    expect((await row(without)).count_event_id).toBeNull();
    const audit = await n(
      "select count(*) n from public.audit_events where entity_id=$1 and safe_changes->>'fromEvent'='true'",
      [withEvent],
    );
    expect(audit).toBe(1);
  });

  it("refuses another wedding's event and writes nothing", async () => {
    const w = await createWedding(owner);
    const other = await createUser("reprice-other");
    const w2 = await createWedding(other);
    const foreign = await addEvent(other, w2);
    const [a, b] = await twoQuotes(owner, w);
    const r = await create(owner, w, [a, b], { p_count_event: foreign });
    expect(r.error?.code).toBe("22023");
    expect(await comparisonCount(w)).toBe(0);
    const unknown = await create(owner, w, [a, b], { p_count_event: randomUUID() });
    expect(unknown.error?.code).toBe("22023");
  });

  it("treats the event as part of the request for idempotency", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const [a, b] = await twoQuotes(owner, w);
    const key = randomUUID();
    const first = await ok(
      create(owner, w, [a, b], { p_count_event: event, p_idempotency_key: key }),
    );
    const again = await ok(
      create(owner, w, [a, b], { p_count_event: event, p_idempotency_key: key }),
    );
    expect(again).toBe(first);
    const changed = await create(owner, w, [a, b], { p_idempotency_key: key });
    expect(changed.error?.code).toBe("23505");
    expect(await comparisonCount(w)).toBe(1);
  });
});

describe("update_comparison and the event link", () => {
  it("keeps the link while the count is unchanged and drops it when the count is typed over", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    const v = (await row(id)).version;
    const update = (guests: number, title = "Venues") =>
      owner.client.rpc("update_comparison", {
        p_wedding: w,
        p_comparison: id,
        p_expected_version: v,
        p_title: title,
        p_guest_count: guests,
        p_criteria: CRITERIA,
        p_accepts_unknowns: false,
      });
    expect((await update(110, "Renamed")).error).toBeNull();
    const renamed = await row(id);
    expect(renamed.count_event_id).toBe(event);
    expect(renamed.title).toBe("Renamed");

    const typed = await owner.client.rpc("update_comparison", {
      p_wedding: w,
      p_comparison: id,
      p_expected_version: renamed.version,
      p_title: "Renamed",
      p_guest_count: 130,
      p_criteria: CRITERIA,
      p_accepts_unknowns: false,
    });
    expect(typed.error).toBeNull();
    const after = await row(id);
    expect(after.scenario_guest_count).toBe(130);
    expect(after.count_event_id).toBeNull();
  });
});

describe("reprice_comparison", () => {
  it("makes a copy at the new count and leaves the original and its decision alone", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id, a } = await followed(w, event, 110);
    await ok(
      owner.client.rpc("decide_comparison", {
        p_wedding: w,
        p_comparison: id,
        p_expected_version: 2,
        p_proposal: a,
        p_figures: { totals: [] },
        p_acknowledged: false,
      }),
    );
    const stateBefore = await ok(
      owner.client.rpc("comparison_source_state", { p_wedding: w, p_comparison: id }),
    );
    const before = await row(id);

    const copyId = (await ok(reprice(owner, w, id, 96))) as string;
    expect(copyId).not.toBe(id);

    const copy = await row(copyId);
    expect(copy.scenario_guest_count).toBe(96);
    expect(copy.title).toBe("Venues (for 96 guests)");
    expect(copy.count_event_id).toBe(event);
    expect(copy.criteria).toEqual(before.criteria);
    expect(copy.accepts_unknowns).toBe(before.accepts_unknowns);
    expect(copy.version).toBe(1);
    expect(await options(copyId)).toEqual(await options(id));
    expect((await options(copyId))[0]?.ratings).toEqual({ style: 70 });
    expect(
      await n("select count(*) n from public.decisions where comparison_id=$1", [copyId]),
    ).toBe(0);

    // The original is byte-for-byte what it was, and its decision is not stale.
    expect(await row(id)).toEqual(before);
    expect(
      await ok(owner.client.rpc("comparison_source_state", { p_wedding: w, p_comparison: id })),
    ).toEqual(stateBefore);
    expect(
      await n(
        "select count(*) n from public.decisions where comparison_id=$1 and superseded_at is null",
        [id],
      ),
    ).toBe(1);
    expect(
      await n(
        "select count(*) n from public.audit_events where entity_id=$1 and action='comparison.repriced' and safe_changes->>'guestCount'='96' and safe_changes->>'was'='110'",
        [copyId],
      ),
    ).toBe(1);
  });

  it("does not stack the title suffix when a copy is repriced again", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    const first = (await ok(reprice(owner, w, id, 96))) as string;
    const second = (await ok(reprice(owner, w, first, 90))) as string;
    expect((await row(second)).title).toBe("Venues (for 90 guests)");
  });

  it("keeps a long title inside the 160-character limit", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const [a, b] = await twoQuotes(owner, w);
    const id = (await ok(
      create(owner, w, [a, b], { p_title: "x".repeat(160), p_count_event: event }),
    )) as string;
    const copy = await row((await ok(reprice(owner, w, id, 96))) as string);
    expect(copy.title.length).toBeLessThanOrEqual(160);
    expect(copy.title.endsWith(" (for 96 guests)")).toBe(true);
  });

  it("is idempotent, also under concurrent submits, and rejects a changed payload", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    const key = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => reprice(owner, w, id, 96, key)));
    const ids = new Set(results.map((r) => r.data));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(ids.size).toBe(1);
    expect(await comparisonCount(w)).toBe(2);
    expect((await reprice(owner, w, id, 97, key)).error?.code).toBe("23505");
    expect(await comparisonCount(w)).toBe(2);
  });

  it("refuses a comparison with no event, bad counts and short keys, leaving nothing behind", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const [a, b] = await twoQuotes(owner, w);
    const plain = (await ok(create(owner, w, [a, b]))) as string;
    const { id } = await followed(w, event);
    const total = await comparisonCount(w);
    expect((await reprice(owner, w, plain, 96)).error?.code).toBe("22023");
    expect((await reprice(owner, w, id, 0)).error?.code).toBe("22023");
    expect((await reprice(owner, w, id, 100001)).error?.code).toBe("22023");
    expect((await reprice(owner, w, id, 96, "short")).error?.code).toBe("22023");
    expect(await comparisonCount(w)).toBe(total);
  });

  it("refuses when a quote is no longer open or the source was removed", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id, b } = await followed(w, event);
    const total = await comparisonCount(w);
    await ok(
      owner.client.rpc("archive_proposal", { p_wedding: w, p_proposal: b, p_expected_version: 1 }),
    );
    expect((await reprice(owner, w, id, 96)).error?.code).toBe("22023");
    expect(await comparisonCount(w)).toBe(total);

    const w2 = await createWedding(owner);
    const e2 = await addEvent(owner, w2);
    const second = await followed(w2, e2);
    await ok(
      owner.client.rpc("archive_comparison", {
        p_wedding: w2,
        p_comparison: second.id,
        p_expected_version: (await row(second.id)).version,
      }),
    );
    expect((await reprice(owner, w2, second.id, 96)).error?.code).toBe("55000");
  });

  it("cannot reach another wedding's comparison", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    const other = await createUser("reprice-foreign");
    const w2 = await createWedding(other);
    expect((await reprice(other, w2, id, 96)).error?.code).toBe("42501");
    expect((await reprice(owner, w, randomUUID(), 96)).error?.code).toBe("42501");
    expect(await comparisonCount(w2)).toBe(0);
  });

  it("lets owner and partner reprice; denies editor, viewer, outsider and anon", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    const partner = await addMember(w, "partner", "reprice-partner");
    const editor = await addMember(w, "editor", "reprice-editor");
    const viewer = await addMember(w, "viewer", "reprice-viewer");
    const outsider = await createUser("reprice-outsider");
    const anon = { id: "", email: "", client: anonClient() };
    const total = await comparisonCount(w);
    for (const u of [editor, viewer, outsider, anon]) {
      expect(["42501", "28000", "PGRST202"]).toContain((await reprice(u, w, id, 96)).error?.code);
    }
    expect(await comparisonCount(w)).toBe(total);
    expect((await reprice(partner, w, id, 96)).error).toBeNull();
    expect(await comparisonCount(w)).toBe(total + 1);
  });

  it("stops at the 50-comparison limit like create does", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(owner, w);
    const { id } = await followed(w, event);
    await withSuperuser((db) =>
      db.query(
        `insert into public.comparisons (wedding_id, title, scenario_guest_count, currency)
         select $1, 'filler ' || g, 10, 'USD' from generate_series(1, 49) g`,
        [w],
      ),
    );
    expect((await reprice(owner, w, id, 96)).error?.code).toBe("54000");
  });
});
