import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

type Token = { raw: string; hash: string };
function newToken(): Token {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

async function invite(
  actor: TestUser,
  wedding: string,
  email: string,
  role: "partner" | "editor" | "viewer" | "owner" = "partner",
  token = newToken(),
  validFor?: string,
) {
  const { data, error } = await actor.client.rpc("create_collaborator_invite", {
    p_wedding: wedding,
    p_email: email,
    p_role: role,
    p_token_hash: token.hash,
    ...(validFor ? { p_valid_for: validFor } : {}),
  });
  return { id: data as string | null, error, token };
}

async function redeem(user: TestUser, token: Token) {
  const { data, error } = await user.client.rpc("redeem_collaborator_invite", {
    p_token_hash: token.hash,
  });
  return { wedding: data as string | null, error };
}

async function members(user: TestUser, wedding: string) {
  const { data, error } = await user.client.rpc("list_members", { p_wedding: wedding });
  if (error) throw new Error(error.message);
  return data as Array<{
    membership_id: string;
    user_id: string;
    email: string | null;
    role: string;
    version: number;
  }>;
}

/** Owner invites `user` with `role`, who redeems it. Returns their membership row. */
async function join(
  owner: TestUser,
  wedding: string,
  user: TestUser,
  role: "partner" | "editor" | "viewer",
) {
  const inv = await invite(owner, wedding, user.email, role);
  expect(inv.error).toBeNull();
  const r = await redeem(user, inv.token);
  expect(r.error).toBeNull();
  const row = (await members(owner, wedding)).find((m) => m.user_id === user.id);
  if (!row) throw new Error("membership missing after redeem");
  return row;
}

let owner: TestUser;
let wedding: string;

beforeAll(async () => {
  owner = await createUser("owner");
  wedding = await createWedding(owner, { name: "Membership Wedding" });
});

describe("collaborator invites", () => {
  it("lets an owner invite a partner who redeems once, with email match and audit trail", async () => {
    const partner = await createUser("partner");
    const inv = await invite(owner, wedding, partner.email.toUpperCase(), "partner");
    expect(inv.error).toBeNull();

    const r = await redeem(partner, inv.token);
    expect(r.error).toBeNull();
    expect(r.wedding).toBe(wedding);

    const list = await members(owner, wedding);
    expect(list.find((m) => m.user_id === partner.id)).toMatchObject({
      role: "partner",
      email: partner.email,
    });

    // One-time: replay fails with the generic message.
    const replay = await redeem(partner, inv.token);
    expect(replay.error?.message).toBe("invalid or expired invitation");

    await withSuperuser(async (db) => {
      const a = await db.query(
        "select action from public.audit_events where wedding_id=$1 and action like 'invite.%' or action = 'member.joined' order by occurred_at",
        [wedding],
      );
      expect(a.rows.map((r: { action: string }) => r.action)).toEqual(
        expect.arrayContaining(["invite.created", "member.joined"]),
      );
      // Raw token never stored; only the digest, and it is unreadable to clients.
      const t = await db.query("select token_hash from public.collaborator_invites where id=$1", [
        inv.id,
      ]);
      expect(t.rows[0].token_hash).toBe(inv.token.hash);
      expect(
        JSON.stringify(
          (await db.query("select * from public.audit_events where wedding_id=$1", [wedding])).rows,
        ),
      ).not.toContain(inv.token.raw);
    });
  });

  it("denies redemption by a different signed-in user and leaves the invite usable", async () => {
    const intended = await createUser("intended");
    const stranger = await createUser("stranger");
    const inv = await invite(owner, wedding, intended.email, "viewer");
    const bad = await redeem(stranger, inv.token);
    expect(bad.error?.message).toBe("invalid or expired invitation");
    expect((await members(owner, wedding)).some((m) => m.user_id === stranger.id)).toBe(false);
    expect((await redeem(intended, inv.token)).error).toBeNull();
  });

  it("denies redemption without a session and for unknown or malformed tokens", async () => {
    const user = await createUser("nobody");
    expect((await redeem(user, newToken())).error?.message).toBe("invalid or expired invitation");
    const malformed = await user.client.rpc("redeem_collaborator_invite", { p_token_hash: "abc" });
    expect(malformed.error?.message).toBe("invalid or expired invitation");
  });

  it("rejects expired and revoked invitations with the same generic error", async () => {
    const u1 = await createUser("expiring");
    const u2 = await createUser("revoked");
    const expired = await invite(owner, wedding, u1.email, "editor");
    const revoked = await invite(owner, wedding, u2.email, "editor");
    await withSuperuser((db) =>
      db.query(
        "update public.collaborator_invites set expires_at = now() - interval '1 minute' where id=$1",
        [expired.id],
      ),
    );
    const rev = await owner.client.rpc("revoke_collaborator_invite", { p_invite: revoked.id });
    expect(rev.error).toBeNull();

    expect((await redeem(u1, expired.token)).error?.message).toBe("invalid or expired invitation");
    expect((await redeem(u2, revoked.token)).error?.message).toBe("invalid or expired invitation");
    // Revoking twice is a state error, not silent success.
    const again = await owner.client.rpc("revoke_collaborator_invite", { p_invite: revoked.id });
    expect(again.error?.message).toBe("invitation is no longer pending");
  });

  it("only one of two concurrent redemptions of the same token succeeds", async () => {
    const user = await createUser("racer");
    const inv = await invite(owner, wedding, user.email, "viewer");
    const results = await Promise.all([redeem(user, inv.token), redeem(user, inv.token)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    const count = (await members(owner, wedding)).filter((m) => m.user_id === user.id);
    expect(count).toHaveLength(1);
  });

  it("validates role, email, digest, lifetime, duplicates and existing members", async () => {
    const other = await createUser("dupe");
    expect((await invite(owner, wedding, other.email, "owner")).error).not.toBeNull();
    expect((await invite(owner, wedding, "not-an-email", "viewer")).error).not.toBeNull();
    const badHash = await owner.client.rpc("create_collaborator_invite", {
      p_wedding: wedding,
      p_email: other.email,
      p_role: "viewer",
      p_token_hash: "short",
    });
    expect(badHash.error).not.toBeNull();
    expect(
      (await invite(owner, wedding, other.email, "viewer", newToken(), "400 days")).error,
    ).not.toBeNull();
    expect(
      (await invite(owner, wedding, other.email, "viewer", newToken(), "0 seconds")).error,
    ).not.toBeNull();

    expect((await invite(owner, wedding, other.email, "viewer")).error).toBeNull();
    expect((await invite(owner, wedding, other.email, "viewer")).error?.message).toMatch(
      /already pending/,
    );

    expect((await invite(owner, wedding, owner.email, "viewer")).error?.message).toMatch(
      /already a member/,
    );
  });

  it("denies a removed member's old invite from reactivating someone else and lets a removed member rejoin by new invite", async () => {
    const user = await createUser("rejoin");
    const row = await join(owner, wedding, user, "editor");
    expect(
      (
        await owner.client.rpc("remove_member", {
          p_membership: row.membership_id,
          p_expected_version: row.version,
        })
      ).error,
    ).toBeNull();
    const { data } = await user.client.from("weddings").select("id").eq("id", wedding);
    expect(data).toEqual([]);
    const back = await join(owner, wedding, user, "viewer");
    expect(back.role).toBe("viewer");
    expect(back.membership_id).toBe(row.membership_id);
  });
});

describe("authorization of member administration", () => {
  it("denies non-members, viewers, editors and plain partners from administering", async () => {
    const outsider = await createUser("outsider");
    const viewer = await createUser("viewer");
    const editor = await createUser("editor");
    const partner = await createUser("plainpartner");
    await join(owner, wedding, viewer, "viewer");
    await join(owner, wedding, editor, "editor");
    const victim = await createUser("victim");
    const viewerRow = await join(owner, wedding, victim, "viewer");
    const partnerRow = await join(owner, wedding, partner, "partner");

    for (const actor of [outsider, viewer, editor, partner]) {
      const inv = await invite(actor, wedding, `x-${actor.id}@example.test`, "viewer");
      expect(inv.error?.code).toBe("42501");
      const role = await actor.client.rpc("change_member_role", {
        p_membership: viewerRow.membership_id,
        p_role: "editor",
        p_expected_version: viewerRow.version,
      });
      expect(role.error?.code).toBe("42501");
      const rm = await actor.client.rpc("remove_member", {
        p_membership: viewerRow.membership_id,
        p_expected_version: viewerRow.version,
      });
      expect(rm.error?.code).toBe("42501");
      const perms = await actor.client.rpc("set_partner_permissions", {
        p_membership: partnerRow.membership_id,
        p_manage_members: true,
        p_expected_version: partnerRow.version,
      });
      expect(perms.error?.code).toBe("42501");
    }
    // Outsider cannot list members, viewers can but get no emails.
    expect((await outsider.client.rpc("list_members", { p_wedding: wedding })).error?.code).toBe(
      "42501",
    );
    expect((await members(viewer, wedding)).every((m) => m.email === null)).toBe(true);
    // Invites table is unreadable to non-admins, token_hash unreadable to everyone.
    const peek = await viewer.client.from("collaborator_invites").select("id");
    expect(peek.data).toEqual([]);
    const hashPeek = await owner.client.from("collaborator_invites").select("token_hash");
    expect(hashPeek.error).not.toBeNull();
  });

  it("limits a delegated partner to editors and viewers", async () => {
    const delegate = await createUser("delegate");
    const editor = await createUser("deledit");
    const other = await createUser("otherpartner");
    const delRow = await join(owner, wedding, delegate, "partner");
    const grant = await owner.client.rpc("set_partner_permissions", {
      p_membership: delRow.membership_id,
      p_manage_members: true,
      p_expected_version: delRow.version,
    });
    expect(grant.error).toBeNull();
    const otherRow = await join(owner, wedding, other, "partner");

    // Allowed: invite viewer, manage editors.
    expect(
      (await invite(delegate, wedding, `ok-${delegate.id}@example.test`, "viewer")).error,
    ).toBeNull();
    const edRow = await join(delegate, wedding, editor, "editor");
    const promote = await delegate.client.rpc("change_member_role", {
      p_membership: edRow.membership_id,
      p_role: "viewer",
      p_expected_version: edRow.version,
    });
    expect(promote.error).toBeNull();

    // Denied: grant partner or owner, touch partners/owners, escalate role.
    expect(
      (await invite(delegate, wedding, `p-${delegate.id}@example.test`, "partner")).error?.code,
    ).toBe("42501");
    const toPartner = await delegate.client.rpc("change_member_role", {
      p_membership: edRow.membership_id,
      p_role: "partner",
      p_expected_version: edRow.version + 1,
    });
    expect(toPartner.error?.code).toBe("42501");
    const ownerRow = (await members(owner, wedding)).find((m) => m.user_id === owner.id)!;
    expect(
      (
        await delegate.client.rpc("remove_member", {
          p_membership: ownerRow.membership_id,
          p_expected_version: ownerRow.version,
        })
      ).error?.code,
    ).toBe("42501");
    expect(
      (
        await delegate.client.rpc("remove_member", {
          p_membership: otherRow.membership_id,
          p_expected_version: otherRow.version,
        })
      ).error?.code,
    ).toBe("42501");
    const selfGrant = await delegate.client.rpc("set_partner_permissions", {
      p_membership: otherRow.membership_id,
      p_manage_members: true,
      p_expected_version: otherRow.version,
    });
    expect(selfGrant.error?.code).toBe("42501");
  });

  it("cannot be bypassed with direct table writes", async () => {
    const viewer = await createUser("directwrite");
    const row = await join(owner, wedding, viewer, "viewer");
    const upd = await viewer.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("id", row.membership_id);
    expect(upd.error).not.toBeNull();
    const ins = await viewer.client.from("collaborator_invites").insert({
      wedding_id: wedding,
      email: "a@example.test",
      role: "viewer",
      token_hash: newToken().hash,
      expires_at: new Date(Date.now() + 1e6).toISOString(),
    });
    expect(ins.error).not.toBeNull();
    const now = (await members(owner, wedding)).find((m) => m.user_id === viewer.id)!;
    expect(now.role).toBe("viewer");
  });
});

describe("role changes and removal", () => {
  it("applies optimistic version checks", async () => {
    const user = await createUser("versioned");
    const row = await join(owner, wedding, user, "viewer");
    const ok = await owner.client.rpc("change_member_role", {
      p_membership: row.membership_id,
      p_role: "editor",
      p_expected_version: row.version,
    });
    expect(ok.error).toBeNull();
    const stale = await owner.client.rpc("change_member_role", {
      p_membership: row.membership_id,
      p_role: "viewer",
      p_expected_version: row.version,
    });
    expect(stale.error?.message).toMatch(/reload and retry/);
  });

  it("takes effect immediately: demotion restricts, removal revokes access", async () => {
    const user = await createUser("revocable");
    const row = await join(owner, wedding, user, "partner");
    expect(
      (await user.client.from("audit_events").select("id").eq("wedding_id", wedding)).data?.length,
    ).toBeGreaterThan(0);
    await owner.client.rpc("change_member_role", {
      p_membership: row.membership_id,
      p_role: "viewer",
      p_expected_version: row.version,
    });
    expect(
      (await user.client.from("audit_events").select("id").eq("wedding_id", wedding)).data,
    ).toEqual([]);
    const cur = (await members(owner, wedding)).find((m) => m.user_id === user.id)!;
    await owner.client.rpc("remove_member", {
      p_membership: cur.membership_id,
      p_expected_version: cur.version,
    });
    expect((await user.client.from("weddings").select("id").eq("id", wedding)).data).toEqual([]);
  });

  it("clears partner grants when the role leaves partner", async () => {
    const user = await createUser("grantclear");
    const row = await join(owner, wedding, user, "partner");
    await owner.client.rpc("set_partner_permissions", {
      p_membership: row.membership_id,
      p_manage_members: true,
      p_expected_version: row.version,
    });
    const g = (await members(owner, wedding)).find((m) => m.user_id === user.id)!;
    expect(g.version).toBeGreaterThan(row.version);
    await owner.client.rpc("change_member_role", {
      p_membership: g.membership_id,
      p_role: "editor",
      p_expected_version: g.version,
    });
    await withSuperuser(async (db) => {
      const r = await db.query("select permissions from public.memberships where id=$1", [
        g.membership_id,
      ]);
      expect(r.rows[0].permissions).toEqual({});
    });
  });

  it("never leaves a wedding without an owner", async () => {
    const solo = await createUser("solo");
    const w = await createWedding(solo, { name: "Solo" });
    const me = (await members(solo, w))[0]!;
    const demote = await solo.client.rpc("change_member_role", {
      p_membership: me.membership_id,
      p_role: "viewer",
      p_expected_version: me.version,
    });
    expect(demote.error?.message).toBe("a wedding must keep at least one owner");
    const leave = await solo.client.rpc("remove_member", {
      p_membership: me.membership_id,
      p_expected_version: me.version,
    });
    expect(leave.error?.message).toBe("a wedding must keep at least one owner");

    // With a second owner, one may step down; the survivor cannot then.
    const second = await createUser("second");
    const sRow = await join(solo, w, second, "partner");
    const promote = await solo.client.rpc("change_member_role", {
      p_membership: sRow.membership_id,
      p_role: "owner",
      p_expected_version: sRow.version,
    });
    expect(promote.error).toBeNull();
    const leaveOk = await solo.client.rpc("remove_member", {
      p_membership: me.membership_id,
      p_expected_version: me.version,
    });
    expect(leaveOk.error).toBeNull();
    const last = (await members(second, w))[0]!;
    expect(
      (
        await second.client.rpc("remove_member", {
          p_membership: last.membership_id,
          p_expected_version: last.version,
        })
      ).error?.code,
    ).toBe("23514");
  });

  it("two owners cannot concurrently remove each other", async () => {
    const a = await createUser("ownerA");
    const b = await createUser("ownerB");
    const w = await createWedding(a, { name: "Race" });
    const bRow = await join(a, w, b, "partner");
    await a.client.rpc("change_member_role", {
      p_membership: bRow.membership_id,
      p_role: "owner",
      p_expected_version: bRow.version,
    });
    const list = await members(a, w);
    const rowA = list.find((m) => m.user_id === a.id)!;
    const rowB = list.find((m) => m.user_id === b.id)!;
    const [r1, r2] = await Promise.all([
      a.client.rpc("remove_member", {
        p_membership: rowB.membership_id,
        p_expected_version: rowB.version,
      }),
      b.client.rpc("remove_member", {
        p_membership: rowA.membership_id,
        p_expected_version: rowA.version,
      }),
    ]);
    expect([r1.error, r2.error].filter((e) => e === null)).toHaveLength(1);
    await withSuperuser(async (db) => {
      const r = await db.query(
        "select count(*)::int n from public.memberships where wedding_id=$1 and role='owner' and status='active'",
        [w],
      );
      expect(r.rows[0].n).toBe(1);
    });
  });

  it("records role changes and removals in the audit log", async () => {
    await withSuperuser(async (db) => {
      const r = await db.query(
        "select distinct action from public.audit_events where wedding_id=$1",
        [wedding],
      );
      expect(r.rows.map((x: { action: string }) => x.action)).toEqual(
        expect.arrayContaining([
          "member.role_changed",
          "member.removed",
          "member.permissions_changed",
          "invite.revoked",
        ]),
      );
    });
  });
});

describe("tenant isolation of invites", () => {
  it("does not let another wedding's owner see or revoke this wedding's invites", async () => {
    const other = await createUser("othertenant");
    await createWedding(other, { name: "Other" });
    const target = await createUser("target");
    const inv = await invite(owner, wedding, target.email, "viewer");
    expect(
      (await other.client.from("collaborator_invites").select("id").eq("id", inv.id!)).data,
    ).toEqual([]);
    expect(
      (await other.client.rpc("revoke_collaborator_invite", { p_invite: inv.id })).error?.code,
    ).toBe("42501");
    expect(
      (await invite(other, wedding, `z-${target.id}@example.test`, "viewer")).error?.code,
    ).toBe("42501");
  });
});
