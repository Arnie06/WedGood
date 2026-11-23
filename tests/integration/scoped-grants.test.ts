import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { anonClient, createUser, createWedding, withSuperuser, type TestUser } from "./helpers";

// REL-11: planner/editor scoped grants (ADR-031 D7). An owner opens single areas to an editor; the
// database helpers every RPC and RLS policy already call enforce them. This is the role-by-area
// matrix: every area is probed with one real write RPC for every role and every grant profile.

type Area = "guests" | "guest_private" | "seating" | "budget" | "vendors" | "plan";
const AREAS: Area[] = ["guests", "guest_private", "seating", "budget", "vendors", "plan"];

let owner: TestUser;
let partner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let wedding: string;
let eventId: string;
let layout: string;
let editorMembership: string;
let viewerMembership: string;

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>,
) {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as NonNullable<T>;
}
async function addMember(w: string, role: "partner" | "editor" | "viewer", label: string) {
  const user = await createUser(label);
  const id = await withSuperuser(
    async (db) =>
      (
        await db.query(
          "insert into public.memberships (wedding_id, user_id, role) values ($1,$2,$3) returning id",
          [w, user.id, role],
        )
      ).rows[0].id as string,
  );
  return { user, id };
}
async function memberRow(membership: string) {
  const rows = (await ok(owner.client.rpc("list_members", { p_wedding: wedding }))) as Array<{
    membership_id: string;
    role: string;
    version: number;
    permissions: Record<string, unknown>;
  }>;
  const row = rows.find((r) => r.membership_id === membership);
  if (!row) throw new Error("membership not listed");
  return row;
}
const grant = async (areas: Area[], membership = editorMembership) =>
  owner.client.rpc("set_editor_grants", {
    p_membership: membership,
    p_areas: areas,
    p_expected_version: (await memberRow(membership)).version,
  });
const grantOk = async (areas: Area[]) => {
  const r = await grant(areas);
  expect(r.error?.message).toBeUndefined();
};

/** One real write per area. Returns the error code, or null when the write succeeded. */
const probes: Record<Area, (u: TestUser) => Promise<string | null>> = {
  guests: async (u) =>
    (
      await u.client.rpc("create_guest", {
        p_wedding: wedding,
        p_guest: { name: `Probe ${randomUUID().slice(0, 8)} Example` },
      })
    ).error?.code ?? null,
  guest_private: async (u) =>
    (
      await u.client.rpc("create_guest", {
        p_wedding: wedding,
        p_guest: { name: `Private ${randomUUID().slice(0, 8)} Example`, dietary: "No nuts" },
      })
    ).error?.code ?? null,
  seating: async (u) =>
    (
      await u.client.rpc("add_seating_table", {
        p_wedding: wedding,
        p_layout: layout,
        p_label: `T${randomUUID().slice(0, 6)}`,
        p_capacity: 8,
      })
    ).error?.code ?? null,
  budget: async (u) =>
    (
      await u.client.rpc("create_budget_category", {
        p_wedding: wedding,
        p_name: `Cat ${randomUUID().slice(0, 8)}`,
      })
    ).error?.code ?? null,
  vendors: async (u) =>
    (
      await u.client.rpc("create_candidate", {
        p_wedding: wedding,
        p_kind: "vendor",
        p_category: "photographer",
        p_name: `Vendor ${randomUUID().slice(0, 8)}`,
      })
    ).error?.code ?? null,
  plan: async (u) =>
    (
      await u.client.rpc("create_task", {
        p_wedding: wedding,
        p_title: `Task ${randomUUID().slice(0, 8)}`,
      })
    ).error?.code ?? null,
};

/** What an editor holding `areas` may do, by the documented rules (seating and private need guests). */
function expected(areas: Area[], area: Area) {
  if (!areas.includes(area)) return false;
  return area === "seating" || area === "guest_private" ? areas.includes("guests") : true;
}

