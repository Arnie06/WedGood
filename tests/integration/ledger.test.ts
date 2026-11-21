import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let stranger: TestUser;

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

beforeAll(async () => {
  owner = await createUser("ledger-owner");
  stranger = await createUser("ledger-stranger");
});

type Setup = { w: string; candidate: string; item: string; item2: string };

/** A wedding with one venue, one budget category and two planned costs. */
async function setup(user = owner): Promise<Setup> {
  const w = await createWedding(user, { guests: 100 });
  const candidate = await newCandidate(user, w, "Garden House");
  const { data: cat, error: e1 } = await user.client.rpc("create_budget_category", {
    p_wedding: w,
    p_name: "Venue",
  });
  if (e1) throw new Error(e1.message);
  const mk = async (name: string, amount: number) => {
    const { data, error } = await user.client.rpc("create_budget_item", {
      p_wedding: w,
      p_category: cat,
      p_name: name,
      p_amount_minor: amount,
    });
    if (error) throw new Error(error.message);
    return data as string;
  };
  return {
    w,
    candidate,
    item: await mk("Venue fee", 900_000),
    item2: await mk("Rentals", 200_000),
  };
}
async function newCandidate(user: TestUser, w: string, name: string) {
  const { data, error } = await user.client.rpc("create_candidate", {
    p_wedding: w,
    p_kind: "venue",
    p_category: "venue",
    p_name: name,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function candidateRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{ stage: string; version: number }>(
      "select stage, version from public.candidates where id=$1",
      [id],
    );
    return r.rows[0]!;
  });
}

type BookExtra = Record<string, unknown>;
function book(user: TestUser, s: Setup, extra: BookExtra = {}) {
  return user.client.rpc("book_commitment", {
    p_wedding: s.w,
    p_candidate: s.candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: s.item, amountMinor: 1_000_000 }],
    p_installments: [
      { dueOn: "2027-01-15", amountMinor: 250_000, label: "Deposit" },
      { dueOn: "2027-05-08", amountMinor: 750_000 },
    ],
    p_confirmed: true,
    ...extra,
  });
}
async function booked(user: TestUser, s: Setup, extra: BookExtra = {}) {
  const { data, error } = await book(user, s, extra);
  if (error) throw new Error(error.message);
  return data as string;
}
function pay(
  user: TestUser,
  w: string,
  target: { commitment?: string; item?: string },
  extra: BookExtra = {},
) {
  return user.client.rpc("record_payment", {
    p_wedding: w,
    p_kind: "charge",
    p_amount_minor: 250_000,
    p_paid_on: "2026-01-02",
    ...(target.commitment && { p_commitment: target.commitment }),
    ...(target.item && { p_item: target.item }),
    ...extra,
  });
}
async function q<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function count(table: string, w: string) {
  const r = await q<{ n: string }>(
    `select count(*)::text n from public.${table} where wedding_id=$1`,
    [w],
  );
  return Number(r[0]!.n);
}
async function netPaid(commitment: string) {
  const r = await q<{ n: string }>("select app_private.net_paid($1, null)::text n", [commitment]);
  return Number(r[0]!.n);
}

