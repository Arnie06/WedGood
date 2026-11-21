import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;

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

async function venue(user: TestUser, wedding: string): Promise<string> {
  const { data, error } = await user.client.rpc("create_candidate", {
    p_wedding: wedding,
    p_kind: "venue",
    p_category: "venue",
    p_name: "Garden House",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

function newQuote(user: TestUser, wedding: string, candidate: string, extra = {}) {
  return user.client.rpc("create_proposal", {
    p_wedding: wedding,
    p_candidate: candidate,
    p_title: "Saturday package",
    ...extra,
  });
}
async function quote(user: TestUser, wedding: string, candidate: string): Promise<string> {
  const { data, error } = await newQuote(user, wedding, candidate);
  if (error) throw new Error(error.message);
  return data as string;
}

type Line = Record<string, unknown>;
function addLine(user: TestUser, wedding: string, proposal: string, version: number, line: Line) {
  return user.client.rpc("add_proposal_line", {
    p_wedding: wedding,
    p_proposal: proposal,
    p_expected_version: version,
    p_description: "Dinner",
    p_cost_mode: "fixed",
    ...line,
  });
}
async function proposalRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      version: number;
      title: string;
      currency: string;
      status: string;
      archived_at: string | null;
      notes: string | null;
    }>(
      "select version, title, currency, status, archived_at::text, notes from public.proposals where id=$1",
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new Error("proposal not found");
    return row;
  });
}
async function lineRows(proposal: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      id: string;
      description: string;
      cost_mode: string;
      amount_minor: string | null;
      quantity: number | null;
      required: boolean;
      certainty: string;
      included_in_line_id: string | null;
      position: number;
    }>(
      `select id, description, cost_mode, amount_minor::text, quantity, required, certainty,
              included_in_line_id, position from public.proposal_lines where proposal_id=$1 order by position`,
      [proposal],
    );
    return r.rows;
  });
}
async function candidateRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{ stage: string; version: number }>(
      "select stage, version from public.candidates where id=$1",
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new Error("candidate not found");
    return row;
  });
}
async function audit(wedding: string, type: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{ action: string; safe_changes: Record<string, unknown> }>(
      "select action, safe_changes from public.audit_events where wedding_id=$1 and entity_type=$2 order by occurred_at, id",
      [wedding, type],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  owner = await createUser("quote-owner");
});

describe("set_candidate_stage", () => {
  it("starts saved and moves among open stages, to passed, and back", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    expect(await candidateRow(c)).toMatchObject({ stage: "saved", version: 1 });
    let version = 1;
    for (const stage of [
      "contacted",
      "proposal_received",
      "considering",
      "saved",
      "declined",
      "considering",
    ]) {
      const r = await owner.client.rpc("set_candidate_stage", {
        p_wedding: w,
        p_candidate: c,
        p_expected_version: version,
        p_stage: stage,
      });
      expect(r.error).toBeNull();
      version = r.data as number;
      expect((await candidateRow(c)).stage).toBe(stage);
    }
    expect(version).toBe(7);
    const actions = (await audit(w, "candidate")).filter(
      (a) => a.action === "candidate.stage_changed",
    );
    expect(actions).toHaveLength(6);
    expect(actions[0]?.safe_changes).toEqual({ from: "saved", to: "contacted" });
  });

  it("never allows booked, cancelled or unknown stages, and writes nothing", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    for (const stage of ["booked", "cancelled", "nonsense", ""]) {
      const r = await owner.client.rpc("set_candidate_stage", {
        p_wedding: w,
        p_candidate: c,
        p_expected_version: 1,
        p_stage: stage,
      });
      expect(r.error?.code).toBe("22023");
    }
    expect(await candidateRow(c)).toMatchObject({ stage: "saved", version: 1 });
  });

  it("refuses to move a booked record even if one exists", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    await withSuperuser((db) =>
      db.query("update public.candidates set stage='booked' where id=$1", [c]),
    );
    const { version } = await candidateRow(c);
    const r = await owner.client.rpc("set_candidate_stage", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: version,
      p_stage: "saved",
    });
    expect(r.error?.code).toBe("22023");
    expect((await candidateRow(c)).stage).toBe("booked");
  });

  it("is a no-op for the same stage, rejects stale versions and archived candidates", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const same = await owner.client.rpc("set_candidate_stage", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: 1,
      p_stage: "saved",
    });
    expect(same.data).toBe(1);
    expect(await audit(w, "candidate")).toHaveLength(1); // only creation
    const stale = await owner.client.rpc("set_candidate_stage", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: 9,
      p_stage: "contacted",
    });
    expect(stale.error?.code).toBe("55000");
    await owner.client.rpc("archive_candidate", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: 1,
    });
    const archived = await owner.client.rpc("set_candidate_stage", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: 2,
      p_stage: "contacted",
    });
    expect(archived.error?.code).toBe("55000");
  });

  it("of two concurrent moves from the same version exactly one wins", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const results = await Promise.all(
      ["contacted", "considering"].map((p_stage) =>
        owner.client.rpc("set_candidate_stage", {
          p_wedding: w,
          p_candidate: c,
          p_expected_version: 1,
          p_stage,
        }),
      ),
    );
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("55000");
  });
});