beforeAll(async () => {
  owner = await createUser("grants-owner");
  stranger = await createUser("grants-stranger");
  wedding = await createWedding(owner, { name: "Grants Wedding" });
  partner = (await addMember(wedding, "partner", "grants-partner")).user;
  const e = await addMember(wedding, "editor", "grants-editor");
  editor = e.user;
  editorMembership = e.id;
  const v = await addMember(wedding, "viewer", "grants-viewer");
  viewer = v.user;
  viewerMembership = v.id;
  eventId = (await ok(
    owner.client.rpc("create_event", {
      p_wedding: wedding,
      p_event: { name: "Reception", kind: "reception" },
    }),
  )) as string;
  layout = (await ok(
    owner.client.rpc("ensure_seating_layout", { p_wedding: wedding, p_event_id: eventId }),
  )) as string;
});

describe("role-by-area matrix", () => {
  it("lets owner and partner write every area, and nobody else without a grant", async () => {
    for (const area of AREAS) {
      expect(await probes[area](owner), `owner ${area}`).toBeNull();
      expect(await probes[area](partner), `partner ${area}`).toBeNull();
      expect(await probes[area](editor), `editor ${area}`).toBe("42501");
      expect(await probes[area](viewer), `viewer ${area}`).toBe("42501");
      expect(await probes[area](stranger), `stranger ${area}`).toBe("42501");
      expect(
        (await probes[area]({ client: anonClient() } as TestUser))?.length,
        `anon ${area}`,
      ).toBeGreaterThan(0);
    }
  });

  const profiles: Area[][] = [
    [],
    ["guests"],
    ["guests", "guest_private"],
    ["guests", "seating"],
    ["guests", "guest_private", "seating"],
    ["budget"],
    ["vendors"],
    ["plan"],
    ["guests", "budget", "vendors"],
    [...AREAS],
  ];
  for (const areas of profiles) {
    it(`gives an editor holding [${areas.join(", ") || "nothing"}] exactly those areas`, async () => {
      await grantOk(areas);
      for (const area of AREAS) {
        const code = await probes[area](editor);
        if (expected(areas, area)) expect(code, `${area} should be allowed`).toBeNull();
        else expect(code, `${area} should be refused`).toBe("42501");
      }
    });
  }

  it("never gives a viewer an area, even with a grant stored directly", async () => {
    await withSuperuser((db) =>
      db.query(
        `update public.memberships set permissions = '{"guests":true,"seating":true,"budget":true,"vendors":true,"plan":true,"guest_private":true}' where user_id = $1 and wedding_id = $2`,
        [viewer.id, wedding],
      ),
    );
    for (const area of AREAS) expect(await probes[area](viewer), area).toBe("42501");
    await withSuperuser((db) =>
      db.query(`update public.memberships set permissions = '{}' where user_id = $1`, [viewer.id]),
    );
  });

  it("ignores a stored seating or private grant that lacks the guests grant it depends on", async () => {
    await withSuperuser((db) =>
      db.query(
        `update public.memberships set permissions = '{"seating":true,"guest_private":true}' where id = $1`,
        [editorMembership],
      ),
    );
    expect(await probes.seating(editor)).toBe("42501");
    expect(await probes.guests(editor)).toBe("42501");
    expect(await probes.guest_private(editor)).toBe("42501");
    const read = await editor.client.from("guest_private_details").select("guest_id");
    expect(read.data ?? []).toEqual([]);
  });
});

