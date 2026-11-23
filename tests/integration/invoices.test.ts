import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-09: invoices. An invoice is a vendor's request for money on one booking. It never changes the
// contract or the forecast; payments may name an invoice of the same booking; amendments move both.

let owner: TestUser;
let stranger: TestUser;

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

beforeAll(async () => {
  owner = await createUser("inv-owner");
  stranger = await createUser("inv-stranger");
});

type Setup = {
  w: string;
  candidate: string;
  item: string;
  commitment: string;
  partner: TestUser;
  editor: TestUser;
  viewer: TestUser;
};

/** A wedding with one booked venue (contract 10,000.00 covering one cost). */
async function setup(label = "x"): Promise<Setup> {
  const w = await createWedding(owner, { guests: 100 });
  const partner = await addMember(w, "partner", `inv-partner-${label}`);
  const editor = await addMember(w, "editor", `inv-editor-${label}`);
  const viewer = await addMember(w, "viewer", `inv-viewer-${label}`);
  const { data: candidate, error: e0 } = await owner.client.rpc("create_candidate", {
    p_wedding: w,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
  });
  if (e0) throw new Error(e0.message);
  const { data: cat, error: e1 } = await owner.client.rpc("create_budget_category", {
    p_wedding: w,
    p_name: "Venue",
  });
  if (e1) throw new Error(e1.message);
  const { data: item, error: e2 } = await owner.client.rpc("create_budget_item", {
    p_wedding: w,
    p_category: cat,
    p_name: "Venue fee",
    p_amount_minor: 900_000,
  });
  if (e2) throw new Error(e2.message);
  const s = { w, candidate: candidate as string, item: item as string };
  const commitment = await book(s);
  return { ...s, commitment, partner, editor, viewer };
}
async function book(s: { w: string; candidate: string; item: string }) {
  const { data, error } = await owner.client.rpc("book_commitment", {
    p_wedding: s.w,
    p_candidate: s.candidate,
    p_expected_candidate_version: 1,
    p_title: "Venue contract",
    p_amount_minor: 1_000_000,
    p_allocations: [{ itemId: s.item, amountMinor: 1_000_000 }],
    p_installments: [{ dueOn: "2027-01-15", amountMinor: 1_000_000 }],
    p_confirmed: true,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

type Extra = Record<string, unknown>;
const invoice = (user: TestUser, s: { w: string; commitment: string }, extra: Extra = {}) =>
  user.client.rpc("create_invoice", {
    p_wedding: s.w,
    p_commitment: s.commitment,
    p_amount_minor: 600_000,
    ...extra,
  });
async function invoiced(s: { w: string; commitment: string }, extra: Extra = {}) {
  const { data, error } = await invoice(owner, s, extra);
  if (error) throw new Error(error.message);
  return data as string;
}
const pay = (user: TestUser, s: { w: string; commitment: string }, extra: Extra = {}) =>
  user.client.rpc("record_payment", {
    p_wedding: s.w,
    p_kind: "charge",
    p_amount_minor: 250_000,
    p_paid_on: "2026-01-02",
    p_commitment: s.commitment,
    ...extra,
  });
async function paid(s: { w: string; commitment: string }, extra: Extra = {}) {
  const { data, error } = await pay(owner, s, extra);
  if (error) throw new Error(error.message);
  return data as string;
}
async function rows<T extends Record<string, unknown>>(sql: string, args: unknown[]) {
  return withSuperuser(async (db) => (await db.query<T>(sql, args)).rows);
}
const invoiceRow = async (id: string) =>
  (
    await rows<{
      commitment_id: string;
      amount_minor: string;
      voided_at: string | null;
      void_reason: string | null;
      number: string | null;
    }>("select * from public.invoices where id=$1", [id])
  )[0]!;
const paymentRow = async (id: string) =>
  (
    await rows<{ commitment_id: string; invoice_id: string | null; voided_at: string | null }>(
      "select commitment_id, invoice_id, voided_at from public.payments where id=$1",
      [id],
    )
  )[0]!;
const audits = (w: string, action: string) =>
  rows<{ safe_changes: Record<string, unknown>; entity_id: string }>(
    "select safe_changes, entity_id from public.audit_events where wedding_id=$1 and action=$2",
    [w, action],
  );

describe("create_invoice", () => {
  it("records an invoice and leaves the contract, allocations and payments alone", async () => {
    const s = await setup("create");
    const before = await rows("select * from public.commitments where wedding_id=$1", [s.w]);
    const id = await invoiced(s, {
      p_number: " INV-101 ",
      p_issued_on: "2026-12-01",
      p_due_on: "2026-12-31",
      p_note: "Deposit invoice",
    });
    const row = await invoiceRow(id);
    expect(row).toMatchObject({
      commitment_id: s.commitment,
      amount_minor: "600000",
      number: "INV-101",
    });
    expect(await rows("select * from public.commitments where wedding_id=$1", [s.w])).toEqual(
      before,
    );
    expect(await rows("select 1 from public.payments where wedding_id=$1", [s.w])).toHaveLength(0);
    const a = await audits(s.w, "ledger.invoice_created");
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.safe_changes)).not.toContain("INV-101");
  });

  it("an invoice bigger than the contract is allowed (the app flags it)", async () => {
    const s = await setup("big");
    const { error } = await invoice(owner, s, { p_amount_minor: 2_500_000 });
    expect(error).toBeNull();
  });

  it("is idempotent on retry, and a reused key with different details is refused", async () => {
    const s = await setup("idem");
    const key = randomUUID();
    const a = await invoice(owner, s, { p_idempotency_key: key });
    const b = await invoice(owner, s, { p_idempotency_key: key });
    expect(a.error).toBeNull();
    expect(b.data).toBe(a.data);
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(1);
    const c = await invoice(owner, s, { p_idempotency_key: key, p_amount_minor: 100 });
    expect(c.error?.code).toBe("23505");
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(1);
  });

  it("three concurrent calls with one key write one invoice", async () => {
    const s = await setup("conc");
    const key = randomUUID();
    const r = await Promise.all([1, 2, 3].map(() => invoice(owner, s, { p_idempotency_key: key })));
    expect(r.every((x) => !x.error)).toBe(true);
    expect(new Set(r.map((x) => x.data)).size).toBe(1);
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(1);
  });

  it.each([
    ["zero amount", { p_amount_minor: 0 }],
    ["negative amount", { p_amount_minor: -5 }],
    ["amount over the limit", { p_amount_minor: 100_000_001 }],
    ["due before issued", { p_issued_on: "2026-05-02", p_due_on: "2026-05-01" }],
    ["year 1999", { p_issued_on: "1999-12-31" }],
    ["year 2101", { p_due_on: "2101-01-01" }],
    ["number over 60", { p_number: "n".repeat(61) }],
    ["note over 500", { p_note: "n".repeat(501) }],
  ])("refuses %s and writes nothing", async (_, extra) => {
    const s = await setup("bad");
    const { error } = await invoice(owner, s, extra);
    expect(error?.code).toBe("22023");
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(0);
  });

  it("refuses the same number twice on a booking (any case), but allows it once voided", async () => {
    const s = await setup("dup");
    const first = await invoiced(s, { p_number: "A-1" });
    const dup = await invoice(owner, s, { p_number: "a-1" });
    expect(dup.error?.code).toBe("23505");
    expect(dup.error?.message).toContain("invoices_number_idx");
    expect((await invoice(owner, s)).error).toBeNull(); // no number: never a duplicate
    expect((await invoice(owner, s)).error).toBeNull();
    const v = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: first,
      p_reason: "typo",
    });
    expect(v.error).toBeNull();
    expect((await invoice(owner, s, { p_number: "A-1" })).error).toBeNull();
  });

  it("the same number on another booking is fine", async () => {
    const s = await setup("dup2");
    await invoiced(s, { p_number: "7" });
    const other = await setup("dup3");
    expect((await invoice(owner, other, { p_number: "7" })).error).toBeNull();
  });

  it("refuses a superseded booking, an unknown booking and another wedding's booking", async () => {
    const s = await setup("old");
    const amended = await owner.client.rpc("amend_commitment", {
      p_wedding: s.w,
      p_commitment: s.commitment,
      p_expected_version: 1,
      p_title: "Venue contract",
      p_amount_minor: 1_100_000,
      p_allocations: [{ itemId: s.item, amountMinor: 1_100_000 }],
      p_installments: [],
      p_confirmed: true,
    });
    expect(amended.error).toBeNull();
    const old = await invoice(owner, s);
    expect(old.error?.code).toBe("55000");
    expect((await invoice(owner, { w: s.w, commitment: randomUUID() })).error?.code).toBe("42501");
    const foreign = await setup("foreign");
    expect((await invoice(owner, { w: s.w, commitment: foreign.commitment })).error?.code).toBe(
      "42501",
    );
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(0);
  });

  it("is limited to owner and partner; editors, viewers, strangers and anonymous are refused", async () => {
    const s = await setup("roles");
    expect((await invoice(s.partner, s)).error).toBeNull();
    for (const user of [s.editor, s.viewer, stranger]) {
      expect((await invoice(user, s)).error?.code).toBe("42501");
    }
    const anon = await anonClient().rpc("create_invoice", {
      p_wedding: s.w,
      p_commitment: s.commitment,
      p_amount_minor: 100,
    });
    expect(anon.error).not.toBeNull();
    expect(await rows("select 1 from public.invoices where wedding_id=$1", [s.w])).toHaveLength(1);
  });

  it("members can read invoices through RLS like payments; strangers see nothing; nobody can write directly", async () => {
    const s = await setup("rls");
    const id = await invoiced(s);
    const seen = await s.viewer.client.from("invoices").select("id").eq("wedding_id", s.w);
    expect(seen.data?.map((r) => r.id)).toEqual([id]);
    const hidden = await stranger.client.from("invoices").select("id").eq("wedding_id", s.w);
    expect(hidden.data).toEqual([]);
    const direct = await owner.client
      .from("invoices")
      .insert({ wedding_id: s.w, commitment_id: s.commitment, amount_minor: 5 });
    expect(direct.error).not.toBeNull();
    const upd = await owner.client.from("invoices").update({ amount_minor: 1 }).eq("id", id);
    expect(upd.error).not.toBeNull();
    expect((await invoiceRow(id)).amount_minor).toBe("600000");
  });
});