describe("create_proposal", () => {
  it("creates a quote in the wedding currency with unknowns left null", async () => {
    const w = await createWedding(owner, { cur: "EUR" });
    const c = await venue(owner, w);
    const { data, error } = await newQuote(owner, w, c);
    expect(error).toBeNull();
    expect(await proposalRow(data as string)).toMatchObject({
      title: "Saturday package",
      currency: "EUR",
      status: "open",
      version: 1,
      notes: null,
    });
    expect((await audit(w, "proposal")).map((a) => a.action)).toEqual(["proposal.created"]);
  });

  it("rejects an empty title, an unsafe link and impossible dates; nothing is written", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    expect((await newQuote(owner, w, c, { p_title: "   " })).error?.code).toBe("22023");
    expect((await newQuote(owner, w, c, { p_source_url: "javascript:alert(1)" })).error?.code).toBe(
      "23514",
    );
    expect(
      (await newQuote(owner, w, c, { p_source_url: "https://user:pw@example.com" })).error?.code,
    ).toBe("23514");
    expect((await newQuote(owner, w, c, { p_valid_until: "1800-01-01" })).error?.code).toBe(
      "23514",
    );
    const n = await withSuperuser((db) =>
      db.query("select count(*) from public.proposals where wedding_id=$1", [w]),
    );
    expect(n.rows[0]?.count).toBe("0");
  });

  it("is idempotent, even for concurrent replays, and refuses a reused key with a different body", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const key = `quote-${randomUUID()}`;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => newQuote(owner, w, c, { p_idempotency_key: key })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    const n = await withSuperuser((db) =>
      db.query("select count(*) from public.proposals where wedding_id=$1", [w]),
    );
    expect(n.rows[0]?.count).toBe("1");
    const diff = await newQuote(owner, w, c, { p_idempotency_key: key, p_title: "Different" });
    expect(diff.error?.code).toBe("23505");
  });

  it("cannot attach to another wedding's candidate, or an archived one", async () => {
    const w = await createWedding(owner);
    const other = await createWedding(owner);
    const foreign = await venue(owner, other);
    expect((await newQuote(owner, w, foreign)).error?.code).toBe("42501");
    const c = await venue(owner, w);
    await owner.client.rpc("archive_candidate", {
      p_wedding: w,
      p_candidate: c,
      p_expected_version: 1,
    });
    expect((await newQuote(owner, w, c)).error?.code).toBe("55000");
  });

  it("caps quotes per candidate", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    for (let i = 0; i < 20; i += 1) expect((await newQuote(owner, w, c)).error).toBeNull();
    expect((await newQuote(owner, w, c)).error?.code).toBe("54000");
  });
});

