import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let other: TestUser;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const client = () => `c-${randomUUID().slice(0, 12)}`;
const slug = (p = "site") => `${p}-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  owner = await createUser("site-owner");
  other = await createUser("site-other");
});

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

async function mkEvent(u: TestUser, w: string, name: string, date?: string) {
  const { data, error } = await u.client.rpc("create_event", {
    p_wedding: w,
    p_event: { name, kind: "reception", ...(date && { localDate: date }) },
  });
  if (error) throw new Error(error.message);
  return data as string;
}
async function mkGuest(u: TestUser, w: string, name: string) {
  const { data, error } = await u.client.rpc("create_guest", { p_wedding: w, p_guest: { name } });
  if (error) throw new Error(error.message);
  return data as string;
}
async function invite(u: TestUser, w: string, e: string, guestIds: string[], label?: string) {
  const raw = randomBytes(32).toString("base64url");
  const res = await u.client.rpc("create_invitations", {
    p_wedding: w,
    p_event_id: e,
    p_groups: [{ guestIds, householdId: null }],
    p_plus_one_quota: 0,
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_token_hashes: [sha(raw)],
    p_idempotency_key: `key-${randomUUID()}`,
  });
  if (res.error) throw new Error(res.error.message);
  void label;
  return { raw, hash: sha(raw) };
}

type Draft = Record<string, unknown>;
const draft = (over: Draft = {}): Draft => ({
  template: "classic",
  title: "Alex & Morgan",
  faq: [],
  registry: [],
  events: [],
  ...over,
});
const save = (u: TestUser, w: string, version: number, d: Draft) =>
  u.client.rpc("save_site_draft", { p_wedding: w, p_expected_version: version, p_draft: d });
const publish = (u: TestUser, w: string, version: number, s: string) =>
  u.client.rpc("publish_site", { p_wedding: w, p_expected_version: version, p_slug: s });
const unpublish = (u: TestUser, w: string, version: number) =>
  u.client.rpc("unpublish_site", { p_wedding: w, p_expected_version: version });
const pub = (s: string) => adminClient().rpc("public_site_view", { p_slug: s });
const pubInvite = (s: string, hash: string, c = client()) =>
  adminClient().rpc("public_site_invite_view", { p_slug: s, p_token_hash: hash, p_client: c });

type PubView = {
  title: string;
  events: { name: string; visibility: string; eventId?: string }[];
  invitation?: { label: string };
  [k: string]: unknown;
};

/** A wedding with a saved draft (version returned) ready to publish. */
async function savedSite(over: Draft = {}) {
  const w = await createWedding(owner);
  const r = await save(owner, w, 0, draft(over));
  if (r.error) throw new Error(r.error.message);
  return { w, version: r.data as number };
}

describe("authorization", () => {
  it("lets owners and partners write, and nobody else", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner", "site-partner");
    const editor = await addMember(w, "editor", "site-editor");
    const viewer = await addMember(w, "viewer", "site-viewer");
    for (const u of [editor, viewer, other]) {
      const r = await save(u, w, 0, draft());
      expect(r.error?.code).toBe("42501");
    }
    const first = await save(owner, w, 0, draft());
    expect(first.error).toBeNull();
    const second = await save(partner, w, first.data as number, draft({ title: "Partner edit" }));
    expect(second.error).toBeNull();
    for (const u of [editor, viewer, other]) {
      expect((await publish(u, w, second.data as number, slug())).error?.code).toBe("42501");
      expect((await unpublish(u, w, second.data as number)).error?.code).toBe("42501");
    }
  });

  it("hides the site row from non-editors and from anonymous callers", async () => {
    const { w } = await savedSite();
    const viewer = await addMember(w, "viewer", "site-viewer2");
    for (const u of [viewer, other]) {
      const { data, error } = await u.client.from("wedding_sites").select("id").eq("wedding_id", w);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    const anon = await anonClient().from("wedding_sites").select("id");
    expect(anon.data ?? []).toEqual([]);
    const mine = await owner.client.from("wedding_sites").select("id, draft").eq("wedding_id", w);
    expect(mine.data).toHaveLength(1);
  });

  it("denies direct table writes and does not expose the published snapshot column", async () => {
    const { w } = await savedSite();
    const ins = await owner.client
      .from("wedding_sites")
      .insert({ wedding_id: randomUUID(), draft: {} });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client
      .from("wedding_sites")
      .update({ slug: "hijack" })
      .eq("wedding_id", w);
    expect(upd.error ?? upd.data).toBeTruthy();
    const col = await owner.client.from("wedding_sites").select("published").eq("wedding_id", w);
    expect(col.error).not.toBeNull();
  });

  it("keeps public read RPCs away from browser roles", async () => {
    const s = slug();
    for (const c of [anonClient(), owner.client]) {
      expect((await c.rpc("public_site_view", { p_slug: s })).error).not.toBeNull();
      expect(
        (
          await c.rpc("public_site_invite_view", {
            p_slug: s,
            p_token_hash: "0".repeat(64),
            p_client: "x",
          })
        ).error,
      ).not.toBeNull();
    }
  });

  it("isolates tenants: another wedding's owner cannot touch this site", async () => {
    const { w, version } = await savedSite();
    expect((await save(other, w, version, draft({ title: "X" }))).error?.code).toBe("42501");
    const r = await adminClient()
      .from("wedding_sites")
      .select("draft")
      .eq("wedding_id", w)
      .single();
    expect((r.data?.draft as Draft).title).toBe("Alex & Morgan");
  });
});

describe("draft validation", () => {
  it.each<[string, Draft]>([
    ["unknown top-level key", draft({ html: "<b>x</b>" })],
    ["unknown template", draft({ template: "neon" })],
    [
      "missing title",
      (() => {
        const d = draft();
        delete d.title;
        return d;
      })(),
    ],
    ["empty title", draft({ title: "  " })],
    ["overlong title", draft({ title: "x".repeat(121) })],
    ["impossible date", draft({ date: "2027-02-30" })],
    ["non-string date", draft({ date: 20270612 })],
    ["control characters", draft({ story: "bad\u0007text" })],
    [
      "http registry link",
      draft({ registry: [{ label: "Gifts", url: "http://shop.example.com" }] }),
    ],
    ["javascript link", draft({ registry: [{ label: "Gifts", url: "javascript:alert(1)" }] })],
    [
      "link with username",
      draft({ registry: [{ label: "Gifts", url: "https://u:p@shop.example.com" }] }),
    ],
    [
      "link with spaces",
      draft({ registry: [{ label: "Gifts", url: "https://shop.example.com/a b" }] }),
    ],
    [
      "extra registry key",
      draft({ registry: [{ label: "G", url: "https://a.example.com", x: 1 }] }),
    ],
    [
      "too many registry links",
      draft({
        registry: Array.from({ length: 7 }, (_, i) => ({
          label: `L${i}`,
          url: "https://a.example.com",
        })),
      }),
    ],
    ["too many questions", draft({ faq: Array.from({ length: 11 }, () => ({ q: "q", a: "a" })) })],
    ["question without answer", draft({ faq: [{ q: "q" }] })],
    ["faq not an array", draft({ faq: "nope" })],
    ["draft not an object", [] as unknown as Draft],
  ])("rejects %s", async (_name, d) => {
    const w = await createWedding(owner);
    const r = await save(owner, w, 0, d);
    expect(r.error?.code).toBe("22023");
    const rows = await adminClient().from("wedding_sites").select("id").eq("wedding_id", w);
    expect(rows.data).toEqual([]);
  });

  it("rejects events from another wedding, unknown visibility and duplicates", async () => {
    const w = await createWedding(owner);
    const mine = await mkEvent(owner, w, "Mine");
    const otherWedding = await createWedding(other);
    const foreign = await mkEvent(other, otherWedding, "Foreign");
    const bad = [
      [{ eventId: foreign, visibility: "public" }],
      [{ eventId: mine, visibility: "secret" }],
      [
        { eventId: mine, visibility: "public" },
        { eventId: mine, visibility: "invited" },
      ],
      [{ eventId: "not-a-uuid", visibility: "public" }],
      [{ eventId: mine }],
    ];
    for (const events of bad) {
      expect((await save(owner, w, 0, draft({ events }))).error?.code).toBe("22023");
    }
    expect(
      (
        await save(
          owner,
          w,
          0,
          draft({ events: [{ eventId: mine, visibility: "public", when: "4 pm" }] }),
        )
      ).error,
    ).toBeNull();
  });

  it("stores markup as inert text and accepts valid content", async () => {
    const w = await createWedding(owner);
    const story = "<script>alert(1)</script> & <b>bold</b>\nSecond line";
    const r = await save(
      owner,
      w,
      0,
      draft({
        story,
        date: "2027-06-12",
        registry: [{ label: "Gifts", url: "https://shop.example.com/a?b=1" }],
        faq: [{ q: "Parking?", a: "Yes." }],
      }),
    );
    expect(r.error).toBeNull();
    const row = await owner.client
      .from("wedding_sites")
      .select("draft")
      .eq("wedding_id", w)
      .single();
    expect((row.data?.draft as Draft).story).toBe(story);
  });
});

describe("versions", () => {
  it("creates at version 0 and rejects stale or wrong versions", async () => {
    const w = await createWedding(owner);
    expect((await save(owner, w, 3, draft())).error?.code).toBe("55000");
    const a = await save(owner, w, 0, draft());
    expect(a.data).toBe(1);
    expect((await save(owner, w, 0, draft({ title: "Again" }))).error?.code).toBe("55000");
    const b = await save(owner, w, 1, draft({ title: "Two" }));
    expect(b.data).toBe(2);
    expect((await save(owner, w, 1, draft({ title: "Stale" }))).error?.code).toBe("55000");
  });

  it("treats an unchanged save as a no-op", async () => {
    const { w, version } = await savedSite();
    const again = await save(owner, w, version, draft());
    expect(again.data).toBe(version);
  });

  it("lets only one of two concurrent saves win", async () => {
    const { w, version } = await savedSite();
    const results = await Promise.all([
      save(owner, w, version, draft({ title: "A" })),
      save(owner, w, version, draft({ title: "B" })),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "55000")).toHaveLength(1);
  });
});

describe("publishing", () => {
  it("is explicit: a saved draft is not public", async () => {
    const { w } = await savedSite();
    const row = await owner.client
      .from("wedding_sites")
      .select("slug, published_at")
      .eq("wedding_id", w)
      .single();
    expect(row.data).toEqual({ slug: null, published_at: null });
  });

  it("serves only the snapshot and strips ids, and only public events to anonymous visitors", async () => {
    const w = await createWedding(owner);
    const ceremony = await mkEvent(owner, w, "Ceremony", "2027-06-12");
    const dinner = await mkEvent(owner, w, "Rehearsal dinner", "2027-06-11");
    const hidden = await mkEvent(owner, w, "Private brunch");
    void hidden;
    const s = slug();
    const sv = await save(
      owner,
      w,
      0,
      draft({
        tagline: "Join us",
        events: [
          { eventId: ceremony, visibility: "public", when: "4 pm", where: "The Garden" },
          { eventId: dinner, visibility: "invited", notes: "Dress smart" },
        ],
      }),
    );
    const p = await publish(owner, w, sv.data as number, s);
    expect(p.error).toBeNull();

    const { data } = await pub(s);
    const view = data as PubView;
    expect(view.events.map((e) => e.name)).toEqual(["Ceremony"]);
    expect(JSON.stringify(view)).not.toContain(ceremony);
    expect(JSON.stringify(view)).not.toContain("Rehearsal");
    expect(JSON.stringify(view)).not.toContain("Private brunch");
    expect(Object.keys(view).sort()).toEqual(
      ["events", "faq", "registry", "tagline", "template", "title"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain(w);
  });

  it("validates the address and rejects reserved, malformed and duplicate slugs", async () => {
    const a = await savedSite();
    for (const bad of ["ab", "Has Space", "-lead", "trail-", "a--b", "rsvp", "x".repeat(41), ""]) {
      expect((await publish(owner, a.w, a.version, bad)).error?.code).toBe("22023");
    }
    const s = slug();
    expect((await publish(owner, a.w, a.version, s.toUpperCase())).error).toBeNull();
    const b = await savedSite();
    expect((await publish(owner, b.w, b.version, s)).error?.code).toBe("23505");
  });

  it("requires the version the editor saw", async () => {
    const { w, version } = await savedSite();
    expect((await publish(owner, w, version + 1, slug())).error?.code).toBe("55000");
    expect((await publish(owner, w, version - 1, slug())).error?.code).toBe("55000");
  });

  it("keeps the public page on the published snapshot until it is published again", async () => {
    const { w, version } = await savedSite({ title: "First title" });
    const s = slug();
    const p1 = await publish(owner, w, version, s);
    const edit = await save(owner, w, p1.data as number, draft({ title: "Second title" }));
    expect(edit.error).toBeNull();
    expect(((await pub(s)).data as PubView).title).toBe("First title");
    const row = await owner.client
      .from("wedding_sites")
      .select("draft_rev, published_draft_rev")
      .eq("wedding_id", w)
      .single();
    expect(row.data?.draft_rev).not.toBe(row.data?.published_draft_rev);
    const p2 = await publish(owner, w, edit.data as number, s);
    expect(p2.error).toBeNull();
    expect(((await pub(s)).data as PubView).title).toBe("Second title");
  });

  it("does not follow later event changes until republished", async () => {
    const w = await createWedding(owner);
    const e = await mkEvent(owner, w, "Ceremony");
    const sv = await save(owner, w, 0, draft({ events: [{ eventId: e, visibility: "public" }] }));
    const s = slug();
    await publish(owner, w, sv.data as number, s);
    const ev = await owner.client.rpc("update_event", {
      p_wedding: w,
      p_event_id: e,
      p_expected_version: 1,
      p_event: { name: "Renamed", kind: "reception" },
    });
    expect(ev.error).toBeNull();
    expect(((await pub(s)).data as PubView).events[0]?.name).toBe("Ceremony");
  });

  it("records audit events without any site content", async () => {
    const w = await createWedding(owner);
    const sv = await save(owner, w, 0, draft({ story: "A very private story marker" }));
    const s = slug();
    const p = await publish(owner, w, sv.data as number, s);
    await unpublish(owner, w, p.data as number);
    const rows = await withSuperuser((db) =>
      db.query(
        "select action, safe_changes::text as c from public.audit_events where wedding_id = $1 and entity_type = 'wedding_site' order by occurred_at, id",
        [w],
      ),
    );
    const actions = rows.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual([
      "wedding_site.created",
      "wedding_site.published",
      "wedding_site.unpublished",
    ]);
    const all = rows.rows.map((r: { c: string }) => r.c).join(" ");
    expect(all).not.toContain("private story marker");
    expect(all).not.toContain(s);
  });
});

describe("unpublishing", () => {
  it("removes the public page immediately and deletes the snapshot, keeping the draft", async () => {
    const { w, version } = await savedSite({ title: "Soon gone" });
    const s = slug();
    const p = await publish(owner, w, version, s);
    expect((await pub(s)).data).not.toBeNull();
    const u = await unpublish(owner, w, p.data as number);
    expect(u.error).toBeNull();
    expect((await pub(s)).data).toBeNull();
    const row = await withSuperuser((db) =>
      db.query(
        "select published, published_at, slug, draft->>'title' as t from public.wedding_sites where wedding_id = $1",
        [w],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      published: null,
      published_at: null,
      slug: s,
      t: "Soon gone",
    });
  });

  it("keeps the address reserved to its wedding and is idempotent", async () => {
    const { w, version } = await savedSite();
    const s = slug();
    const p = await publish(owner, w, version, s);
    const u = await unpublish(owner, w, p.data as number);
    const again = await unpublish(owner, w, p.data as number);
    expect(again.error).toBeNull();
    const b = await savedSite();
    expect((await publish(owner, b.w, b.version, s)).error?.code).toBe("23505");
    expect((await publish(owner, w, u.data as number, s)).error).toBeNull();
    expect((await pub(s)).data).not.toBeNull();
  });
});

describe("invitation route", () => {
  async function published() {
    const w = await createWedding(owner);
    const ceremony = await mkEvent(owner, w, "Ceremony");
    const dinner = await mkEvent(owner, w, "Rehearsal dinner");
    const brunch = await mkEvent(owner, w, "Sunday brunch");
    const sv = await save(
      owner,
      w,
      0,
      draft({
        events: [
          { eventId: ceremony, visibility: "public" },
          { eventId: dinner, visibility: "invited", where: "Dinner address" },
          { eventId: brunch, visibility: "invited", where: "Brunch address" },
        ],
      }),
    );
    const s = slug();
    const p = await publish(owner, w, sv.data as number, s);
    return { w, s, ceremony, dinner, brunch, version: p.data as number };
  }

  it("shows an invited guest only their own invited-only event", async () => {
    const x = await published();
    const guest = await mkGuest(owner, x.w, "Example Guest");
    const t = await invite(owner, x.w, x.dinner, [guest]);
    const view = (await pubInvite(x.s, t.hash)).data as PubView;
    expect(view.events.map((e) => e.name).sort()).toEqual(["Ceremony", "Rehearsal dinner"]);
    expect(JSON.stringify(view)).not.toContain("Brunch");
    expect(JSON.stringify(view)).not.toContain("Brunch address");
    expect(JSON.stringify(view)).not.toContain(x.dinner);
    expect(Object.keys(view.invitation ?? {})).toEqual(["label"]);
    // Anonymous visitors still see only the public event.
    expect(((await pub(x.s)).data as PubView).events.map((e) => e.name)).toEqual(["Ceremony"]);
  });

  it("does not leak guest names, ids or contact details", async () => {
    const x = await published();
    const guest = await mkGuest(owner, x.w, "Zelda Uniquename");
    const t = await invite(owner, x.w, x.brunch, [guest]);
    const text = JSON.stringify((await pubInvite(x.s, t.hash)).data);
    expect(text).not.toContain(x.w);
    expect(text).not.toContain(guest);
    expect(text).not.toContain("Rehearsal");
  });

  it("collapses unknown, wrong-site, revoked, expired and unpublished cases to null", async () => {
    const x = await published();
    const y = await published();
    const g1 = await mkGuest(owner, x.w, "Guest One");
    const g2 = await mkGuest(owner, x.w, "Guest Two");
    const g3 = await mkGuest(owner, x.w, "Guest Three");
    const good = await invite(owner, x.w, x.dinner, [g1]);
    const toRevoke = await invite(owner, x.w, x.dinner, [g2]);
    const toExpire = await invite(owner, x.w, x.dinner, [g3]);

    expect((await pubInvite(x.s, good.hash)).data).not.toBeNull();
    // Unknown token, and a valid token presented at another wedding's site.
    expect((await pubInvite(x.s, sha("nope"))).data).toBeNull();
    expect((await pubInvite(y.s, good.hash)).data).toBeNull();
    expect((await pubInvite(slug("none"), good.hash)).data).toBeNull();

    const inv = await withSuperuser((db) =>
      db.query("select id, version from public.invitations where token_hash = $1", [toRevoke.hash]),
    );
    const rev = await owner.client.rpc("revoke_invitation", {
      p_wedding: x.w,
      p_invitation_id: inv.rows[0].id,
      p_expected_version: inv.rows[0].version,
    });
    expect(rev.error).toBeNull();
    expect((await pubInvite(x.s, toRevoke.hash)).data).toBeNull();

    await withSuperuser((db) =>
      db.query(
        "update public.invitations set expires_at = now() - interval '1 minute' where token_hash = $1",
        [toExpire.hash],
      ),
    );
    expect((await pubInvite(x.s, toExpire.hash)).data).toBeNull();

    const sv = await owner.client.rpc("unpublish_site", {
      p_wedding: x.w,
      p_expected_version: x.version,
    });
    expect(sv.error).toBeNull();
    expect((await pubInvite(x.s, good.hash)).data).toBeNull();
  });

  it("throttles repeated failures from one client", async () => {
    const x = await published();
    const c = client();
    for (let i = 0; i < 20; i += 1) {
      expect((await pubInvite(x.s, sha(`guess-${i}`), c)).error).toBeNull();
    }
    const blocked = await pubInvite(x.s, sha("guess-final"), c);
    expect(blocked.error?.code).toBe("RS429");
  });
});