describe("what a grant reads", () => {
  it("lets a guests editor read guests, events and the seating plan but not private details", async () => {
    await grantOk(["guests"]);
    await ok(
      owner.client.rpc("create_guest", {
        p_wedding: wedding,
        p_guest: { name: "Readable Example", dietary: "Shellfish allergy" },
      }),
    );
    expect(
      ((await ok(editor.client.from("guests").select("id").eq("wedding_id", wedding))) as unknown[])
        .length,
    ).toBeGreaterThan(0);
    expect(
      ((await ok(editor.client.from("events").select("id").eq("wedding_id", wedding))) as unknown[])
        .length,
    ).toBe(1);
    expect(
      (
        (await ok(
          editor.client.from("seating_layouts").select("id").eq("wedding_id", wedding),
        )) as unknown[]
      ).length,
    ).toBe(1);
    expect(
      ((await ok(editor.client.from("guest_private_details").select("guest_id"))) as unknown[])
        .length,
    ).toBe(0);
  });

  it("lets a private-details editor read them, and nobody without that grant", async () => {
    await grantOk(["guests", "guest_private"]);
    const rows = (await ok(
      editor.client.from("guest_private_details").select("dietary"),
    )) as Array<{ dietary: string | null }>;
    expect(rows.some((r) => r.dietary === "Shellfish allergy")).toBe(true);
    expect(
      ((await ok(viewer.client.from("guest_private_details").select("guest_id"))) as unknown[])
        .length,
    ).toBe(0);
    expect(
      ((await ok(stranger.client.from("guest_private_details").select("guest_id"))) as unknown[])
        .length,
    ).toBe(0);
  });

  it("keeps guests, events and seating unreadable to a budget-only editor", async () => {
    await grantOk(["budget"]);
    for (const table of ["guests", "households", "events", "seating_layouts", "seating_tables"]) {
      const r = await editor.client.from(table).select("id");
      expect(r.data ?? [], table).toEqual([]);
    }
  });

  it("lets a budget editor read documents and a plan-only editor no budget documents", async () => {
    await grantOk(["plan"]);
    const docs = await editor.client.from("documents").select("id");
    expect(docs.data ?? []).toEqual([]);
  });
});

describe("private guest details need the private grant to write", () => {
  let guestId: string;
  beforeAll(async () => {
    guestId = (await ok(
      owner.client.rpc("create_guest", {
        p_wedding: wedding,
        p_guest: {
          name: "Keep Details Example",
          dietary: "Vegan",
          notes: "Seat away from the band",
        },
      }),
    )) as string;
  });
  const details = async () =>
    withSuperuser(
      async (db) =>
        (
          await db.query(
            "select dietary, accessibility, notes from public.guest_private_details where guest_id = $1",
            [guestId],
          )
        ).rows[0] as
          | { dietary: string | null; accessibility: string | null; notes: string | null }
          | undefined,
    );
  const guestVersion = async () =>
    withSuperuser(
      async (db) =>
        (await db.query("select version from public.guests where id = $1", [guestId])).rows[0]
          .version as number,
    );

  it("refuses a guest created with private fields, and creates nothing", async () => {
    await grantOk(["guests"]);
    const name = `Refused ${randomUUID().slice(0, 8)} Example`;
    const r = await editor.client.rpc("create_guest", {
      p_wedding: wedding,
      p_guest: { name, dietary: "Gluten free" },
    });
    expect(r.error?.code).toBe("42501");
    const count = await withSuperuser(
      async (db) =>
        (await db.query("select count(*)::int n from public.guests where full_name = $1", [name]))
          .rows[0].n as number,
    );
    expect(count).toBe(0);
  });

  it("lets a guests editor change a guest and leaves the stored private details untouched", async () => {
    await grantOk(["guests"]);
    const r = await editor.client.rpc("update_guest", {
      p_wedding: wedding,
      p_guest_id: guestId,
      p_expected_version: await guestVersion(),
      p_guest: { name: "Keep Details Example", phone: "555-0100-22" },
    });
    expect(r.error?.message).toBeUndefined();
    expect(await details()).toEqual({
      dietary: "Vegan",
      accessibility: null,
      notes: "Seat away from the band",
    });
  });

  it("refuses an update that supplies private fields, and changes nothing", async () => {
    await grantOk(["guests"]);
    const before = await guestVersion();
    const r = await editor.client.rpc("update_guest", {
      p_wedding: wedding,
      p_guest_id: guestId,
      p_expected_version: before,
      p_guest: { name: "Keep Details Example", dietary: "Changed" },
    });
    expect(r.error?.code).toBe("42501");
    expect(await guestVersion()).toBe(before);
    expect((await details())?.dietary).toBe("Vegan");
  });

  it("lets a private-details editor change them", async () => {
    await grantOk(["guests", "guest_private"]);
    const r = await editor.client.rpc("update_guest", {
      p_wedding: wedding,
      p_guest_id: guestId,
      p_expected_version: await guestVersion(),
      p_guest: {
        name: "Keep Details Example",
        dietary: "Vegetarian",
        notes: "Seat away from the band",
      },
    });
    expect(r.error?.message).toBeUndefined();
    expect((await details())?.dietary).toBe("Vegetarian");
  });
});