describe("book_commitment", () => {
  it("T03: a quote or candidate alone creates no commitment", async () => {
    const s = await setup();
    expect(await count("commitments", s.w)).toBe(0);
    expect((await candidateRow(s.candidate)).stage).toBe("saved");
  });

  it("books atomically: commitment, allocations, schedule and vendor stage together", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const [c] = await q<{
      amount_minor: string;
      status: string;
      currency: string;
      candidate_id: string;
    }>("select amount_minor, status, currency, candidate_id from public.commitments where id=$1", [
      id,
    ]);
    expect(c).toMatchObject({
      amount_minor: "1000000",
      status: "active",
      currency: "USD",
      candidate_id: s.candidate,
    });
    expect(await count("commitment_allocations", s.w)).toBe(1);
    expect(await count("payment_installments", s.w)).toBe(2);
    expect(await candidateRow(s.candidate)).toMatchObject({ stage: "booked", version: 2 });
    const audit = await q(
      "select 1 from public.audit_events where wedding_id=$1 and action='ledger.commitment_booked'",
      [s.w],
    );
    expect(audit).toHaveLength(1);
  });

  it("writes nothing when any part is invalid", async () => {
    const s = await setup();
    const foreign = await setup(stranger);
    const cases: BookExtra[] = [
      { p_confirmed: false },
      { p_title: "  " },
      { p_amount_minor: 0 },
      { p_allocations: [] },
      { p_allocations: [{ itemId: s.item, amountMinor: 900_000 }] }, // does not add up
      {
        p_allocations: [
          { itemId: s.item, amountMinor: 500_000 },
          { itemId: s.item, amountMinor: 500_000 },
        ],
      },
      { p_allocations: [{ itemId: foreign.item, amountMinor: 1_000_000 }] }, // other tenant's cost
      { p_allocations: [{ itemId: "not-a-uuid", amountMinor: 1_000_000 }] },
      { p_installments: [{ dueOn: "2027-02-30", amountMinor: 1 }] },
      { p_installments: [{ dueOn: "2027-01-01", amountMinor: 0 }] },
      { p_installments: "nope" },
      { p_signed_on: "1999-01-01" },
    ];
    for (const extra of cases) {
      const { error } = await book(owner, s, extra);
      expect(error?.code, JSON.stringify(extra)).toBe("22023");
    }
    expect(await count("commitments", s.w)).toBe(0);
    expect(await count("commitment_allocations", s.w)).toBe(0);
    expect(await count("payment_installments", s.w)).toBe(0);
    expect(await candidateRow(s.candidate)).toMatchObject({ stage: "saved", version: 1 });
  });

  it("refuses an archived cost, a stale candidate version, a passed vendor and a second booking", async () => {
    const s = await setup();
    const { data: ver } = await owner.client.rpc("archive_budget_item", {
      p_wedding: s.w,
      p_item: s.item2,
      p_expected_version: 1,
    });
    expect(ver).toBeGreaterThan(0);
    expect(
      (await book(owner, s, { p_allocations: [{ itemId: s.item2, amountMinor: 1_000_000 }] })).error
        ?.code,
    ).toBe("22023");
    expect((await book(owner, s, { p_expected_candidate_version: 7 })).error?.code).toBe("55000");
    await booked(owner, s);
    expect((await book(owner, s, { p_expected_candidate_version: 2 })).error?.code).toBe("22023");

    const t = await setup();
    await owner.client.rpc("set_candidate_stage", {
      p_wedding: t.w,
      p_candidate: t.candidate,
      p_expected_version: 1,
      p_stage: "declined",
    });
    expect((await book(owner, t, { p_expected_candidate_version: 2 })).error?.code).toBe("22023");
  });

  it("links only an open, unarchived quote of the same vendor", async () => {
    const s = await setup();
    const other = await newCandidate(owner, s.w, "Other venue");
    const { data: otherQuote } = await owner.client.rpc("create_proposal", {
      p_wedding: s.w,
      p_candidate: other,
      p_title: "Theirs",
    });
    expect((await book(owner, s, { p_proposal: otherQuote })).error?.code).toBe("22023");
    const { data: mine } = await owner.client.rpc("create_proposal", {
      p_wedding: s.w,
      p_candidate: s.candidate,
      p_title: "Mine",
    });
    const id = await booked(owner, s, { p_proposal: mine });
    const [row] = await q<{ proposal_id: string }>(
      "select proposal_id from public.commitments where id=$1",
      [id],
    );
    expect(row?.proposal_id).toBe(mine);
  });

  it("is idempotent, even under 5 concurrent submits, and rejects a changed body", async () => {
    const s = await setup();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => book(owner, s, { p_idempotency_key: key })),
    );
    expect(results.every((r) => !r.error)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("commitments", s.w)).toBe(1);
    expect(await count("commitment_allocations", s.w)).toBe(1);
    const changed = await book(owner, s, { p_idempotency_key: key, p_title: "Different" });
    expect(changed.error?.code).toBe("23505");
  });

  it("covers a cost only once, even when two vendors are booked at the same moment", async () => {
    const s = await setup();
    const second = await newCandidate(owner, s.w, "Second venue");
    const results = await Promise.all([book(owner, s), book(owner, { ...s, candidate: second })]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("22023");
    expect(await count("commitments", s.w)).toBe(1);
    // the loser left nothing behind, including the stage
    const stages = await q<{ stage: string }>(
      "select stage from public.candidates where wedding_id=$1 order by stage",
      [s.w],
    );
    expect(stages.map((r) => r.stage)).toEqual(["booked", "saved"]);
  });

  it("refuses a cost that already has payments recorded on its own", async () => {
    const s = await setup();
    expect((await pay(owner, s.w, { item: s.item })).error).toBeNull();
    const { error } = await book(owner, s);
    expect(error?.code).toBe("22023");
    expect(error?.message).toMatch(/payments/);
  });
});