describe("update_proposal, status and archive", () => {
  it("updates, audits only field names, and a no-op does not bump the version", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const upd = (extra: Record<string, unknown>, v: number) =>
      owner.client.rpc("update_proposal", {
        p_wedding: w,
        p_proposal: p,
        p_expected_version: v,
        p_title: "Saturday package",
        ...extra,
      });
    const a = await upd({ p_title: "Renamed", p_notes: "secret-note-text" }, 1);
    expect(a.data).toBe(2);
    const noop = await upd({ p_title: "Renamed", p_notes: "secret-note-text" }, 2);
    expect(noop.data).toBe(2);
    expect((await proposalRow(p)).title).toBe("Renamed");
    const updates = (await audit(w, "proposal")).filter((x) => x.action === "proposal.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.safe_changes).toEqual({ changed: ["title", "notes"] });
    expect(JSON.stringify(updates[0])).not.toContain("secret-note-text");
  });

  it("detects stale versions; of two concurrent edits exactly one wins", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const results = await Promise.all(
      ["A", "B"].map((t) =>
        owner.client.rpc("update_proposal", {
          p_wedding: w,
          p_proposal: p,
          p_expected_version: 1,
          p_title: t,
        }),
      ),
    );
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("55000");
  });

  it("marks passed and reopens; rejects unknown statuses", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const set = (status: string, v: number) =>
      owner.client.rpc("set_proposal_status", {
        p_wedding: w,
        p_proposal: p,
        p_expected_version: v,
        p_status: status,
      });
    expect((await set("declined", 1)).data).toBe(2);
    expect((await set("declined", 2)).data).toBe(2);
    expect((await set("open", 2)).data).toBe(3);
    expect((await set("selected", 3)).error?.code).toBe("22023");
  });

  it("archives softly, is idempotent, and then refuses edits", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const arch = (v: number) =>
      owner.client.rpc("archive_proposal", { p_wedding: w, p_proposal: p, p_expected_version: v });
    expect((await arch(1)).error).toBeNull();
    expect((await arch(1)).error).toBeNull();
    expect((await proposalRow(p)).archived_at).not.toBeNull();
    const edit = await owner.client.rpc("update_proposal", {
      p_wedding: w,
      p_proposal: p,
      p_expected_version: 2,
      p_title: "x",
    });
    expect(edit.error?.code).toBe("55000");
    const add = await addLine(owner, w, p, 2, {});
    expect(add.error?.code).toBe("55000");
  });
});