describe("seating is its own grant", () => {
  it("lets a guests editor read seating but not move a table, and a seating editor do both", async () => {
    await grantOk(["guests"]);
    const table = (await ok(
      owner.client.rpc("add_seating_table", {
        p_wedding: wedding,
        p_layout: layout,
        p_label: "Keep",
        p_capacity: 6,
      }),
    )) as string;
    expect(
      ((await ok(editor.client.from("seating_tables").select("id").eq("id", table))) as unknown[])
        .length,
    ).toBe(1);
    const denied = await editor.client.rpc("update_seating_table", {
      p_wedding: wedding,
      p_table: table,
      p_expected_version: 1,
      p_label: "Renamed",
      p_capacity: 6,
    });
    expect(denied.error?.code).toBe("42501");
    await grantOk(["guests", "seating"]);
    expect(await probes.seating(editor)).toBeNull();
  });
});

describe("what a grant never opens", () => {
  it("keeps member administration, guest totals sharing and publishing with owner and partner", async () => {
    await grantOk([...AREAS]);
    // Someone else's membership: leaving is always allowed, so the editor's own row proves nothing.
    const target = await memberRow(viewerMembership);
    const roleChange = await editor.client.rpc("change_member_role", {
      p_membership: viewerMembership,
      p_role: "editor",
      p_expected_version: target.version,
    });
    expect(roleChange.error?.code).toBe("42501");
    const remove = await editor.client.rpc("remove_member", {
      p_membership: viewerMembership,
      p_expected_version: target.version,
    });
    expect(remove.error?.code).toBe("42501");
    expect((await memberRow(viewerMembership)).role).toBe("viewer");
    const totals = await editor.client.rpc("set_share_guest_totals", {
      p_wedding: wedding,
      p_enabled: true,
    });
    expect(totals.error?.code).toBe("42501");
    const publish = await editor.client.rpc("publish_site", {
      p_wedding: wedding,
      p_expected_version: 1,
      p_slug: "grants-site",
    });
    expect(publish.error?.code).toBe("42501");
    const invite = await editor.client.rpc("create_collaborator_invite", {
      p_wedding: wedding,
      p_email: "someone@example.test",
      p_role: "viewer",
      p_token_hash: "0".repeat(64),
    });
    expect(invite.error?.code).toBe("42501");
  });

  it("lets a partner reach the publish check (it fails later for want of a draft, not for permission)", async () => {
    const r = await partner.client.rpc("publish_site", {
      p_wedding: wedding,
      p_expected_version: 1,
      p_slug: "grants-site",
    });
    expect(r.error?.code).not.toBe("42501");
  });

  it("lets a plan editor edit the draft area but not publish", async () => {
    await grantOk(["guests", "plan"]);
    expect(await probes.plan(editor)).toBeNull();
    const r = await editor.client.rpc("publish_site", {
      p_wedding: wedding,
      p_expected_version: 1,
      p_slug: "grants-site",
    });
    expect(r.error?.code).toBe("42501");
  });

  it("refuses a package to an editor holding every area", async () => {
    await grantOk([...AREAS]);
    const r = await editor.client.rpc("create_package", {
      p_wedding: wedding,
      p_id: randomUUID(),
      p_title: "Nope",
      p_preset: "planner",
      p_recipient: "planner",
      p_sections: [],
      p_formats: [],
      p_options: {},
      p_artifacts: [],
      p_snapshot: {},
      p_digest: "0".repeat(64),
      p_template_version: 1,
      p_expected_revision: 1,
      p_generated_at: new Date().toISOString(),
      p_paper: "letter",
      p_orientation: "portrait",
    });
    expect(r.error?.code).toBe("42501");
  });
});