describe("payments that name an invoice", () => {
  it("links a payment to an invoice of the same booking", async () => {
    const s = await setup("link");
    const inv = await invoiced(s);
    const p = await paid(s, { p_invoice: inv });
    expect((await paymentRow(p)).invoice_id).toBe(inv);
    const a = await audits(s.w, "ledger.payment_recorded");
    expect(a.find((x) => x.entity_id === p)?.safe_changes).toMatchObject({ invoiced: true });
  });

  it("refuses an invoice from another booking, another wedding, a void invoice, or an unknown id", async () => {
    const s = await setup("foreign-inv");
    const other = await setup("foreign-inv-2");
    const otherInv = await invoiced(other);
    const voided = await invoiced(s);
    await owner.client.rpc("void_invoice", { p_wedding: s.w, p_invoice: voided, p_reason: "oops" });
    for (const bad of [otherInv, voided, randomUUID()]) {
      const r = await pay(owner, s, { p_invoice: bad });
      expect(r.error?.code).toBe("22023");
      expect(r.error?.message).toContain("invoice not available");
    }
    expect(await rows("select 1 from public.payments where wedding_id=$1", [s.w])).toHaveLength(0);
  });

  it("refuses an invoice on a refund and on a payment against a loose cost", async () => {
    const s = await setup("shape");
    const inv = await invoiced(s);
    await paid(s, { p_invoice: inv });
    const refund = await pay(owner, s, { p_kind: "refund", p_invoice: inv, p_amount_minor: 1000 });
    expect(refund.error?.code).toBe("22023");
    const { data: cat } = await owner.client.rpc("create_budget_category", {
      p_wedding: s.w,
      p_name: "Misc",
    });
    const { data: loose } = await owner.client.rpc("create_budget_item", {
      p_wedding: s.w,
      p_category: cat,
      p_name: "Favors",
      p_amount_minor: 10_000,
    });
    const onItem = await owner.client.rpc("record_payment", {
      p_wedding: s.w,
      p_kind: "charge",
      p_amount_minor: 1000,
      p_paid_on: "2026-01-02",
      p_item: loose as string,
      p_invoice: inv,
    });
    expect(onItem.error?.code).toBe("22023");
    expect(await rows("select 1 from public.payments where wedding_id=$1", [s.w])).toHaveLength(1);
  });

  it("a plain refund on the booking still works and is not tied to an invoice", async () => {
    const s = await setup("refund");
    const inv = await invoiced(s);
    await paid(s, { p_invoice: inv });
    const r = await pay(owner, s, { p_kind: "refund", p_amount_minor: 1000 });
    expect(r.error).toBeNull();
    expect((await paymentRow(r.data as string)).invoice_id).toBeNull();
  });

  it("overpaying an invoice is allowed", async () => {
    const s = await setup("over");
    const inv = await invoiced(s, { p_amount_minor: 100_000 });
    expect((await pay(owner, s, { p_invoice: inv, p_amount_minor: 150_000 })).error).toBeNull();
  });

  it("retry with the same key does not double the payment; the invoice is part of the request", async () => {
    const s = await setup("pay-idem");
    const a = await invoiced(s);
    const b = await invoiced(s);
    const key = randomUUID();
    const first = await pay(owner, s, { p_invoice: a, p_idempotency_key: key });
    const again = await pay(owner, s, { p_invoice: a, p_idempotency_key: key });
    expect(again.data).toBe(first.data);
    const different = await pay(owner, s, { p_invoice: b, p_idempotency_key: key });
    expect(different.error?.code).toBe("23505");
    expect(await rows("select 1 from public.payments where wedding_id=$1", [s.w])).toHaveLength(1);
  });

  it("the database itself refuses a mismatched pair or a refund naming an invoice, even for a superuser", async () => {
    const s = await setup("db");
    const other = await setup("db-other");
    const inv = await invoiced(s);
    const otherInv = await invoiced(other);
    const insert = (commitment: string, invoiceId: string, kind = "charge") =>
      withSuperuser((db) =>
        db.query(
          `insert into public.payments (wedding_id, commitment_id, invoice_id, kind, amount_minor, paid_on)
           values ($1,$2,$3,$4,100,'2026-01-02')`,
          [s.w, commitment, invoiceId, kind],
        ),
      );
    await expect(insert(s.commitment, otherInv)).rejects.toThrow(/payments_invoice_fk/);
    await expect(insert(other.commitment, inv)).rejects.toThrow();
    await expect(insert(s.commitment, inv, "refund")).rejects.toThrow(
      /payments_invoice_needs_booking_charge/,
    );
    await expect(
      withSuperuser((db) =>
        db.query(
          `insert into public.payments (wedding_id, budget_item_id, invoice_id, kind, amount_minor, paid_on)
           values ($1,$2,$3,'charge',100,'2026-01-02')`,
          [s.w, s.item, inv],
        ),
      ),
    ).rejects.toThrow();
    expect(await rows("select 1 from public.payments where wedding_id=$1", [s.w])).toHaveLength(0);
  });

  it("voiding a payment keeps its link to the invoice for history", async () => {
    const s = await setup("void-pay");
    const inv = await invoiced(s);
    const p = await paid(s, { p_invoice: inv });
    const v = await owner.client.rpc("void_payment", {
      p_wedding: s.w,
      p_payment: p,
      p_reason: "typo",
    });
    expect(v.error).toBeNull();
    const row = await paymentRow(p);
    expect(row.invoice_id).toBe(inv);
    expect(row.voided_at).not.toBeNull();
  });
});