describe("proposal lines", () => {
  async function fresh() {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    return { w, c, p };
  }

  it("stores every cost mode; a blank amount stays null, not zero; each add bumps the version", async () => {
    const { w, p } = await fresh();
    const fixed = await addLine(owner, w, p, 1, {
      p_description: "Venue fee",
      p_cost_mode: "fixed",
    });
    expect(fixed.error).toBeNull();
    const pg = await addLine(owner, w, p, 2, {
      p_description: "Dinner",
      p_cost_mode: "per_guest",
      p_amount_minor: 9500,
      p_min_qty: 120,
      p_max_qty: 200,
    });
    expect(pg.error).toBeNull();
    const qty = await addLine(owner, w, p, 3, {
      p_description: "Band",
      p_cost_mode: "quantity",
      p_amount_minor: 30000,
      p_quantity: 4,
    });
    expect(qty.error).toBeNull();
    const pct = await addLine(owner, w, p, 4, {
      p_description: "Service",
      p_cost_mode: "percent",
      p_rate_bp: 2200,
    });
    expect(pct.error).toBeNull();
    const inc = await addLine(owner, w, p, 5, {
      p_description: "Chairs",
      p_cost_mode: "included",
      p_included_in_line_id: fixed.data,
    });
    expect(inc.error).toBeNull();
    expect((await proposalRow(p)).version).toBe(6);
    const rows = await lineRows(p);
    expect(rows.map((r) => r.cost_mode)).toEqual([
      "fixed",
      "per_guest",
      "quantity",
      "percent",
      "included",
    ]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ amount_minor: null, required: true, certainty: "quoted" });
    expect(rows[1]?.amount_minor).toBe("9500");
    expect(rows[4]?.included_in_line_id).toBe(fixed.data);
  });

  it("a typed zero is stored as zero, distinct from unknown", async () => {
    const { w, p } = await fresh();
    await addLine(owner, w, p, 1, { p_amount_minor: 0 });
    expect((await lineRows(p))[0]?.amount_minor).toBe("0");
  });

  it("rejects field combinations that don't fit the mode", async () => {
    const { w, p } = await fresh();
    const base = await addLine(owner, w, p, 1, { p_amount_minor: 1000 });
    const v = 2;
    const cases: Line[] = [
      { p_cost_mode: "percent" }, // rate missing
      { p_cost_mode: "percent", p_rate_bp: 0 },
      { p_cost_mode: "percent", p_rate_bp: 10001 },
      { p_cost_mode: "percent", p_rate_bp: 500, p_amount_minor: 100 },
      { p_cost_mode: "percent", p_rate_bp: 500, p_percent_base: true }, // a percentage can't be a base
      { p_cost_mode: "fixed", p_rate_bp: 500 },
      { p_cost_mode: "fixed", p_quantity: 2 },
      { p_cost_mode: "fixed", p_min_qty: 2 },
      { p_cost_mode: "per_guest", p_min_qty: 50, p_max_qty: 40 },
      { p_cost_mode: "included" }, // no parent
      { p_cost_mode: "included", p_included_in_line_id: base.data, p_amount_minor: 5 },
      { p_cost_mode: "fixed", p_included_in_line_id: base.data },
      { p_cost_mode: "included", p_included_in_line_id: randomUUID() },
      { p_cost_mode: "fixed", p_amount_minor: 100000001 },
      { p_cost_mode: "fixed", p_amount_minor: -1 },
      { p_cost_mode: "quantity", p_quantity: 100001 },
      { p_cost_mode: "fixed", p_certainty: "verified" },
      { p_cost_mode: "magic" },
      { p_description: " " },
      { p_cost_mode: "fixed", p_evidence: "e".repeat(501) },
    ];
    for (const c of cases) {
      const r = await addLine(owner, w, p, v, c);
      expect(r.error, JSON.stringify(c)).not.toBeNull();
      expect(["22023", "23514"]).toContain(r.error?.code);
    }
    expect((await lineRows(p)).length).toBe(1);
    expect((await proposalRow(p)).version).toBe(v); // failed adds never bump
  });

  it("an inclusion must point at an additive line of the same proposal, one level deep", async () => {
    const { w, c, p } = await fresh();
    const other = await quote(owner, w, c);
    const parent = await addLine(owner, w, p, 1, { p_amount_minor: 1000 });
    const foreign = await addLine(owner, w, other, 1, { p_amount_minor: 1000 });
    const pct = await addLine(owner, w, p, 2, { p_cost_mode: "percent", p_rate_bp: 100 });
    const inc = await addLine(owner, w, p, 3, {
      p_cost_mode: "included",
      p_included_in_line_id: parent.data,
    });
    expect(inc.error).toBeNull();
    const toForeign = await addLine(owner, w, p, 4, {
      p_cost_mode: "included",
      p_included_in_line_id: foreign.data,
    });
    expect(toForeign.error?.code).toBe("22023");
    const toPercent = await addLine(owner, w, p, 4, {
      p_cost_mode: "included",
      p_included_in_line_id: pct.data,
    });
    expect(toPercent.error?.code).toBe("22023");
    const toIncluded = await addLine(owner, w, p, 4, {
      p_cost_mode: "included",
      p_included_in_line_id: inc.data,
    });
    expect(toIncluded.error?.code).toBe("22023");
  });

  it("a cost others are included in can't be removed or turned into an inclusion or percentage", async () => {
    const { w, p } = await fresh();
    const parent = await addLine(owner, w, p, 1, { p_amount_minor: 1000 });
    await addLine(owner, w, p, 2, { p_cost_mode: "included", p_included_in_line_id: parent.data });
    const remove = await owner.client.rpc("remove_proposal_line", {
      p_wedding: w,
      p_line: parent.data,
      p_expected_version: 3,
    });
    expect(remove.error?.code).toBe("23503");
    const toPercent = await owner.client.rpc("update_proposal_line", {
      p_wedding: w,
      p_line: parent.data,
      p_expected_version: 3,
      p_description: "x",
      p_cost_mode: "percent",
      p_rate_bp: 100,
    });
    expect(toPercent.error?.code).toBe("23503");
    const self = await owner.client.rpc("update_proposal_line", {
      p_wedding: w,
      p_line: parent.data,
      p_expected_version: 3,
      p_description: "x",
      p_cost_mode: "included",
      p_included_in_line_id: parent.data,
    });
    expect(self.error).not.toBeNull();
    expect((await lineRows(p)).length).toBe(2);
    expect((await proposalRow(p)).version).toBe(3);
  });

  it("updates a line, clears amounts back to unknown, and treats an identical save as a no-op", async () => {
    const { w, p } = await fresh();
    const line = await addLine(owner, w, p, 1, { p_amount_minor: 5000, p_evidence: "email" });
    const upd = (v: number, extra: Line) =>
      owner.client.rpc("update_proposal_line", {
        p_wedding: w,
        p_line: line.data,
        p_expected_version: v,
        p_description: "Dinner",
        p_cost_mode: "fixed",
        ...extra,
      });
    expect((await upd(2, { p_amount_minor: 5000, p_evidence: "email" })).data).toBe(2); // no-op
    expect((await upd(2, { p_certainty: "estimated" })).data).toBe(3);
    const rows = await lineRows(p);
    expect(rows[0]).toMatchObject({ amount_minor: null, certainty: "estimated" });
    const stale = await upd(2, { p_amount_minor: 1 });
    expect(stale.error?.code).toBe("55000");
  });

  it("removes a line and bumps the version", async () => {
    const { w, p } = await fresh();
    const line = await addLine(owner, w, p, 1, {});
    const r = await owner.client.rpc("remove_proposal_line", {
      p_wedding: w,
      p_line: line.data,
      p_expected_version: 2,
    });
    expect(r.data).toBe(3);
    expect(await lineRows(p)).toHaveLength(0);
  });

  it("add is idempotent under replay and concurrent submits; a changed body with the same key is refused", async () => {
    const { w, p } = await fresh();
    const key = `line-${randomUUID()}`;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => addLine(owner, w, p, 1, { p_idempotency_key: key })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(await lineRows(p)).toHaveLength(1);
    // A replay after the proposal moved on still returns the original line.
    const replay = await addLine(owner, w, p, 1, { p_idempotency_key: key });
    expect(replay.data).toBe(results[0]?.data);
    const diff = await addLine(owner, w, p, 1, { p_idempotency_key: key, p_description: "Other" });
    expect(diff.error?.code).toBe("23505");
  });

  it("of concurrent adds from the same version exactly one wins", async () => {
    const { w, p } = await fresh();
    const results = await Promise.all(
      ["A", "B", "C"].map((d) => addLine(owner, w, p, 1, { p_description: d })),
    );
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(2);
    expect(await lineRows(p)).toHaveLength(1);
  });

  it("caps lines per quote", async () => {
    const { w, p } = await fresh();
    for (let i = 0; i < 60; i += 1) {
      const r = await addLine(owner, w, p, i + 1, { p_description: `Cost ${i}` });
      expect(r.error).toBeNull();
    }
    expect((await addLine(owner, w, p, 61, {})).error?.code).toBe("54000");
  });

  it("audits line changes without amounts or free text", async () => {
    const { w, p } = await fresh();
    await addLine(owner, w, p, 1, {
      p_amount_minor: 123456,
      p_evidence: "private-evidence-text",
      p_description: "private-description",
    });
    const text = JSON.stringify(await audit(w, "proposal"));
    expect(text).toContain("proposal.line_added");
    expect(text).not.toContain("123456");
    expect(text).not.toContain("private-evidence-text");
    expect(text).not.toContain("private-description");
  });
});