describe("set_editor_grants", () => {
  it("is owner-only: partner, editor, viewer, stranger and anonymous are refused", async () => {
    const version = (await memberRow(editorMembership)).version;
    for (const [who, client] of [
      ["partner", partner.client],
      ["editor", editor.client],
      ["viewer", viewer.client],
      ["stranger", stranger.client],
      ["anon", anonClient()],
    ] as const) {
      const r = await client.rpc("set_editor_grants", {
        p_membership: editorMembership,
        p_areas: ["budget"],
        p_expected_version: version,
      });
      expect(r.error, who).not.toBeNull();
      if (who !== "anon") expect(r.error?.code, who).toBe("42501");
    }
    expect((await memberRow(editorMembership)).version).toBe(version);
  });

  it("applies only to active editors", async () => {
    const partnerRow = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select id, version from public.memberships where user_id = $1 and wedding_id = $2",
            [partner.id, wedding],
          )
        ).rows[0],
    );
    const r = await owner.client.rpc("set_editor_grants", {
      p_membership: partnerRow.id,
      p_areas: ["budget"],
      p_expected_version: partnerRow.version,
    });
    expect(r.error?.code).toBe("55000");
    const v = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select id, version from public.memberships where user_id = $1 and wedding_id = $2",
            [viewer.id, wedding],
          )
        ).rows[0],
    );
    const r2 = await owner.client.rpc("set_editor_grants", {
      p_membership: v.id,
      p_areas: ["plan"],
      p_expected_version: v.version,
    });
    expect(r2.error?.code).toBe("55000");
  });

  it("refuses unknown areas, nulls, too many entries and a set that breaks a dependency", async () => {
    const version = (await memberRow(editorMembership)).version;
    const call = (areas: unknown) =>
      owner.client.rpc("set_editor_grants", {
        p_membership: editorMembership,
        p_areas: areas as string[],
        p_expected_version: version,
      });
    for (const bad of [
      ["admin"],
      ["guests", "owner"],
      ["seating"],
      ["guest_private", "plan"],
      ["guests", "guests", "guests", "budget", "vendors", "plan", "seating"],
    ]) {
      expect((await call(bad)).error?.code, JSON.stringify(bad)).toBe("22023");
    }
    expect((await call(null)).error?.code).toBe("22023");
  });

  it("refuses a stale version, then accepts the fresh one", async () => {
    const version = (await memberRow(editorMembership)).version;
    await grantOk(["plan"]);
    const stale = await owner.client.rpc("set_editor_grants", {
      p_membership: editorMembership,
      p_areas: ["budget"],
      p_expected_version: version,
    });
    expect(stale.error?.code).toBe("55000");
    expect((await memberRow(editorMembership)).permissions).toEqual({ plan: true });
  });

  it("records one audit event with area names only, and nothing on an unchanged retry", async () => {
    await grantOk([]);
    const count = () =>
      withSuperuser(
        async (db) =>
          (
            await db.query(
              "select count(*)::int n from public.audit_events where wedding_id = $1 and action = 'member.grants_changed'",
              [wedding],
            )
          ).rows[0].n as number,
      );
    const before = await count();
    await grantOk(["guests", "budget"]);
    expect(await count()).toBe(before + 1);
    const last = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes from public.audit_events where wedding_id = $1 and action = 'member.grants_changed' order by occurred_at desc limit 1",
            [wedding],
          )
        ).rows[0].safe_changes,
    );
    expect(last).toEqual({ added: ["budget", "guests"], removed: [] });
    const versionBefore = (await memberRow(editorMembership)).version;
    await grantOk(["budget", "guests"]); // same set, different order
    expect(await count()).toBe(before + 1);
    expect((await memberRow(editorMembership)).version).toBe(versionBefore);
    await grantOk(["budget"]);
    const removed = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select safe_changes from public.audit_events where wedding_id = $1 and action = 'member.grants_changed' order by occurred_at desc limit 1",
            [wedding],
          )
        ).rows[0].safe_changes,
    );
    expect(removed).toEqual({ added: [], removed: ["guests"] });
  });

  it("takes effect on the next call and is withdrawn on the next call", async () => {
    await grantOk(["guests"]);
    expect(await probes.guests(editor)).toBeNull();
    await grantOk([]);
    expect(await probes.guests(editor)).toBe("42501");
    await grantOk(["guests"]);
    expect(await probes.guests(editor)).toBeNull();
  });

  it("lets exactly one of two concurrent changes win", async () => {
    await grantOk([]);
    const version = (await memberRow(editorMembership)).version;
    const results = await Promise.all(
      (["budget", "plan"] as Area[]).map((a) =>
        owner.client.rpc("set_editor_grants", {
          p_membership: editorMembership,
          p_areas: [a],
          p_expected_version: version,
        }),
      ),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });

  it("cannot reach a membership in another wedding", async () => {
    const otherOwner = await createUser("grants-other-owner");
    const other = await createWedding(otherOwner, { name: "Other" });
    const foreign = await addMember(other, "editor", "grants-foreign-editor");
    const v = await withSuperuser(
      async (db) =>
        (await db.query("select version from public.memberships where id = $1", [foreign.id]))
          .rows[0].version as number,
    );
    const r = await owner.client.rpc("set_editor_grants", {
      p_membership: foreign.id,
      p_areas: ["budget"],
      p_expected_version: v,
    });
    expect(r.error?.code).toBe("42501");
    expect(
      await withSuperuser(
        async (db) =>
          (await db.query("select permissions from public.memberships where id = $1", [foreign.id]))
            .rows[0].permissions,
      ),
    ).toEqual({});
  });
});

