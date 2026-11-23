import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// Fixes from the independent review of REL-01 to REL-08 (migration 20261220090000_review_fixes).

let owner: TestUser;

beforeAll(async () => {
  owner = await createUser("review-fixes-owner");
});

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as NonNullable<T>;
}
const addEvent = async (w: string, extra: Record<string, unknown> = {}) =>
  (await ok(
    owner.client.rpc("create_event", {
      p_wedding: w,
      p_event: { name: "Reception", kind: "reception", ...extra },
    }),
  )) as string;
const venue = async (w: string, name: string) =>
  (await ok(
    owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: name,
    }),
  )) as string;
const setLoc = (w: string, event: string, version: number, v: string | null) =>
  owner.client.rpc("set_event_location", {
    p_wedding: w,
    p_event: event,
    p_expected_version: version,
    ...(v && { p_candidate: v }),
  });

describe("an attending cost is priced by who is attending", () => {
  it("event_yes ignores the plan; the planning number still takes the larger of plan and replies", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w, { targetAttendance: 120 });
    const cat = (await ok(
      owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Food" }),
    )) as string;
    const make = async (source: string) =>
      (await ok(
        owner.client.rpc("create_budget_item", {
          p_wedding: w,
          p_category: cat,
          p_name: source,
          p_cost_mode: "per_guest",
          p_amount_minor: 9_500,
          p_count_source: source,
          p_count_event: event,
        }),
      )) as string;
    const yes = await make("event_yes");
    const planned = await make("event_plan");
    const rows = (await ok(owner.client.rpc("budget_item_counts", { p_wedding: w }))) as {
      item_id: string;
      item_count: number | null;
      plan_count: number | null;
    }[];
    // Nobody is invited: attending is unknown (not the plan, not zero); the plan still prices the other.
    expect(rows.find((r) => r.item_id === yes)).toMatchObject({
      item_count: null,
      plan_count: 120,
    });
    expect(rows.find((r) => r.item_id === planned)).toMatchObject({ item_count: 120 });
  });
});

describe("a place version is never reused", () => {
  it("a save made before the place was cleared and set again is refused", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w);
    const barn = await venue(w, "Old Barn");
    const hall = await venue(w, "Town Hall");

    const first = (await ok(setLoc(w, event, 0, barn))) as { version: number };
    expect(first.version).toBe(1);
    // Another person clears it, then a third sets a different venue.
    expect(((await ok(setLoc(w, event, 1, null))) as { version: number }).version).toBe(0);
    const again = (await ok(setLoc(w, event, 0, hall))) as { version: number };
    expect(again.version).toBeGreaterThan(1);

    // The first person still holds version 1 and must not overwrite the third's choice.
    expect((await setLoc(w, event, 1, barn)).error?.code).toBe("55000");
    const row = await withSuperuser(
      async (db) =>
        (
          await db.query("select candidate_id from public.event_locations where event_id=$1", [
            event,
          ])
        ).rows[0],
    );
    expect(row.candidate_id).toBe(hall);
    // The current version works.
    await ok(setLoc(w, event, again.version, barn));
  });
});

describe("a repriced copy is returned on retry", () => {
  it("returns the copy even after the source is archived, and still refuses a new key", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w);
    const quotes: string[] = [];
    for (const name of ["Garden House", "Barn"]) {
      const cand = await venue(w, name);
      quotes.push(
        (await ok(
          owner.client.rpc("create_proposal", {
            p_wedding: w,
            p_candidate: cand,
            p_title: "Package",
          }),
        )) as string,
      );
    }
    const src = (await ok(
      owner.client.rpc("create_comparison", {
        p_wedding: w,
        p_title: "Venues",
        p_guest_count: 110,
        p_proposals: quotes,
        p_criteria: [{ id: "style", label: "Style", weight: 5 }],
        p_count_event: event,
      }),
    )) as string;
    const key = randomUUID();
    const reprice = (k: string) =>
      owner.client.rpc("reprice_comparison", {
        p_wedding: w,
        p_comparison: src,
        p_guest_count: 96,
        p_idempotency_key: k,
      });
    const copy = await ok(reprice(key));
    const version = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.comparisons where id=$1", [src])).rows[0]
          .version as number,
    );
    await ok(
      owner.client.rpc("archive_comparison", {
        p_wedding: w,
        p_comparison: src,
        p_expected_version: version,
      }),
    );
    expect(await ok(reprice(key))).toBe(copy);
    // A different attempt on the archived source is still refused, and writes nothing.
    expect((await reprice(randomUUID())).error?.code).toBe("55000");
    const n = await withSuperuser(async (db) =>
      Number(
        (await db.query("select count(*) n from public.comparisons where wedding_id=$1", [w]))
          .rows[0].n,
      ),
    );
    expect(n).toBe(2);
  });
});

describe("an event can be deleted", () => {
  it("takes its reply history with it and only clears a comparison's pointer", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w);
    const guest = (await ok(
      owner.client.rpc("create_guest", { p_wedding: w, p_guest: { name: "Guest Example" } }),
    )) as string;
    await withSuperuser(async (db) => {
      await db.query(
        `insert into public.rsvp_changes (wedding_id, event_id, guest_id, from_status, to_status, source)
         values ($1,$2,$3,'pending','accepted','guest')`,
        [w, event, guest],
      );
      await db.query(
        `insert into public.comparisons (wedding_id, title, scenario_guest_count, currency, criteria, count_event_id)
         values ($1,'Pointer',100,'USD','[]'::jsonb,$2)`,
        [w, event],
      );
    });
    await withSuperuser((db) => db.query("delete from public.events where id=$1", [event]));
    const left = await withSuperuser(async (db) => ({
      history: Number(
        (await db.query("select count(*) n from public.rsvp_changes where wedding_id=$1", [w]))
          .rows[0].n,
      ),
      comparison: (
        await db.query(
          "select wedding_id, count_event_id from public.comparisons where wedding_id=$1",
          [w],
        )
      ).rows[0],
    }));
    expect(left.history).toBe(0);
    expect(left.comparison).toEqual({ wedding_id: w, count_event_id: null });
  });

  it("is refused while a budget cost counts the event", async () => {
    const w = await createWedding(owner);
    const event = await addEvent(w);
    const cat = (await ok(
      owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Food" }),
    )) as string;
    await ok(
      owner.client.rpc("create_budget_item", {
        p_wedding: w,
        p_category: cat,
        p_name: "Dinner",
        p_cost_mode: "per_guest",
        p_amount_minor: 9_500,
        p_count_source: "event_plan",
        p_count_event: event,
      }),
    );
    await expect(
      withSuperuser((db) => db.query("delete from public.events where id=$1", [event])),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("internal helpers are not client functions", () => {
  it("clients cannot execute the pure helpers", async () => {
    const granted = await withSuperuser(
      async (db) =>
        (
          await db.query(
            `select
             has_function_privilege('authenticated', 'app_private.assert_budget_item_count(text,text,uuid,integer)', 'execute') a,
             has_function_privilege('authenticated', 'app_private.assert_space_fields(text,integer,integer,text)', 'execute') b,
             has_function_privilege('authenticated', 'app_private.rewrite_place(text,text,text)', 'execute') c`,
          )
        ).rows[0],
    );
    expect(granted).toEqual({ a: false, b: false, c: false });
  });
});