describe("record_payment", () => {
  it("T04: book $10k, pay $2.5k, refund $500: net paid $2k, owed $8k", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    expect((await pay(owner, s.w, { commitment: id })).error).toBeNull();
    expect(
      (await pay(owner, s.w, { commitment: id }, { p_kind: "refund", p_amount_minor: 50_000 }))
        .error,
    ).toBeNull();
    expect(await netPaid(id)).toBe(200_000);
    expect(1_000_000 - (await netPaid(id))).toBe(800_000);
    // recorded payments never change the committed amount
    const [c] = await q<{ amount_minor: string }>(
      "select amount_minor from public.commitments where id=$1",
      [id],
    );
    expect(c?.amount_minor).toBe("1000000");
  });

  it("validates input and writes nothing on failure", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const bad: BookExtra[] = [
      { p_kind: "gift" },
      { p_amount_minor: 0 },
      { p_amount_minor: -5 },
      { p_paid_on: "2999-01-01" }, // future: not money that moved
      { p_paid_on: "1999-01-01" },
      { p_method: "x".repeat(61) },
      { p_note: "x".repeat(501) },
    ];
    for (const extra of bad) {
      const { error } = await pay(owner, s.w, { commitment: id }, extra);
      expect(error?.code, JSON.stringify(extra)).toBe("22023");
    }
    // exactly one target
    expect((await pay(owner, s.w, {})).error?.code).toBe("22023");
    expect((await pay(owner, s.w, { commitment: id, item: s.item2 })).error?.code).toBe("22023");
    expect(await count("payments", s.w)).toBe(0);
  });

  it("rejects a refund above net paid, including under concurrency", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    expect(
      (await pay(owner, s.w, { commitment: id }, { p_amount_minor: 300_000 })).error,
    ).toBeNull();
    const over = await pay(
      owner,
      s.w,
      { commitment: id },
      { p_kind: "refund", p_amount_minor: 300_001 },
    );
    expect(over.error?.code).toBe("22023");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        pay(owner, s.w, { commitment: id }, { p_kind: "refund", p_amount_minor: 100_000 }),
      ),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(3);
    expect(await netPaid(id)).toBe(0);
  });

  it("allows paying above the amount and leaves it as a flagged overpayment", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    expect(
      (await pay(owner, s.w, { commitment: id }, { p_amount_minor: 1_200_000 })).error,
    ).toBeNull();
    expect(await netPaid(id)).toBe(1_200_000);
  });

  it("replays an idempotency key once under 5 concurrent submits and rejects a changed body", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        pay(owner, s.w, { commitment: id }, { p_idempotency_key: key }),
      ),
    );
    expect(results.every((r) => !r.error)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("payments", s.w)).toBe(1);
    expect(
      (await pay(owner, s.w, { commitment: id }, { p_idempotency_key: key, p_amount_minor: 1 }))
        .error?.code,
    ).toBe("23505");
  });

  it("refuses the same receipt reference twice in one wedding", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    expect(
      (await pay(owner, s.w, { commitment: id }, { p_external_ref: "CONF-1" })).error,
    ).toBeNull();
    const dup = await pay(
      owner,
      s.w,
      { commitment: id },
      { p_external_ref: "CONF-1", p_idempotency_key: randomUUID() },
    );
    expect(dup.error?.code).toBe("23505");
    expect(await count("payments", s.w)).toBe(1);
  });

  it("records a standalone payment on an unbooked cost and then blocks booking that cost", async () => {
    const s = await setup();
    expect((await pay(owner, s.w, { item: s.item2 })).error).toBeNull();
    // a refund beyond what was paid on the cost is refused
    expect(
      (await pay(owner, s.w, { item: s.item2 }, { p_kind: "refund", p_amount_minor: 250_001 }))
        .error?.code,
    ).toBe("22023");
    // once a booking covers a cost, standalone payments on it are refused
    await booked(owner, s);
    expect((await pay(owner, s.w, { item: s.item })).error?.code).toBe("22023");
  });

  it("refuses payments on a superseded commitment and on a foreign commitment", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const { data: next } = await owner.client.rpc("amend_commitment", {
      p_wedding: s.w,
      p_commitment: id,
      p_expected_version: 1,
      p_title: "Venue contract v2",
      p_amount_minor: 1_100_000,
      p_allocations: [{ itemId: s.item, amountMinor: 1_100_000 }],
      p_installments: [],
      p_confirmed: true,
    });
    expect(next).toBeTruthy();
    expect((await pay(owner, s.w, { commitment: id })).error?.code).toBe("55000");
    const other = await setup(stranger);
    const foreignId = await booked(stranger, other);
    expect((await pay(owner, s.w, { commitment: foreignId })).error?.code).toBe("42501");
  });
});

