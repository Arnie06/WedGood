import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-11: the couple's own RSVP questions. Real local Postgres, PostgREST and RLS.
// Every name and answer below is synthetic.

let owner: TestUser;
let stranger: TestUser;
let viewer: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newToken = () => {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha(raw) };
};
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  owner = await createUser("forms-owner");
  stranger = await createUser("forms-stranger");
  viewer = await createUser("forms-viewer");
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}
const mkGuest = async (w: string, name: string, household: string | null = null) =>
  (await ok(
    owner.client.rpc("create_guest", {
      p_wedding: w,
      p_guest: { name },
      ...(household && { p_household: household }),
    }),
  )) as string;
const mkHousehold = async (w: string, name: string) =>
  (
    await q<{ id: string }>(
      "insert into public.households (wedding_id, name) values ($1,$2) returning id",
      [w, name],
    )
  )[0]!.id;
const mkEvent = async (w: string, name: string) =>
  (await ok(
    owner.client.rpc("create_event", { p_wedding: w, p_event: { name, kind: "other" } }),
  )) as string;
async function invite(w: string, e: string, guestIds: string[], hh: string | null, quota = 0) {
  const t = newToken();
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: w,
      p_event_id: e,
      p_groups: [{ guestIds, householdId: hh }],
      p_plus_one_quota: quota,
      p_expires_at: future(30),
      p_token_hashes: [t.hash],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { id: rows[0]!.o_invitation_id, token: t };
}

const SHUTTLE = "q_shuttle1";
const SONG = "q_song0001";
const ARRIVE = "q_arrive01";
const question = (over: Record<string, unknown>) => ({
  help: null,
  required: false,
  options: [],
  ...over,
});
const baseForm = {
  questions: [
    question({ key: SHUTTLE, type: "yes_no", label: "Need the shuttle?", required: true }),
    question({ key: SONG, type: "text", label: "Song request" }),
    question({
      key: ARRIVE,
      type: "choice",
      label: "Arriving",
      options: [
        { key: "o_friday", label: "Friday" },
        { key: "o_satday", label: "Saturday" },
      ],
    }),
  ],
};

const saveDraft = (w: string, e: string, version: number, draft: unknown, as = owner) =>
  as.client.rpc("save_rsvp_form_draft", {
    p_wedding: w,
    p_event_id: e,
    p_expected_version: version,
    p_draft: draft,
  });
const publish = (w: string, e: string, version: number, as = owner) =>
  as.client.rpc("publish_rsvp_form", { p_wedding: w, p_event_id: e, p_expected_version: version });

type Member = { id: string; name: string; isPlusOne: boolean; answered: string[] };
type Form = { versionId: string; version: number; questions: { key: string }[] } | null;
type View = { version: number; form: Form; members: Member[] };
const view = async (raw: string) =>
  (await adminClient().rpc("rsvp_view", { p_token_hash: sha(raw), p_client: client() }))
    .data as View;
const submit = (
  raw: string,
  version: number,
  responses: unknown[],
  form: string | null,
  plusOne?: unknown,
) =>
  adminClient().rpc("rsvp_submit", {
    p_token_hash: sha(raw),
    p_client: client(),
    p_expected_version: version,
    p_responses: responses,
    ...(plusOne ? { p_plus_one: plusOne } : {}),
    ...(form ? { p_form_version: form } : {}),
  });
const accept = (m: Member, answers?: Record<string, string>) => ({
  memberId: m.id,
  status: "accepted",
  mealOptionId: null,
  ...(answers && { answers }),
});
const answersOf = async (memberId: string) =>
  Object.fromEntries(
    (
      await q<{ question_key: string; value: string }>(
        "select question_key, value from public.rsvp_answers where member_id=$1",
        [memberId],
      )
    ).map((r) => [r.question_key, r.value]),
  );

/** A wedding with one event, Ada and Bo invited, and the base form published as version 1. */
async function setup(opts: { publish?: boolean; quota?: number } = {}) {
  const w = await createWedding(owner);
  const hh = await mkHousehold(w, "The Examples");
  const e = await mkEvent(w, "Reception");
  const ada = await mkGuest(w, "Ada Example", hh);
  const bo = await mkGuest(w, "Bo Example", hh);
  const inv = await invite(w, e, [ada, bo], hh, opts.quota ?? 0);
  const v1 = (await ok(saveDraft(w, e, 0, baseForm))) as number;
  if (opts.publish !== false) await ok(publish(w, e, v1));
  const v = await view(inv.token.raw);
  const adaM = v.members.find((m) => m.name === "Ada Example")!;
  const boM = v.members.find((m) => m.name === "Bo Example")!;
  return { w, e, inv, v, adaM, boM, formVersion: v1 };
}

