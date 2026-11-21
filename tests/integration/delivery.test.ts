import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser("delivery-owner");
  stranger = await createUser("delivery-stranger");
});

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

async function setup() {
  const w = await createWedding(owner);
  const ev = await owner.client.rpc("create_event", {
    p_wedding: w,
    p_event: { name: "Reception", kind: "reception" },
  });
  const g = await owner.client.rpc("create_guest", {
    p_wedding: w,
    p_guest: { name: "Ada Example" },
  });
  if (ev.error || g.error) throw new Error("setup failed");
  const inv = await owner.client.rpc("create_invitations", {
    p_wedding: w,
    p_event_id: ev.data,
    p_groups: [{ guestIds: [g.data], householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [hash()],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  if (inv.error) throw new Error(inv.error.message);
  return { w, id: inv.data![0].o_invitation_id as string };
}

async function row(id: string) {
  const { data, error } = await owner.client
    .from("invitations")
    .select("delivery_status, delivery_marked_at, version")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

const mark = (u: TestUser, w: string, id: string, version: number, shared: boolean) =>
  u.client.rpc("set_invitation_delivery", {
    p_wedding: w,
    p_invitation_id: id,
    p_expected_version: version,
    p_shared: shared,
  });

describe("invitation delivery ledger", () => {
  it("starts as not sent and records only a manual share, with an audit entry", async () => {
    const { w, id } = await setup();
    const before = await row(id);
    expect(before.delivery_status).toBe("not_sent");
    expect(before.delivery_marked_at).toBeNull();
    expect((await mark(owner, w, id, before.version, true)).error).toBeNull();
    const after = await row(id);
    expect(after.delivery_status).toBe("shared_manually");
    expect(after.delivery_marked_at).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
    const audit = await withSuperuser((db) =>
      db.query(
        "select safe_changes from public.audit_events where entity_id=$1 and action='invitation.marked_shared'",
        [id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].safe_changes).toEqual({});
    expect((await mark(owner, w, id, after.version, false)).error).toBeNull();
    expect((await row(id)).delivery_status).toBe("not_sent");
  });

  it("refuses a stale version, a null flag, and a revoked invitation", async () => {
    const { w, id } = await setup();
    const v = (await row(id)).version;
    expect((await mark(owner, w, id, v + 5, true)).error?.code).toBe("55000");
    const nullFlag = await owner.client.rpc("set_invitation_delivery", {
      p_wedding: w,
      p_invitation_id: id,
      p_expected_version: v,
      p_shared: null,
    });
    expect(nullFlag.error).not.toBeNull();
    expect((await row(id)).delivery_status).toBe("not_sent");
    const revoke = await owner.client.rpc("revoke_invitation", {
      p_wedding: w,
      p_invitation_id: id,
      p_expected_version: v,
    });
    expect(revoke.error).toBeNull();
    expect((await mark(owner, w, id, v + 1, true)).error?.code).toBe("55000");
  });

  it("one of two concurrent marks wins", async () => {
    const { w, id } = await setup();
    const v = (await row(id)).version;
    const results = await Promise.all([mark(owner, w, id, v, true), mark(owner, w, id, v, true)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });

  it("a new link resets the status so a stale 'shared' never describes a dead link", async () => {
    const { w, id } = await setup();
    const v = (await row(id)).version;
    expect((await mark(owner, w, id, v, true)).error).toBeNull();
    const re = await owner.client.rpc("reissue_invitation", {
      p_wedding: w,
      p_invitation_id: id,
      p_expected_version: v + 1,
      p_token_hash: hash(),
    });
    expect(re.error).toBeNull();
    const after = await row(id);
    expect(after.delivery_status).toBe("not_sent");
    expect(after.delivery_marked_at).toBeNull();
  });

  it("denies outsiders and anonymous callers, and the status cannot be written directly", async () => {
    const { w, id } = await setup();
    const v = (await row(id)).version;
    expect((await mark(stranger, w, id, v, true)).error?.code).toBe("42501");
    const anon = await anonClient().rpc("set_invitation_delivery", {
      p_wedding: w,
      p_invitation_id: id,
      p_expected_version: v,
      p_shared: true,
    });
    expect(anon.error).not.toBeNull();
    const direct = await owner.client
      .from("invitations")
      .update({ delivery_status: "shared_manually" })
      .eq("id", id);
    expect(direct.error).not.toBeNull();
    expect((await row(id)).delivery_status).toBe("not_sent");
    const seen = await stranger.client.from("invitations").select("delivery_status").eq("id", id);
    expect(seen.data ?? []).toHaveLength(0);
  });

  it("the table rejects a status without a time (and the reverse)", async () => {
    const { id } = await setup();
    await expect(
      withSuperuser((db) =>
        db.query("update public.invitations set delivery_status='shared_manually' where id=$1", [
          id,
        ]),
      ),
    ).rejects.toThrow();
  });
});