describe("role changes and removal clear grants", () => {
  it("clears them when an editor becomes a viewer and does not bring them back", async () => {
    await grantOk(["guests", "budget"]);
    const row = await memberRow(editorMembership);
    const down = await owner.client.rpc("change_member_role", {
      p_membership: editorMembership,
      p_role: "viewer",
      p_expected_version: row.version,
    });
    expect(down.error?.message).toBeUndefined();
    expect((await memberRow(editorMembership)).permissions).toEqual({});
    expect(await probes.guests(editor)).toBe("42501");
    const up = await owner.client.rpc("change_member_role", {
      p_membership: editorMembership,
      p_role: "editor",
      p_expected_version: (await memberRow(editorMembership)).version,
    });
    expect(up.error?.message).toBeUndefined();
    expect(await probes.guests(editor)).toBe("42501");
    expect(await probes.budget(editor)).toBe("42501");
  });

  it("clears them when an editor becomes a partner (a partner's grants are its own)", async () => {
    await grantOk(["plan"]);
    const row = await memberRow(editorMembership);
    await ok(
      owner.client.rpc("change_member_role", {
        p_membership: editorMembership,
        p_role: "partner",
        p_expected_version: row.version,
      }),
    );
    expect((await memberRow(editorMembership)).permissions).toEqual({});
    await ok(
      owner.client.rpc("change_member_role", {
        p_membership: editorMembership,
        p_role: "editor",
        p_expected_version: (await memberRow(editorMembership)).version,
      }),
    );
  });

  it("ends all access at once when the member is removed", async () => {
    const removed = await addMember(wedding, "editor", "grants-removed");
    await ok(
      owner.client.rpc("set_editor_grants", {
        p_membership: removed.id,
        p_areas: ["guests", "budget", "plan"],
        p_expected_version: (await memberRow(removed.id)).version,
      }),
    );
    expect(await probes.plan(removed.user)).toBeNull();
    await ok(
      owner.client.rpc("remove_member", {
        p_membership: removed.id,
        p_expected_version: (await memberRow(removed.id)).version,
      }),
    );
    for (const area of AREAS) expect(await probes[area](removed.user), area).toBe("42501");
  });

  it("keeps the last-owner rule: an owner cannot be demoted by anyone while sole owner", async () => {
    const ownerRow = await withSuperuser(
      async (db) =>
        (
          await db.query(
            "select id, version from public.memberships where user_id = $1 and wedding_id = $2",
            [owner.id, wedding],
          )
        ).rows[0],
    );
    const r = await owner.client.rpc("change_member_role", {
      p_membership: ownerRow.id,
      p_role: "editor",
      p_expected_version: ownerRow.version,
    });
    expect(r.error?.code).toBe("23514");
    const r2 = await owner.client.rpc("remove_member", {
      p_membership: ownerRow.id,
      p_expected_version: ownerRow.version,
    });
    expect(r2.error?.code).toBe("23514");
  });
});