describe("drafts and publishing", () => {
  it("keeps drafts away from guests until published, then versions each publish", async () => {
    const s = await setup({ publish: false });
    expect(s.v.form).toBeNull();
    // Saving changes the draft version; publishing makes version 1 visible.
    expect(await ok(publish(s.w, s.e, s.formVersion))).toBe(1);
    const after = await view(s.inv.token.raw);
    expect(after.form?.version).toBe(1);
    expect(after.form?.questions.map((x) => x.key)).toEqual([SHUTTLE, SONG, ARRIVE]);

    // Re-publishing the same draft writes nothing new.
    const formRow = (
      await q<{ version: number }>("select version from public.rsvp_forms where event_id=$1", [s.e])
    )[0]!;
    expect(await ok(publish(s.w, s.e, formRow.version))).toBe(1);
    expect(
      (await q("select 1 from public.rsvp_form_versions where event_id=$1", [s.e])).length,
    ).toBe(1);

    // A new draft is not seen until published as version 2.
    const v2 = (await ok(
      saveDraft(s.w, s.e, formRow.version, { questions: baseForm.questions.slice(0, 1) }),
    )) as number;
    expect((await view(s.inv.token.raw)).form?.version).toBe(1);
    expect(await ok(publish(s.w, s.e, v2))).toBe(2);
    expect((await view(s.inv.token.raw)).form?.questions).toHaveLength(1);
  });

  it("normalizes the stored definition", async () => {
    const s = await setup({ publish: false });
    const row = (
      await q<{ version: number }>("select version from public.rsvp_forms where event_id=$1", [s.e])
    )[0]!;
    await ok(
      saveDraft(s.w, s.e, row.version, {
        questions: [
          question({
            key: SONG,
            type: "text",
            label: "  Song   request ",
            help: "  ",
            options: null,
          }),
        ],
      }),
    );
    const [stored] = await q<{ draft: { questions: Record<string, unknown>[] } }>(
      "select draft from public.rsvp_forms where event_id=$1",
      [s.e],
    );
    expect(stored!.draft.questions[0]).toEqual({
      key: SONG,
      type: "text",
      label: "Song request",
      help: null,
      required: false,
      options: [],
    });
  });

  it("refuses a stale draft version", async () => {
    const s = await setup();
    const r = await saveDraft(s.w, s.e, s.formVersion, baseForm);
    expect(r.error?.code).toBe("55000");
    const create = await saveDraft(s.w, await mkEvent(s.w, "Brunch"), 3, baseForm);
    expect(create.error?.code).toBe("55000");
  });

  it.each([
    [
      "eleven questions",
      {
        questions: Array.from({ length: 11 }, (_, i) =>
          question({ key: `q_${String(i).padStart(8, "0")}`, type: "text", label: "x" }),
        ),
      },
    ],
    ["a blank label", { questions: [question({ key: SONG, type: "text", label: "   " })] }],
    ["a bad key", { questions: [question({ key: "song", type: "text", label: "x" })] }],
    [
      "a duplicate key",
      {
        questions: [
          question({ key: SONG, type: "text", label: "x" }),
          question({ key: SONG, type: "text", label: "y" }),
        ],
      },
    ],
    [
      "a choice with one option",
      {
        questions: [
          question({
            key: ARRIVE,
            type: "choice",
            label: "x",
            options: [{ key: "o_friday", label: "F" }],
          }),
        ],
      },
    ],
    [
      "duplicate choice labels",
      {
        questions: [
          question({
            key: ARRIVE,
            type: "choice",
            label: "x",
            options: [
              { key: "o_friday", label: "Fri" },
              { key: "o_satday", label: " fri " },
            ],
          }),
        ],
      },
    ],
    [
      "options on a yes/no question",
      {
        questions: [
          question({
            key: SHUTTLE,
            type: "yes_no",
            label: "x",
            options: [{ key: "o_friday", label: "F" }],
          }),
        ],
      },
    ],
    ["an unknown type", { questions: [question({ key: SONG, type: "number", label: "x" })] }],
  ])("refuses a draft with %s", async (_name, draft) => {
    const w = await createWedding(owner);
    const e = await mkEvent(w, "Reception");
    const r = await saveDraft(w, e, 0, draft);
    expect(r.error?.code).toBe("22023");
    expect((await q("select 1 from public.rsvp_forms where event_id=$1", [e])).length).toBe(0);
  });

  it("keeps a published question's type for the life of the form", async () => {
    const s = await setup();
    const row = (
      await q<{ version: number }>("select version from public.rsvp_forms where event_id=$1", [s.e])
    )[0]!;
    const changed = {
      questions: [question({ key: SHUTTLE, type: "text", label: "Need the shuttle?" })],
    };
    expect((await saveDraft(s.w, s.e, row.version, changed)).error?.code).toBe("RF409");
    // Removing it and adding a new key is fine.
    const replaced = {
      questions: [question({ key: "q_shuttle2", type: "text", label: "Shuttle notes" })],
    };
    expect((await saveDraft(s.w, s.e, row.version, replaced)).error).toBeNull();
  });

  it("only lets people who manage guests read or write forms", async () => {
    const s = await setup();
    await q("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'viewer')", [
      s.w,
      viewer.id,
    ]);
    for (const who of [stranger, viewer]) {
      expect((await saveDraft(s.w, s.e, 2, baseForm, who)).error?.code).toBe("42501");
      expect((await publish(s.w, s.e, 2, who)).error?.code).toBe("42501");
      for (const table of ["rsvp_forms", "rsvp_form_versions", "rsvp_answers"]) {
        const r = await who.client.from(table).select("*").eq("wedding_id", s.w);
        expect(r.data).toEqual([]);
      }
    }
    // An event of another wedding is not reachable.
    const other = await createWedding(owner);
    expect((await saveDraft(other, s.e, 0, baseForm)).error?.code).toBe("42501");
    // Published versions are append-only.
    await expect(
      q("update public.rsvp_form_versions set version = 9 where event_id=$1", [s.e]),
    ).rejects.toThrow(/append-only/);
  });

  it("records publishing in the audit trail without question text", async () => {
    const s = await setup();
    const rows = await q<{ action: string; safe_changes: Record<string, unknown> }>(
      "select action, safe_changes from public.audit_events where wedding_id=$1 and entity_type='rsvp_form' order by occurred_at, id",
      [s.w],
    );
    expect(rows.map((r) => r.action)).toEqual(["rsvp_form.draft_saved", "rsvp_form.published"]);
    expect(rows[1]!.safe_changes).toEqual({ version: 1, questions: 3 });
    expect(JSON.stringify(rows)).not.toContain("shuttle");
  });
});