describe("amending a booking moves its invoices (PDF section 8 test 5)", () => {
  it("moves invoices and the payments that name them; the old booking keeps none", async () => {
    const s = await setup("amend");
    const a = await invoiced(s, { p_number: "1" });
    const b = await invoiced(s, { p_number: "2" });
    const onA = await paid(s, { p_invoice: a });
    const plain = await paid(s, { p_amount_minor: 100_000 });
    const gone = await invoiced(s, { p_number: "3" });
    await owner.client.rpc("void_invoice", { p_wedding: s.w, p_invoice: gone, p_reason: "typo" });

    const { data: next, error } = await owner.client.rpc("amend_commitment", {
      p_wedding: s.w,
      p_commitment: s.commitment,
      p_expected_version: 1,
      p_title: "Venue contract v2",
      p_amount_minor: 1_200_000,
      p_allocations: [{ itemId: s.item, amountMinor: 1_200_000 }],
      p_installments: [],
      p_confirmed: true,
    });
    expect(error).toBeNull();
    const id = next as string;
    for (const inv of [a, b, gone]) expect((await invoiceRow(inv)).commitment_id).toBe(id);
    expect(await paymentRow(onA)).toMatchObject({ commitment_id: id, invoice_id: a });
    expect(await paymentRow(plain)).toMatchObject({ commitment_id: id, invoice_id: null });
    expect(
      await rows("select 1 from public.invoices where commitment_id=$1", [s.commitment]),
    ).toHaveLength(0);
    expect(
      await rows("select 1 from public.payments where commitment_id=$1", [s.commitment]),
    ).toHaveLength(0);
    const audit = await audits(s.w, "ledger.commitment_amended");
    expect(audit[0]?.safe_changes).toMatchObject({ invoicesMoved: 3, paymentsMoved: 2 });
    // The contract moved by the amendment alone; the invoice amounts did not.
    expect((await invoiceRow(a)).amount_minor).toBe("600000");
    // The new booking takes new invoices and payments naming moved ones.
    expect((await pay(owner, { w: s.w, commitment: id }, { p_invoice: b })).error).toBeNull();
    // The old booking no longer does.
    expect((await pay(owner, s, { p_invoice: b })).error?.code).toBe("55000");
  });

  it("two amendments in a row keep every link intact", async () => {
    const s = await setup("amend2");
    const inv = await invoiced(s);
    const p = await paid(s, { p_invoice: inv });
    let current = s.commitment;
    for (let version = 1; version <= 2; version++) {
      const { data, error } = await owner.client.rpc("amend_commitment", {
        p_wedding: s.w,
        p_commitment: current,
        p_expected_version: 1,
        p_title: `v${version + 1}`,
        p_amount_minor: 1_000_000 + version * 50_000,
        p_allocations: [{ itemId: s.item, amountMinor: 1_000_000 + version * 50_000 }],
        p_installments: [],
        p_confirmed: true,
      });
      expect(error).toBeNull();
      current = data as string;
    }
    expect(await paymentRow(p)).toMatchObject({ commitment_id: current, invoice_id: inv });
    expect((await invoiceRow(inv)).commitment_id).toBe(current);
  });

  it("a change to the forecast (guest target) leaves invoices, payments and the contract unchanged", async () => {
    const s = await setup("forecast");
    const inv = await invoiced(s);
    await paid(s, { p_invoice: inv });
    const snapshot = async () => ({
      invoices: await rows("select * from public.invoices where wedding_id=$1", [s.w]),
      payments: await rows("select * from public.payments where wedding_id=$1", [s.w]),
      commitments: await rows("select * from public.commitments where wedding_id=$1", [s.w]),
    });
    const before = await snapshot();
    await withSuperuser((db) =>
      db.query("update public.weddings set target_guest_count = 180 where id=$1", [s.w]),
    );
    expect(await snapshot()).toEqual(before);
  });
});