describe("void_payment", () => {
  it("keeps the record, stops it counting, and is safe to repeat", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const { data: p } = await pay(owner, s.w, { commitment: id });
    expect(await netPaid(id)).toBe(250_000);
    expect(
      (await owner.client.rpc("void_payment", { p_wedding: s.w, p_payment: p, p_reason: "Typo" }))
        .error,
    ).toBeNull();
    expect(
      (await owner.client.rpc("void_payment", { p_wedding: s.w, p_payment: p, p_reason: "Again" }))
        .error,
    ).toBeNull();
    expect(await netPaid(id)).toBe(0);
    const [row] = await q<{ void_reason: string; voided_at: string }>(
      "select void_reason, voided_at::text from public.payments where id=$1",
      [p],
    );
    expect(row?.void_reason).toBe("Typo");
    expect(await count("payments", s.w)).toBe(1);
    expect(
      (await owner.client.rpc("void_payment", { p_wedding: s.w, p_payment: p, p_reason: " " }))
        .error?.code,
    ).toBe("22023");
  });

  it("refuses to void a charge that later refunds depend on", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const { data: charge } = await pay(owner, s.w, { commitment: id });
    const { data: refund } = await pay(
      owner,
      s.w,
      { commitment: id },
      { p_kind: "refund", p_amount_minor: 100_000 },
    );
    const blocked = await owner.client.rpc("void_payment", {
      p_wedding: s.w,
      p_payment: charge,
      p_reason: "Typo",
    });
    expect(blocked.error?.code).toBe("22023");
    expect(
      (
        await owner.client.rpc("void_payment", {
          p_wedding: s.w,
          p_payment: refund,
          p_reason: "Typo",
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await owner.client.rpc("void_payment", {
          p_wedding: s.w,
          p_payment: charge,
          p_reason: "Typo",
        })
      ).error,
    ).toBeNull();
  });

  it("lets the cost be booked once its direct payment is voided", async () => {
    const s = await setup();
    const { data: p } = await pay(owner, s.w, { item: s.item });
    await owner.client.rpc("void_payment", {
      p_wedding: s.w,
      p_payment: p,
      p_reason: "Wrong cost",
    });
    expect((await book(owner, s)).error).toBeNull();
  });
});