describe("guest answers", () => {
  it("stores answers for attending people and never sends them back", async () => {
    const s = await setup();
    const sent = await submit(
      s.inv.token.raw,
      s.v.version,
      [
        accept(s.adaM, { [SHUTTLE]: "yes", [SONG]: "  Sentinel tune  ", [ARRIVE]: "o_friday" }),
        {
          memberId: s.boM.id,
          status: "declined",
          mealOptionId: null,
          answers: { [SHUTTLE]: "no" },
        },
      ],
      s.v.form!.versionId,
    );
    expect(sent.error).toBeNull();
    expect(await answersOf(s.adaM.id)).toEqual({
      [SHUTTLE]: "yes",
      [SONG]: "Sentinel tune",
      [ARRIVE]: "o_friday",
    });
    // A decline carries no answers.
    expect(await answersOf(s.boM.id)).toEqual({});
    const after = sent.data as View;
    expect(after.members.find((m) => m.id === s.adaM.id)!.answered).toEqual([
      ARRIVE,
      SHUTTLE,
      SONG,
    ]);
    expect(JSON.stringify(after)).not.toContain("Sentinel");
    expect(JSON.stringify(await view(s.inv.token.raw))).not.toContain("Sentinel");
  });

  it("records the form version and answer count, keeps text out of audit and history", async () => {
    const s = await setup();
    await ok(
      submit(
        s.inv.token.raw,
        s.v.version,
        [accept(s.adaM, { [SHUTTLE]: "yes", [SONG]: "Sentinel" })],
        s.v.form!.versionId,
      ),
    );
    const [sub] = await q<Record<string, unknown>>(
      "select * from public.rsvp_submissions where invitation_id=$1",
      [s.inv.id],
    );
    expect(sub).toMatchObject({
      form_version: 1,
      form_version_id: s.v.form!.versionId,
      answers_count: 1,
    });
    const [audit] = await q<{ safe_changes: Record<string, unknown> }>(
      "select safe_changes from public.audit_events where entity_id=$1 and action='rsvp.responded'",
      [s.inv.id],
    );
    expect(audit!.safe_changes).toEqual({
      accepted: 1,
      declined: 0,
      plus_one_added: false,
      answers: 1,
    });
    const history = await q("select * from public.rsvp_changes where wedding_id=$1", [s.w]);
    const audits = await q("select * from public.audit_events where wedding_id=$1", [s.w]);
    expect(JSON.stringify([history, audits, sub])).not.toContain("Sentinel");
  });

  it("is idempotent: the same answers again change nothing", async () => {
    const s = await setup();
    const first = await ok(
      submit(
        s.inv.token.raw,
        s.v.version,
        [accept(s.adaM, { [SHUTTLE]: "yes" })],
        s.v.form!.versionId,
      ),
    );
    const again = await submit(
      s.inv.token.raw,
      (first as View).version,
      [accept(s.adaM, { [SHUTTLE]: "yes" })],
      s.v.form!.versionId,
    );
    expect(again.error).toBeNull();
    expect((again.data as View).version).toBe((first as View).version);
    expect(
      (await q("select 1 from public.rsvp_submissions where invitation_id=$1", [s.inv.id])).length,
    ).toBe(1);
  });

  it("treats an answers-only change as a change: the version moves and a stale tab is refused", async () => {
    const s = await setup();
    const first = (await ok(
      submit(
        s.inv.token.raw,
        s.v.version,
        [accept(s.adaM, { [SHUTTLE]: "yes" })],
        s.v.form!.versionId,
      ),
    )) as View;
    const second = await submit(
      s.inv.token.raw,
      first.version,
      [accept(s.adaM, { [SHUTTLE]: "no" })],
      s.v.form!.versionId,
    );
    expect(second.error).toBeNull();
    expect((second.data as View).version).toBe(first.version + 1);
    expect(await answersOf(s.adaM.id)).toMatchObject({ [SHUTTLE]: "no" });
    const stale = await submit(
      s.inv.token.raw,
      first.version,
      [accept(s.adaM, { [SHUTTLE]: "yes" })],
      s.v.form!.versionId,
    );
    expect(stale.error?.code).toBe("55000");
  });

  it("needs required questions answered now or earlier (blank keeps the stored answer)", async () => {
    const s = await setup();
    const missing = await submit(
      s.inv.token.raw,
      s.v.version,
      [accept(s.adaM, { [SONG]: "x" })],
      s.v.form!.versionId,
    );
    expect(missing.error?.code).toBe("RF422");
    expect(await answersOf(s.adaM.id)).toEqual({});
    const first = (await ok(
      submit(
        s.inv.token.raw,
        s.v.version,
        [accept(s.adaM, { [SHUTTLE]: "yes" })],
        s.v.form!.versionId,
      ),
    )) as View;
    const later = await submit(
      s.inv.token.raw,
      first.version,
      [accept(s.adaM, { [SHUTTLE]: " ", [SONG]: "x" })],
      s.v.form!.versionId,
    );
    expect(later.error).toBeNull();
    expect(await answersOf(s.adaM.id)).toEqual({ [SHUTTLE]: "yes", [SONG]: "x" });
  });

  it.each([
    ["an unknown question", { q_unknown1: "x" }],
    ["a yes/no answer that is not yes or no", { [SHUTTLE]: "maybe" }],
    ["a choice that is not an option", { [SHUTTLE]: "yes", [ARRIVE]: "o_sunday" }],
    ["text over 500 characters", { [SHUTTLE]: "yes", [SONG]: "x".repeat(501) }],
    ["a non-string value", { [SHUTTLE]: true }],
  ])("refuses %s and writes nothing", async (_name, answers) => {
    const s = await setup();
    const r = await submit(
      s.inv.token.raw,
      s.v.version,
      [accept(s.adaM, answers as Record<string, string>)],
      s.v.form!.versionId,
    );
    expect(r.error?.code).toBe("22023");
    expect(await answersOf(s.adaM.id)).toEqual({});
    expect((await view(s.inv.token.raw)).members.every((m) => m.answered.length === 0)).toBe(true);
  });

  it("refuses a send against a replaced form, so the guest sees the new questions", async () => {
    const s = await setup();
    const row = (
      await q<{ version: number }>("select version from public.rsvp_forms where event_id=$1", [s.e])
    )[0]!;
    const v = (await ok(
      saveDraft(s.w, s.e, row.version, { questions: baseForm.questions.slice(1) }),
    )) as number;
    await ok(publish(s.w, s.e, v));
    const stale = await submit(
      s.inv.token.raw,
      s.v.version,
      [accept(s.adaM, { [SHUTTLE]: "yes" })],
      s.v.form!.versionId,
    );
    expect(stale.error?.code).toBe("55000");
    expect(await answersOf(s.adaM.id)).toEqual({});
  });

  it("accepts a reply that names no form (switch off), but not answers without a form", async () => {
    const s = await setup();
    const plain = await submit(s.inv.token.raw, s.v.version, [accept(s.adaM)], null);
    expect(plain.error).toBeNull();
    const [sub] = await q<Record<string, unknown>>(
      "select form_version, form_version_id from public.rsvp_submissions where invitation_id=$1",
      [s.inv.id],
    );
    expect(sub).toEqual({ form_version: 1, form_version_id: null });
    const sneaky = await submit(
      s.inv.token.raw,
      (plain.data as View).version,
      [accept(s.adaM, { [SHUTTLE]: "yes" })],
      null,
    );
    expect(sneaky.error?.code).toBe("22023");
  });

  it("refuses another event's form version", async () => {
    const s = await setup();
    const other = await mkEvent(s.w, "Brunch");
    const v = (await ok(saveDraft(s.w, other, 0, baseForm))) as number;
    await ok(publish(s.w, other, v));
    const [otherVersion] = await q<{ id: string }>(
      "select id from public.rsvp_form_versions where event_id=$1",
      [other],
    );
    const r = await submit(
      s.inv.token.raw,
      s.v.version,
      [accept(s.adaM, { [SHUTTLE]: "yes" })],
      otherVersion!.id,
    );
    expect(r.error?.code).toBe("55000");
  });

  it("stores the new plus-one's answers with them", async () => {
    const s = await setup({ quota: 1 });
    const sent = await submit(
      s.inv.token.raw,
      s.v.version,
      [accept(s.adaM, { [SHUTTLE]: "no" })],
      s.v.form!.versionId,
      { name: "Cy  Plusone", mealOptionId: null, answers: { [SHUTTLE]: "yes" } },
    );
    expect(sent.error).toBeNull();
    const cy = (sent.data as View).members.find((m) => m.isPlusOne)!;
    expect(await answersOf(cy.id)).toEqual({ [SHUTTLE]: "yes" });
    // The plus-one must answer required questions too.
    const s2 = await setup({ quota: 1 });
    const r = await submit(
      s2.inv.token.raw,
      s2.v.version,
      [accept(s2.adaM, { [SHUTTLE]: "no" })],
      s2.v.form!.versionId,
      {
        name: "Di Plusone",
        mealOptionId: null,
      },
    );
    expect(r.error?.code).toBe("RF422");
    expect((await view(s2.inv.token.raw)).members.some((m) => m.isPlusOne)).toBe(false);
  });

  it("works through a party link, per event, all or nothing", async () => {
    const s = await setup();
    const e2 = await mkEvent(s.w, "Brunch");
    const [adaRow] = await q<{ guest_id: string; household_id: string }>(
      "select im.guest_id, i.household_id from public.invitation_members im join public.invitations i on i.id = im.invitation_id where im.id=$1",
      [s.adaM.id],
    );
    const inv2 = await invite(s.w, e2, [adaRow!.guest_id], adaRow!.household_id);
    const partyToken = newToken();
    await ok(
      owner.client.rpc("create_party_link", {
        p_wedding: s.w,
        p_invitation_ids: [s.inv.id, inv2.id],
        p_token_hash: partyToken.hash,
        p_expires_at: future(30),
        p_idempotency_key: `party-${randomUUID()}`,
      }),
    );
    type PEvent = View & { invitationId: string };
    const pv = (
      await adminClient().rpc("rsvp_party_view", {
        p_token_hash: partyToken.hash,
        p_client: client(),
      })
    ).data as { events: PEvent[] };
    const rec = pv.events.find((x) => x.invitationId === s.inv.id)!;
    const brunch = pv.events.find((x) => x.invitationId === inv2.id)!;
    expect(rec.form?.version).toBe(1);
    expect(brunch.form).toBeNull();
    const recAda = rec.members.find((m) => m.name === "Ada Example")!;
    const brunchAda = brunch.members[0]!;
    const replies = (answers: Record<string, string>) => [
      {
        invitationId: rec.invitationId,
        expectedVersion: rec.version,
        formVersionId: rec.form!.versionId,
        responses: [accept(recAda, answers)],
        plusOne: null,
      },
      {
        invitationId: brunch.invitationId,
        expectedVersion: brunch.version,
        formVersionId: null,
        responses: [accept(brunchAda)],
        plusOne: null,
      },
    ];
    const partySubmit = (r: unknown) =>
      adminClient().rpc("rsvp_party_submit", {
        p_token_hash: partyToken.hash,
        p_client: client(),
        p_replies: r,
      });
    // Missing required answer on one event: nothing is saved on either.
    expect((await partySubmit(replies({}))).error?.code).toBe("RF422");
    expect(
      (await q("select 1 from public.rsvp_submissions where wedding_id=$1", [s.w])).length,
    ).toBe(0);
    const okSend = await partySubmit(replies({ [SHUTTLE]: "yes" }));
    expect(okSend.error).toBeNull();
    expect(await answersOf(recAda.id)).toEqual({ [SHUTTLE]: "yes" });
    const subs = await q<{
      event_id: string;
      form_version_id: string | null;
      answers_count: number;
    }>(
      "select event_id, form_version_id, answers_count from public.rsvp_submissions where wedding_id=$1",
      [s.w],
    );
    expect(subs.find((x) => x.event_id === s.e)).toMatchObject({
      form_version_id: rec.form!.versionId,
      answers_count: 1,
    });
    expect(subs.find((x) => x.event_id === e2)).toMatchObject({
      form_version_id: null,
      answers_count: 0,
    });
    // A malformed form version id is refused.
    const bad = replies({ [SHUTTLE]: "yes" });
    (bad[0] as Record<string, unknown>).formVersionId = "not-a-uuid";
    expect((await partySubmit(bad)).error?.code).toBe("22023");
  });

  it("lets the couple read answers, and fingerprints differ when answers differ", async () => {
    const s = await setup();
    await ok(
      submit(
        s.inv.token.raw,
        s.v.version,
        [accept(s.adaM, { [SHUTTLE]: "yes" })],
        s.v.form!.versionId,
      ),
    );
    const read = await owner.client
      .from("rsvp_answers")
      .select("question_key, value")
      .eq("wedding_id", s.w);
    expect(read.data).toEqual([{ question_key: SHUTTLE, value: "yes" }]);
    const [h1] = await q<{ a: string; b: string; c: string }>(
      `select app_private.rsvp_payload_hash($1::jsonb, null) a, app_private.rsvp_payload_hash($2::jsonb, null) b,
              app_private.rsvp_payload_hash($3::jsonb, null) c`,
      [
        JSON.stringify([
          { memberId: "m", status: "accepted", mealOptionId: null, answers: { [SHUTTLE]: "yes" } },
        ]),
        JSON.stringify([
          { memberId: "m", status: "accepted", mealOptionId: null, answers: { [SHUTTLE]: "no" } },
        ]),
        JSON.stringify([{ memberId: "m", status: "accepted", mealOptionId: null }]),
      ],
    );
    expect(new Set([h1!.a, h1!.b, h1!.c]).size).toBe(3);
    // A send with no answers hashes exactly as it did before UX-11 (empty answers are ignored).
    const [h2] = await q<{ d: string }>("select app_private.rsvp_payload_hash($1::jsonb, null) d", [
      JSON.stringify([{ memberId: "m", status: "accepted", mealOptionId: null, answers: {} }]),
    ]);
    expect(h2!.d).toBe(h1!.c);
  });
});