describe("void_invoice", () => {
  it("keeps the invoice, needs a reason, and detaches the payments that named it", async () => {
    const s = await setup("void");
    const inv = await invoiced(s);
    const p = await paid(s, { p_invoice: inv });
    const noReason = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: inv,
      p_reason: " ",
    });
    expect(noReason.error?.code).toBe("22023");
    const ok = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: inv,
      p_reason: "Wrong booking",
    });
    expect(ok.error).toBeNull();
    expect(await invoiceRow(inv)).toMatchObject({ void_reason: "Wrong booking" });
    expect((await invoiceRow(inv)).voided_at).not.toBeNull();
    // The payment is still a payment on the booking, no longer tied to the voided invoice.
    expect(await paymentRow(p)).toMatchObject({ commitment_id: s.commitment, invoice_id: null });
    const a = await audits(s.w, "ledger.invoice_voided");
    expect(a[0]?.safe_changes).toMatchObject({ paymentsDetached: 1 });
    expect(JSON.stringify(a[0]?.safe_changes)).not.toContain("Wrong booking");
  });

  it("repeating is harmless and writes one audit event", async () => {
    const s = await setup("void-twice");
    const inv = await invoiced(s);
    const first = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: inv,
      p_reason: "one",
    });
    const second = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: inv,
      p_reason: "two",
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect((await invoiceRow(inv)).void_reason).toBe("one");
    expect(await audits(s.w, "ledger.invoice_voided")).toHaveLength(1);
  });

  it("refuses non-managers, strangers, another wedding's invoice and unknown ids", async () => {
    const s = await setup("void-roles");
    const other = await setup("void-other");
    const inv = await invoiced(s);
    const otherInv = await invoiced(other);
    for (const user of [s.editor, s.viewer, stranger]) {
      const r = await user.client.rpc("void_invoice", {
        p_wedding: s.w,
        p_invoice: inv,
        p_reason: "x",
      });
      expect(r.error?.code).toBe("42501");
    }
    // Owner of wedding A naming wedding B's invoice under wedding A.
    const cross = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: otherInv,
      p_reason: "x",
    });
    expect(cross.error?.code).toBe("42501");
    const unknown = await owner.client.rpc("void_invoice", {
      p_wedding: s.w,
      p_invoice: randomUUID(),
      p_reason: "x",
    });
    expect(unknown.error?.code).toBe("42501");
    expect((await invoiceRow(inv)).voided_at).toBeNull();
    expect((await invoiceRow(otherInv)).voided_at).toBeNull();
  });

  it("a payment racing a void ends consistent: linked to a live invoice, or not linked at all", async () => {
    const s = await setup("race");
    for (let round = 0; round < 4; round++) {
      const inv = await invoiced(s);
      const [p, v] = await Promise.all([
        pay(owner, s, { p_invoice: inv, p_amount_minor: 1000 }),
        owner.client.rpc("void_invoice", { p_wedding: s.w, p_invoice: inv, p_reason: "race" }),
      ]);
      expect(v.error).toBeNull();
      if (!p.error) {
        const row = await paymentRow(p.data as string);
        const invRow = await invoiceRow(inv);
        // Either the payment ran first and was detached by the void, or the void ran first and the
        // payment was refused. A payment is never left naming a voided invoice.
        expect(invRow.voided_at).not.toBeNull();
        expect(row.invoice_id).toBeNull();
      } else {
        expect(p.error.message).toContain("invoice not available");
      }
    }
    const stuck = await rows(
      `select 1 from public.payments p join public.invoices i on i.id = p.invoice_id
        where p.wedding_id = $1 and i.voided_at is not null`,
      [s.w],
    );
    expect(stuck).toHaveLength(0);
  });
});