describe("amend_commitment", () => {
  it("supersedes in place of editing, moves payments, and frees and re-covers costs", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    await pay(owner, s.w, { commitment: id });
    const { data: next, error } = await owner.client.rpc("amend_commitment", {
      p_wedding: s.w,
      p_commitment: id,
      p_expected_version: 1,
      p_title: "Venue contract v2",
      p_amount_minor: 1_200_000,
      p_allocations: [
        { itemId: s.item, amountMinor: 1_000_000 },
        { itemId: s.item2, amountMinor: 200_000 },
      ],
      p_installments: [{ dueOn: "2027-06-01", amountMinor: 1_200_000 }],
      p_confirmed: true,
    });
    expect(error).toBeNull();
    const rows = await q<{
      id: string;
      status: string;
      amount_minor: string;
      supersedes_id: string | null;
    }>(
      "select id, status, amount_minor, supersedes_id from public.commitments where wedding_id=$1 order by created_at",
      [s.w],
    );
    expect(rows.map((r) => [r.status, r.amount_minor])).toEqual([
      ["superseded", "1000000"],
      ["active", "1200000"],
    ]);
    expect(rows[1]?.supersedes_id).toBe(id);
    const allocs = await q<{ active: boolean }>(
      "select active from public.commitment_allocations where wedding_id=$1",
      [s.w],
    );
    expect(allocs.filter((a) => a.active)).toHaveLength(2);
    expect(allocs.filter((a) => !a.active)).toHaveLength(1);
    // payments moved, none lost, none doubled
    expect(await netPaid(next as string)).toBe(250_000);
    expect(await netPaid(id)).toBe(0);
    expect(await count("payments", s.w)).toBe(1);
    // old schedule kept as history, new schedule on the new row
    expect(await count("payment_installments", s.w)).toBe(3);
    const audit = await q<{ safe_changes: { paymentsMoved: number } }>(
      "select safe_changes from public.audit_events where wedding_id=$1 and action='ledger.commitment_amended'",
      [s.w],
    );
    expect(audit[0]?.safe_changes.paymentsMoved).toBe(1);
    // exactly one active commitment for the venue; the stage stays booked
    expect((await candidateRow(s.candidate)).stage).toBe("booked");
  });

  it("refuses a stale version, an invalid body, and never leaves a half-written amendment", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const base = {
      p_wedding: s.w,
      p_commitment: id,
      p_title: "v2",
      p_amount_minor: 900_000,
      p_allocations: [{ itemId: s.item, amountMinor: 900_000 }],
      p_installments: [],
      p_confirmed: true,
    };
    expect(
      (await owner.client.rpc("amend_commitment", { ...base, p_expected_version: 9 })).error?.code,
    ).toBe("55000");
    expect(
      (
        await owner.client.rpc("amend_commitment", {
          ...base,
          p_expected_version: 1,
          p_allocations: [{ itemId: s.item, amountMinor: 1 }],
        })
      ).error?.code,
    ).toBe("22023");
    expect(
      (
        await owner.client.rpc("amend_commitment", {
          ...base,
          p_expected_version: 1,
          p_confirmed: false,
        })
      ).error?.code,
    ).toBe("22023");
    const rows = await q<{ status: string }>(
      "select status from public.commitments where wedding_id=$1",
      [s.w],
    );
    expect(rows).toEqual([{ status: "active" }]);
    const allocs = await q<{ active: boolean }>(
      "select active from public.commitment_allocations where wedding_id=$1",
      [s.w],
    );
    expect(allocs).toEqual([{ active: true }]);
  });

  it("has exactly one winner when two amendments race on the same version", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const amend = (amount: number) =>
      owner.client.rpc("amend_commitment", {
        p_wedding: s.w,
        p_commitment: id,
        p_expected_version: 1,
        p_title: `v-${amount}`,
        p_amount_minor: amount,
        p_allocations: [{ itemId: s.item, amountMinor: amount }],
        p_installments: [],
        p_confirmed: true,
      });
    const results = await Promise.all([amend(1_100_000), amend(1_300_000)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("55000");
    const active = await q(
      "select 1 from public.commitments where wedding_id=$1 and status='active'",
      [s.w],
    );
    expect(active).toHaveLength(1);
  });

  it("replays an idempotent amendment once", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const key = randomUUID();
    const call = () =>
      owner.client.rpc("amend_commitment", {
        p_wedding: s.w,
        p_commitment: id,
        p_expected_version: 1,
        p_title: "v2",
        p_amount_minor: 1_000_000,
        p_allocations: [{ itemId: s.item, amountMinor: 1_000_000 }],
        p_installments: [],
        p_confirmed: true,
        p_idempotency_key: key,
      });
    const results = await Promise.all([call(), call(), call()]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await count("commitments", s.w)).toBe(2);
  });
});

describe("rules around other tables", () => {
  it("refuses to remove a booked cost or one with payments, and to change currency after bookings", async () => {
    const s = await setup();
    await booked(owner, s);
    const archive = await owner.client.rpc("archive_budget_item", {
      p_wedding: s.w,
      p_item: s.item,
      p_expected_version: 1,
    });
    expect(archive.error?.code).toBe("22023");
    expect(archive.error?.message).toMatch(/booked/);
    const t = await setup();
    await pay(owner, t.w, { item: t.item2 });
    const paid = await owner.client.rpc("archive_budget_item", {
      p_wedding: t.w,
      p_item: t.item2,
      p_expected_version: 1,
    });
    expect(paid.error?.code).toBe("22023");
    await expect(
      withSuperuser((db) =>
        db.query("update public.weddings set base_currency='EUR' where id=$1", [s.w]),
      ),
    ).rejects.toMatchObject({ code: "55006" });
  });

  it("does not let a booked vendor be moved back through the pipeline", async () => {
    const s = await setup();
    await booked(owner, s);
    const { error } = await owner.client.rpc("set_candidate_stage", {
      p_wedding: s.w,
      p_candidate: s.candidate,
      p_expected_version: 2,
      p_stage: "considering",
    });
    expect(error?.code).toBe("22023");
  });
});

