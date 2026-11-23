import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { replyStateText } from "@/domain/guests/guest-mail";
import { adminClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// UX-16: guest email outbox. Real local Postgres, PostgREST and RLS. Every name and address below
// is synthetic (example.test). Nothing is sent anywhere: these tests drive the RPCs only.

let owner: TestUser;
let partner: TestUser;
let stranger: TestUser;
let wedding: string;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const client = () => `c-${randomUUID().slice(0, 12)}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withSuperuser(async (db) => (await db.query(sql, params)).rows as T[]);
}
async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}
async function code(p: PromiseLike<{ error: { code?: string } | null }>): Promise<string | null> {
  return (await p).error?.code ?? null;
}

const mkGuest = async (name: string, email: string | null) =>
  (await ok(
    owner.client.rpc("create_guest", {
      p_wedding: wedding,
      p_guest: email ? { name, email } : { name },
    }),
  )) as string;
const mkEvent = async (name: string) =>
  (await ok(
    owner.client.rpc("create_event", { p_wedding: wedding, p_event: { name, kind: "other" } }),
  )) as string;
async function invite(event: string, guestIds: string[]) {
  const raw = randomBytes(32).toString("base64url");
  const rows = (await ok(
    owner.client.rpc("create_invitations", {
      p_wedding: wedding,
      p_event_id: event,
      p_groups: [{ guestIds, householdId: null }],
      p_plus_one_quota: 0,
      p_expires_at: future(30),
      p_token_hashes: [sha(raw)],
      p_idempotency_key: `key-${randomUUID()}`,
    }),
  )) as { o_invitation_id: string }[];
  return { id: rows[0]!.o_invitation_id, raw };
}

type View = { version: number; members: { id: string; name: string }[] };
const view = async (raw: string) =>
  (await adminClient().rpc("rsvp_view", { p_token_hash: sha(raw), p_client: client() }))
    .data as View;
async function reply(raw: string, statuses: Record<string, "accepted" | "declined">) {
  const v = await view(raw);
  await ok(
    adminClient().rpc("rsvp_submit", {
      p_token_hash: sha(raw),
      p_client: client(),
      p_expected_version: v.version,
      p_responses: v.members
        .filter((m) => statuses[m.name])
        .map((m) => ({ memberId: m.id, status: statuses[m.name], mealOptionId: null })),
    }),
  );
}

/** The fingerprint as the app computes it (domain text + sha256), from a direct read. */
async function appStateHash(invitation: string): Promise<string> {
  const rows = await q<{ guest_id: string; rsvp_status: string; meal_option_id: string | null }>(
    "select guest_id, rsvp_status, meal_option_id from public.invitation_members where invitation_id = $1 and active",
    [invitation],
  );
  return sha(
    replyStateText(
      rows.map((r) => ({
        invitationId: invitation,
        guestId: r.guest_id,
        active: true,
        isPlusOne: false,
        status: r.rsvp_status as "pending",
        mealOptionId: r.meal_option_id,
      })),
      invitation,
    ),
  );
}

type Item = {
  kind: "rsvp_confirmation" | "reply_reminder";
  invitationId: string;
  guestId: string;
  dedupeKey: string;
  stateHash: string;
  subject: string;
  body: string;
};
const item = (
  over: Partial<Item> & Pick<Item, "invitationId" | "guestId" | "stateHash">,
): Item => ({
  kind: "reply_reminder",
  dedupeKey: `k-${randomUUID()}`,
  subject: "Please reply",
  body: "Synthetic body.",
  ...over,
});
const prepare = (items: Item[], as = owner) =>
  as.client.rpc("prepare_guest_messages", { p_wedding: wedding, p_items: items });
const messageFor = async (key: string) =>
  (
    await q<{
      id: string;
      version: number;
      status: string;
      recipient_email: string;
      attempts: number;
    }>(
      "select id, version, status, recipient_email, attempts from public.guest_messages where dedupe_key = $1",
      [key],
    )
  )[0]!;
const begin = (id: string, version: number, as = owner) =>
  as.client.rpc("begin_guest_message_send", {
    p_wedding: wedding,
    p_message: id,
    p_expected_version: version,
  });
const finish = (id: string, version: number, outcome: string, extra: Record<string, string> = {}) =>
  owner.client.rpc("finish_guest_message_send", {
    p_wedding: wedding,
    p_message: id,
    p_version: version,
    p_outcome: outcome,
    ...extra,
  });

beforeAll(async () => {
  owner = await createUser("mail-owner");
  partner = await createUser("mail-partner");
  stranger = await createUser("mail-stranger");
  wedding = await createWedding(owner, { name: "Mail Test Wedding" });
  await q("insert into public.memberships (wedding_id, user_id, role) values ($1,$2,'partner')", [
    wedding,
    partner.id,
  ]);
});

describe("guest_message_state", () => {
  it("matches the app's fingerprint rule exactly", async () => {
    const e = await mkEvent("Fingerprint");
    const a = await mkGuest("Ana Example", "ana@example.test");
    const b = await mkGuest("Ben Example", null);
    const inv = await invite(e, [a, b]);
    await reply(inv.raw, { "Ana Example": "accepted", "Ben Example": "declined" });
    const [db] = await q<{ h: string }>("select app_private.guest_message_state($1) as h", [
      inv.id,
    ]);
    expect(db!.h).toBe(await appStateHash(inv.id));
  });
});

describe("prepare_guest_messages", () => {
  it("copies the address from the guest row, skips repeats, stale state and people without email", async () => {
    const e = await mkEvent("Prepare");
    const a = await mkGuest("Cal Example", "cal@example.test");
    const b = await mkGuest("Dee Example", null);
    const inv = await invite(e, [a, b]);
    const h = await appStateHash(inv.id);
    const key = `remind-${randomUUID()}`;
    const res = await ok(
      prepare([
        item({ invitationId: inv.id, guestId: a, stateHash: h, dedupeKey: key }),
        item({ invitationId: inv.id, guestId: a, stateHash: h, dedupeKey: key }),
        item({ invitationId: inv.id, guestId: b, stateHash: h }),
        item({ invitationId: inv.id, guestId: a, stateHash: "0".repeat(64) }),
      ]),
    );
    expect(res).toEqual({ created: 1, skipped: 3 });
    const m = await messageFor(key);
    expect(m.status).toBe("draft");
    expect(m.recipient_email).toBe("cal@example.test");
  });

  it("only prepares a confirmation once a guest has replied", async () => {
    const e = await mkEvent("Confirm");
    const a = await mkGuest("Eve Example", "eve@example.test");
    const inv = await invite(e, [a]);
    const before = await ok(
      prepare([
        item({
          kind: "rsvp_confirmation",
          invitationId: inv.id,
          guestId: a,
          stateHash: await appStateHash(inv.id),
        }),
      ]),
    );
    expect(before).toEqual({ created: 0, skipped: 1 });
    await reply(inv.raw, { "Eve Example": "accepted" });
    const after = await ok(
      prepare([
        item({
          kind: "rsvp_confirmation",
          invitationId: inv.id,
          guestId: a,
          stateHash: await appStateHash(inv.id),
        }),
      ]),
    );
    expect(after).toEqual({ created: 1, skipped: 0 });
  });

  it("refuses a reminder for someone who replied, and malformed input", async () => {
    const e = await mkEvent("Replied");
    const a = await mkGuest("Fay Example", "fay@example.test");
    const inv = await invite(e, [a]);
    await reply(inv.raw, { "Fay Example": "declined" });
    const h = await appStateHash(inv.id);
    expect(await ok(prepare([item({ invitationId: inv.id, guestId: a, stateHash: h })]))).toEqual({
      created: 0,
      skipped: 1,
    });
    expect(
      await code(
        prepare([
          item({
            invitationId: inv.id,
            guestId: a,
            stateHash: h,
            subject: "Hi\r\nBcc: x@example.test",
          }),
        ]),
      ),
    ).toBe("22023");
  });

  it("is limited to guest managers", async () => {
    const e = await mkEvent("Strangers");
    const a = await mkGuest("Gil Example", "gil@example.test");
    const inv = await invite(e, [a]);
    expect(
      await code(
        prepare(
          [item({ invitationId: inv.id, guestId: a, stateHash: await appStateHash(inv.id) })],
          stranger,
        ),
      ),
    ).toBe("42501");
  });
});

describe("approve and send", () => {
  async function draft(name: string, email: string) {
    const e = await mkEvent(`Send ${name}`);
    const g = await mkGuest(name, email);
    const inv = await invite(e, [g]);
    const key = `k-${randomUUID()}`;
    await ok(
      prepare([
        item({
          invitationId: inv.id,
          guestId: g,
          stateHash: await appStateHash(inv.id),
          dedupeKey: key,
        }),
      ]),
    );
    return { inv, guest: g, msg: await messageFor(key), key };
  }

  it("lets only the owner approve, then records the provider receipt once", async () => {
    const { msg, key } = await draft("Hal Example", "hal@example.test");
    expect(await code(begin(msg.id, msg.version, partner))).toBe("42501");
    expect(await code(begin(msg.id, msg.version, stranger))).toBe("42501");
    const started = (await ok(begin(msg.id, msg.version))) as {
      id: string;
      version: number;
      to: string;
      subject: string;
    };
    expect(started.to).toBe("hal@example.test");
    expect(await code(begin(msg.id, started.version))).toBe("55000"); // already in flight
    expect(
      await code(finish(msg.id, started.version, "succeeded", { p_provider: "dev-sink" })),
    ).toBe("22023"); // no receipt, no success
    await ok(
      finish(msg.id, started.version, "succeeded", {
        p_provider: "dev-sink",
        p_receipt: `dev-sink:${msg.id}`,
      }),
    );
    expect((await messageFor(key)).status).toBe("sent");
    expect(await code(finish(msg.id, started.version, "failed"))).toBe("55000");
    const audit = await q<{ action: string }>(
      "select action from public.audit_events where entity_id = $1 order by occurred_at",
      [msg.id],
    );
    expect(audit.map((a) => a.action)).toEqual(["guest_message.approved", "guest_message.sent"]);
  });

  it("goes back to a draft when nothing could be sent, and allows a retry after a failure", async () => {
    const { msg, key } = await draft("Ida Example", "ida@example.test");
    const s1 = (await ok(begin(msg.id, msg.version))) as { version: number };
    await ok(finish(msg.id, s1.version, "unconfigured"));
    const back = await messageFor(key);
    expect(back.status).toBe("draft");
    const s2 = (await ok(begin(back.id, back.version))) as { version: number };
    await ok(finish(msg.id, s2.version, "failed", { p_error: "Synthetic refusal" }));
    const failed = await messageFor(key);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(2);
    expect(await ok(begin(failed.id, failed.version))).toBeTruthy();
  });

  it("refuses once the reply or the address changed", async () => {
    const one = await draft("Jay Example", "jay@example.test");
    await reply(one.inv.raw, { "Jay Example": "accepted" });
    expect(await code(begin(one.msg.id, one.msg.version))).toBe("GM409");

    const two = await draft("Kay Example", "kay@example.test");
    await q("update public.guests set email = 'kay.new@example.test' where id = $1", [two.guest]);
    expect(await code(begin(two.msg.id, two.msg.version))).toBe("GM409");
  });

  it("can take a stuck send over after ten minutes with the same id", async () => {
    const { msg, key } = await draft("Lee Example", "lee@example.test");
    const s1 = (await ok(begin(msg.id, msg.version))) as { version: number };
    expect(await code(begin(msg.id, s1.version))).toBe("55000");
    await q(
      "update public.guest_messages set sending_since = now() - interval '11 minutes' where id = $1",
      [msg.id],
    );
    const stuck = await messageFor(key); // the touch trigger bumped the version
    const s2 = (await ok(begin(msg.id, stuck.version))) as { id: string };
    expect(s2.id).toBe(msg.id);
    expect((await messageFor(key)).attempts).toBe(2);
  });

  it("discards drafts, and a discarded email cannot be sent", async () => {
    const { msg } = await draft("May Example", "may@example.test");
    const v = (await ok(
      partner.client.rpc("discard_guest_message", {
        p_wedding: wedding,
        p_message: msg.id,
        p_expected_version: msg.version,
      }),
    )) as number;
    expect(await code(begin(msg.id, v))).toBe("55000");
  });
});

describe("row access", () => {
  it("hides messages from non-members and refuses direct writes", async () => {
    const own = await owner.client.from("guest_messages").select("id").eq("wedding_id", wedding);
    expect(own.data?.length ?? 0).toBeGreaterThan(0);
    const theirs = await stranger.client
      .from("guest_messages")
      .select("id")
      .eq("wedding_id", wedding);
    expect(theirs.data).toEqual([]);
    const write = await owner.client
      .from("guest_messages")
      .update({ status: "sent" })
      .eq("wedding_id", wedding)
      .select("id");
    expect(write.error?.code ?? (write.data?.length === 0 ? "none" : "updated")).not.toBe(
      "updated",
    );
    const { count } = await adminClient()
      .from("guest_messages")
      .select("id", { count: "exact", head: true })
      .eq("wedding_id", wedding)
      .eq("status", "sent")
      .is("provider_receipt", null);
    expect(count).toBe(0);
  });
});