describe("authorization and isolation", () => {
  it("owner and partner write; editor and viewer read but cannot write", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const line = await addLine(owner, w, p, 1, { p_amount_minor: 100 });
    const partner = await addMember(w, "partner", "quote-partner");
    const editor = await addMember(w, "editor", "quote-editor");
    const viewer = await addMember(w, "viewer", "quote-viewer");

    expect((await newQuote(partner, w, c)).error).toBeNull();
    for (const user of [editor, viewer]) {
      expect((await user.client.from("proposals").select("id").eq("id", p)).data).toHaveLength(1);
      expect(
        (await user.client.from("proposal_lines").select("id").eq("proposal_id", p)).data,
      ).toHaveLength(1);
      expect((await newQuote(user, w, c)).error?.code).toBe("42501");
      expect((await addLine(user, w, p, 2, {})).error?.code).toBe("42501");
      expect(
        (
          await user.client.rpc("update_proposal_line", {
            p_wedding: w,
            p_line: line.data,
            p_expected_version: 2,
            p_description: "x",
            p_cost_mode: "fixed",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("remove_proposal_line", {
            p_wedding: w,
            p_line: line.data,
            p_expected_version: 2,
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("update_proposal", {
            p_wedding: w,
            p_proposal: p,
            p_expected_version: 2,
            p_title: "x",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("set_proposal_status", {
            p_wedding: w,
            p_proposal: p,
            p_expected_version: 2,
            p_status: "declined",
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("archive_proposal", {
            p_wedding: w,
            p_proposal: p,
            p_expected_version: 2,
          })
        ).error?.code,
      ).toBe("42501");
      expect(
        (
          await user.client.rpc("set_candidate_stage", {
            p_wedding: w,
            p_candidate: c,
            p_expected_version: 1,
            p_stage: "contacted",
          })
        ).error?.code,
      ).toBe("42501");
    }
    expect((await proposalRow(p)).version).toBe(2);
    expect((await candidateRow(c)).stage).toBe("saved");
  });

  it("another tenant cannot read quotes and gets indistinguishable errors on every write", async () => {
    const wa = await createWedding(owner);
    const c = await venue(owner, wa);
    const p = await quote(owner, wa, c);
    const line = await addLine(owner, wa, p, 1, { p_amount_minor: 100 });
    const other = await createUser("quote-other");
    const wb = await createWedding(other);

    expect((await other.client.from("proposals").select("id").eq("id", p)).data).toEqual([]);
    expect(
      (await other.client.from("proposal_lines").select("id").eq("proposal_id", p)).data,
    ).toEqual([]);

    const attempts = [
      other.client.rpc("create_proposal", { p_wedding: wb, p_candidate: c, p_title: "x" }),
      other.client.rpc("create_proposal", { p_wedding: wa, p_candidate: c, p_title: "x" }),
      other.client.rpc("update_proposal", {
        p_wedding: wb,
        p_proposal: p,
        p_expected_version: 2,
        p_title: "x",
      }),
      other.client.rpc("add_proposal_line", {
        p_wedding: wb,
        p_proposal: p,
        p_expected_version: 2,
        p_description: "x",
        p_cost_mode: "fixed",
      }),
      other.client.rpc("update_proposal_line", {
        p_wedding: wb,
        p_line: line.data,
        p_expected_version: 2,
        p_description: "x",
        p_cost_mode: "fixed",
      }),
      other.client.rpc("remove_proposal_line", {
        p_wedding: wb,
        p_line: line.data,
        p_expected_version: 2,
      }),
      other.client.rpc("set_proposal_status", {
        p_wedding: wb,
        p_proposal: p,
        p_expected_version: 2,
        p_status: "declined",
      }),
      other.client.rpc("archive_proposal", { p_wedding: wb, p_proposal: p, p_expected_version: 2 }),
      other.client.rpc("set_candidate_stage", {
        p_wedding: wb,
        p_candidate: c,
        p_expected_version: 1,
        p_stage: "contacted",
      }),
      other.client.rpc("update_proposal", {
        p_wedding: randomUUID(),
        p_proposal: p,
        p_expected_version: 2,
        p_title: "x",
      }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.error?.code).toBe("42501");
      expect(r.error?.message).toBe("not permitted");
    }
    expect(await proposalRow(p)).toMatchObject({
      version: 2,
      title: "Saturday package",
      status: "open",
    });
    expect((await candidateRow(c)).stage).toBe("saved");
  });

  it("denies anonymous callers and direct table writes", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    const anon = anonClient();
    expect(
      (await anon.rpc("create_proposal", { p_wedding: w, p_candidate: c, p_title: "x" })).error,
    ).not.toBeNull();
    expect((await anon.from("proposals").select("id")).data ?? []).toEqual([]);
    expect((await anon.from("proposal_lines").select("id")).data ?? []).toEqual([]);

    expect(
      (
        await owner.client
          .from("proposals")
          .insert({ wedding_id: w, candidate_id: c, title: "x", currency: "USD" })
      ).error,
    ).not.toBeNull();
    expect(
      (await owner.client.from("proposals").update({ title: "hacked" }).eq("id", p)).error?.code,
    ).toBeDefined();
    expect(
      (
        await owner.client.from("proposal_lines").insert({
          wedding_id: w,
          proposal_id: p,
          position: 0,
          description: "x",
          cost_mode: "fixed",
        })
      ).error,
    ).not.toBeNull();
    expect((await proposalRow(p)).title).toBe("Saturday package");
    expect(await lineRows(p)).toHaveLength(0);
  });

  it("the database itself refuses a quote or line that mixes tenants", async () => {
    const wa = await createWedding(owner);
    const wb = await createWedding(owner);
    const ca = await venue(owner, wa);
    const pa = await quote(owner, wa, ca);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.proposals (wedding_id, candidate_id, title, currency) values ($1,$2,'x','USD')",
          [wb, ca],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      withSuperuser((db) =>
        db.query(
          "insert into public.proposal_lines (wedding_id, proposal_id, position, description, cost_mode) values ($1,$2,0,'x','fixed')",
          [wb, pa],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("deleting the wedding cascades to quotes and lines", async () => {
    const w = await createWedding(owner);
    const c = await venue(owner, w);
    const p = await quote(owner, w, c);
    await addLine(owner, w, p, 1, {});
    await withSuperuser((db) => db.query("delete from public.weddings where id=$1", [w]));
    const left = await withSuperuser((db) =>
      db.query(
        "select (select count(*) from public.proposals where wedding_id=$1) a, (select count(*) from public.proposal_lines where wedding_id=$1) b",
        [w],
      ),
    );
    expect(left.rows[0]).toEqual({ a: "0", b: "0" });
  });
});