describe("authorization and isolation", () => {
  it("allows owner and partner, and denies viewer, editor, outsider and anonymous on every RPC", async () => {
    const s = await setup();
    const partner = await addMember(s.w, "partner", "ledger-partner");
    const editor = await addMember(s.w, "editor", "ledger-editor");
    const viewer = await addMember(s.w, "viewer", "ledger-viewer");
    const id = await booked(owner, s);
    const { data: p } = await pay(owner, s.w, { commitment: id });
    for (const [label, u] of [
      ["editor", editor],
      ["viewer", viewer],
      ["outsider", stranger],
    ] as const) {
      const results = await Promise.all([
        book(u, s),
        pay(u, s.w, { commitment: id }),
        u.client.rpc("void_payment", { p_wedding: s.w, p_payment: p, p_reason: "x" }),
        u.client.rpc("amend_commitment", {
          p_wedding: s.w,
          p_commitment: id,
          p_expected_version: 1,
          p_title: "x",
          p_amount_minor: 1,
          p_allocations: [{ itemId: s.item, amountMinor: 1 }],
          p_installments: [],
          p_confirmed: true,
        }),
      ]);
      for (const r of results) expect(r.error?.code, label).toBe("42501");
    }
    const anon = anonClient();
    expect(
      (
        await anon.rpc("record_payment", {
          p_wedding: s.w,
          p_kind: "charge",
          p_amount_minor: 1,
          p_paid_on: "2026-01-01",
          p_commitment: id,
        })
      ).error,
    ).not.toBeNull();
    expect((await pay(partner, s.w, { commitment: id })).error).toBeNull();
    expect(await count("payments", s.w)).toBe(2);
  });

  it("gives members read access and outsiders and anonymous nothing", async () => {
    const s = await setup();
    const viewer = await addMember(s.w, "viewer", "ledger-reader");
    const id = await booked(owner, s);
    await pay(owner, s.w, { commitment: id });
    for (const table of [
      "commitments",
      "commitment_allocations",
      "payment_installments",
      "payments",
    ]) {
      const member = await viewer.client.from(table).select("*").eq("wedding_id", s.w);
      expect(member.data?.length, table).toBeGreaterThan(0);
      const outsider = await stranger.client.from(table).select("*").eq("wedding_id", s.w);
      expect(outsider.data, table).toEqual([]);
      const anon = await anonClient().from(table).select("*").eq("wedding_id", s.w);
      expect(anon.data ?? [], table).toEqual([]);
    }
  });

  it("denies direct table writes, including deleting or editing recorded payments", async () => {
    const s = await setup();
    const id = await booked(owner, s);
    const { data: p } = await pay(owner, s.w, { commitment: id });
    const ins = await owner.client.from("payments").insert({
      wedding_id: s.w,
      commitment_id: id,
      kind: "charge",
      amount_minor: 1,
      paid_on: "2026-01-01",
    });
    expect(ins.error).not.toBeNull();
    await owner.client.from("payments").update({ amount_minor: 1 }).eq("id", p);
    await owner.client.from("payments").delete().eq("id", p);
    await owner.client.from("commitments").update({ amount_minor: 1 }).eq("id", id);
    await owner.client.from("commitments").delete().eq("id", id);
    const [pay1] = await q<{ amount_minor: string }>(
      "select amount_minor from public.payments where id=$1",
      [p],
    );
    const [c1] = await q<{ amount_minor: string }>(
      "select amount_minor from public.commitments where id=$1",
      [id],
    );
    expect(pay1?.amount_minor).toBe("250000");
    expect(c1?.amount_minor).toBe("1000000");
  });

  it("will not let a payment or allocation point at another wedding's records", async () => {
    const s = await setup();
    const other = await setup(stranger);
    const otherId = await booked(stranger, other);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.payments (wedding_id, commitment_id, kind, amount_minor, paid_on) values ($1,$2,'charge',1,'2026-01-01')",
          [s.w, otherId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.payments (wedding_id, commitment_id, budget_item_id, kind, amount_minor, paid_on) values ($1,null,null,'charge',1,'2026-01-01')",
          [s.w],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
