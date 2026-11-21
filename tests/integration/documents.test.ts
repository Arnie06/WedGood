import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  anonClient,
  createUser,
  createWedding,
  withSuperuser,
  type TestUser,
} from "./helpers";

const BUCKET = "wedding-documents";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");

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
  owner = await createUser("docs-owner");
  stranger = await createUser("docs-stranger");
});

type Meta = {
  kind?: string;
  title?: string;
  mime?: string;
  bytes?: number;
  name?: string;
  key?: string;
};
function intent(user: TestUser, w: string, m: Meta = {}) {
  return user.client.rpc("create_document_intent", {
    p_wedding: w,
    p_kind: m.kind ?? "contract",
    p_title: m.title ?? "Venue contract",
    p_mime: m.mime ?? "application/pdf",
    p_bytes: m.bytes ?? PDF.byteLength,
    ...(m.name && { p_original_name: m.name }),
    ...(m.key && { p_idempotency_key: m.key }),
  });
}
async function newIntent(user: TestUser, w: string, m: Meta = {}) {
  const { data, error } = await intent(user, w, m);
  if (error) throw new Error(error.message);
  return data as string;
}
async function docRow(id: string) {
  return withSuperuser(async (db) => {
    const r = await db.query<{
      scan_status: string;
      version: number;
      storage_key: string;
      archived_at: string | null;
      checksum: string | null;
    }>(
      "select scan_status, version, storage_key, archived_at, checksum from public.documents where id=$1",
      [id],
    );
    return r.rows[0]!;
  });
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the server does after validating: store with the service role, then complete. */
async function store(w: string, id: string, bytes: Uint8Array = PDF) {
  const key = `${w}/${id}`;
  const up = await adminClient().storage.from(BUCKET).upload(key, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (up.error) throw new Error(up.error.message);
  const done = await adminClient().rpc("complete_document", {
    p_document: id,
    p_checksum: sha(bytes),
    p_bytes: bytes.byteLength,
  });
  if (done.error) throw new Error(done.error.message);
  return key;
}
async function uploaded(user: TestUser, w: string, m: Meta = {}) {
  const id = await newIntent(user, w, m);
  const key = await store(w, id);
  return { id, key };
}
async function canDownload(user: { client: TestUser["client"] }, key: string) {
  const { data, error } = await user.client.storage.from(BUCKET).download(key);
  return !error && data !== null;
}
async function canSign(user: { client: TestUser["client"] }, key: string) {
  const { data, error } = await user.client.storage.from(BUCKET).createSignedUrl(key, 30);
  return !error && !!data?.signedUrl;
}

describe("upload intent", () => {
  it("records a pending document with a random key and no readable object", async () => {
    const w = await createWedding(owner);
    const id = await newIntent(owner, w, { name: "..\\..\\evil.pdf" });
    const row = await docRow(id);
    expect(row.scan_status).toBe("pending");
    expect(row.storage_key).toBe(`${w}/${id}`);
    expect(row.storage_key).not.toContain("evil");
    expect(row.checksum).toBeNull();
    // Not listed as a downloadable document, and no object exists to fetch.
    expect(await canSign(owner, row.storage_key)).toBe(false);
  });

  it("refuses invalid input and leaves no rows behind", async () => {
    const w = await createWedding(owner);
    const bad: Meta[] = [
      { kind: "selfie" },
      { title: "   " },
      { title: "x".repeat(161) },
      { mime: "text/html" },
      { mime: "image/svg+xml" },
      { bytes: 0 },
      { bytes: 10 * 1024 * 1024 + 1 },
      { name: "n".repeat(201) },
    ];
    for (const m of bad) {
      const { error } = await intent(owner, w, m);
      expect(error?.code, JSON.stringify(m)).toBe("22023");
    }
    const count = await withSuperuser((db) =>
      db.query("select count(*)::int as n from public.documents where wedding_id=$1", [w]),
    );
    expect(count.rows[0].n).toBe(0);
  });

  it("is idempotent under 5 concurrent submits and rejects a changed payload on the same key", async () => {
    const w = await createWedding(owner);
    const key = `doc-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => intent(owner, w, { key })));
    const ids = new Set(results.map((r) => r.data));
    expect(results.every((r) => !r.error)).toBe(true);
    expect(ids.size).toBe(1);
    const count = await withSuperuser((db) =>
      db.query("select count(*)::int as n from public.documents where wedding_id=$1", [w]),
    );
    expect(count.rows[0].n).toBe(1);
    const changed = await intent(owner, w, { key, title: "Different" });
    expect(changed.error?.code).toBe("23505");
  });

  it("caps in-flight uploads", async () => {
    const w = await createWedding(owner);
    for (let i = 0; i < 10; i++) await newIntent(owner, w);
    const { error } = await intent(owner, w);
    expect(error?.code).toBe("54000");
  });
});

describe("roles and direct access", () => {
  it("allows owner and partner, denies editor, viewer, outsider and anonymous", async () => {
    const w = await createWedding(owner);
    const partner = await addMember(w, "partner", "docs-partner");
    const editor = await addMember(w, "editor", "docs-editor");
    const viewer = await addMember(w, "viewer", "docs-viewer");
    expect((await intent(partner, w)).error).toBeNull();
    for (const u of [editor, viewer, stranger]) {
      expect((await intent(u, w)).error?.code).toBe("42501");
    }
    expect((await intent({ client: anonClient() } as TestUser, w)).error).not.toBeNull();
  });

  it("hides rows and objects from non-managers and other tenants", async () => {
    const w = await createWedding(owner);
    const editor = await addMember(w, "editor", "docs-editor2");
    const viewer = await addMember(w, "viewer", "docs-viewer2");
    const partner = await addMember(w, "partner", "docs-partner2");
    const other = await createUser("docs-other-owner");
    await createWedding(other);
    const { id, key } = await uploaded(owner, w);
    for (const u of [owner, partner]) {
      const { data } = await u.client.from("documents").select("id").eq("id", id);
      expect(data).toHaveLength(1);
      expect(await canDownload(u, key)).toBe(true);
      expect(await canSign(u, key)).toBe(true);
    }
    for (const u of [editor, viewer, stranger, other]) {
      const { data } = await u.client.from("documents").select("id").eq("id", id);
      expect(data).toHaveLength(0);
      expect(await canDownload(u, key)).toBe(false);
      expect(await canSign(u, key)).toBe(false);
    }
    const anon = { client: anonClient() };
    expect(await canDownload(anon, key)).toBe(false);
    expect(await canSign(anon, key)).toBe(false);
    // A public URL form never works for a private bucket.
    const pub = owner.client.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
    expect((await fetch(pub)).ok).toBe(false);
  });

  it("denies direct table writes and client-side storage writes", async () => {
    const w = await createWedding(owner);
    const id = await newIntent(owner, w);
    const ins = await owner.client.from("documents").insert({
      wedding_id: w,
      kind: "other",
      title: "x",
      storage_key: `${w}/${randomUUID()}`,
      mime: "application/pdf",
      bytes: 10,
    });
    expect(ins.error).not.toBeNull();
    const upd = await owner.client
      .from("documents")
      .update({ scan_status: "clean" })
      .eq("id", id)
      .select();
    expect(upd.data ?? []).toHaveLength(0);
    expect((await docRow(id)).scan_status).toBe("pending");
    const del = await owner.client.from("documents").delete().eq("id", id).select();
    expect(del.data ?? []).toHaveLength(0);
    // The uploader cannot write the object for its own pending intent: only the server can.
    const up = await owner.client.storage.from(BUCKET).upload(`${w}/${id}`, PDF, {
      contentType: "application/pdf",
    });
    expect(up.error).not.toBeNull();
    expect((await docRow(id)).scan_status).toBe("pending");
    const link = await owner.client
      .from("document_links")
      .insert({ wedding_id: w, document_id: id });
    expect(link.error).not.toBeNull();
  });

  it("does not let a signed-in user mark a file validated or rejected", async () => {
    const w = await createWedding(owner);
    const id = await newIntent(owner, w);
    const complete = await owner.client.rpc("complete_document", {
      p_document: id,
      p_checksum: "a".repeat(64),
      p_bytes: PDF.byteLength,
    });
    expect(complete.error).not.toBeNull();
    const reject = await owner.client.rpc("reject_document", { p_document: id, p_reason: "x" });
    expect(reject.error).not.toBeNull();
    expect((await docRow(id)).scan_status).toBe("pending");
  });
});

describe("completion and rejection (server side)", () => {
  it("marks a stored file unscanned, never clean, and records the checksum", async () => {
    const w = await createWedding(owner);
    const id = await newIntent(owner, w);
    await store(w, id);
    const row = await docRow(id);
    expect(row.scan_status).toBe("unscanned");
    expect(row.checksum).toBe(sha(PDF));
  });

  it("refuses completion when the object is missing, the wrong size, or already completed", async () => {
    const w = await createWedding(owner);
    const missing = await newIntent(owner, w);
    const r1 = await adminClient().rpc("complete_document", {
      p_document: missing,
      p_checksum: sha(PDF),
      p_bytes: PDF.byteLength,
    });
    expect(r1.error?.code).toBe("22023");

    const wrong = await newIntent(owner, w);
    await adminClient()
      .storage.from(BUCKET)
      .upload(`${w}/${wrong}`, new Uint8Array([1, 2, 3]), {
        contentType: "application/pdf",
      });
    const r2 = await adminClient().rpc("complete_document", {
      p_document: wrong,
      p_checksum: sha(PDF),
      p_bytes: PDF.byteLength,
    });
    expect(r2.error?.code).toBe("22023");
    expect((await docRow(wrong)).scan_status).toBe("pending");

    const done = await uploaded(owner, w);
    const r3 = await adminClient().rpc("complete_document", {
      p_document: done.id,
      p_checksum: sha(PDF),
      p_bytes: PDF.byteLength,
    });
    expect(r3.error?.code).toBe("55000");
  });

  it("keeps a rejected upload unreadable and unlinkable", async () => {
    const w = await createWedding(owner);
    const id = await newIntent(owner, w);
    const rej = await adminClient().rpc("reject_document", {
      p_document: id,
      p_reason: "Bad type",
    });
    expect(rej.error).toBeNull();
    const row = await docRow(id);
    expect(row.scan_status).toBe("rejected");
    expect(await canSign(owner, row.storage_key)).toBe(false);
    const cand = await owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Hall",
    });
    const link = await owner.client.rpc("link_document", {
      p_wedding: w,
      p_document: id,
      p_target_type: "candidate",
      p_target: cand.data,
    });
    expect(link.error?.code).toBe("55000");
    const again = await adminClient().rpc("reject_document", { p_document: id, p_reason: "again" });
    expect(again.error?.code).toBe("55000");
  });

  it("the bucket itself refuses types outside the allowlist", async () => {
    const w = await createWedding(owner);
    const up = await adminClient()
      .storage.from(BUCKET)
      .upload(`${w}/${randomUUID()}`, new TextEncoder().encode("<html>"), {
        contentType: "text/html",
      });
    expect(up.error).not.toBeNull();
  });
});

describe("archive and update", () => {
  it("archiving removes download access at the storage policy, and is versioned", async () => {
    const w = await createWedding(owner);
    const { id, key } = await uploaded(owner, w);
    const row = await docRow(id);
    expect(await canSign(owner, key)).toBe(true);
    const stale = await owner.client.rpc("archive_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: row.version - 1,
    });
    expect(stale.error?.code).toBe("55000");
    const ok = await owner.client.rpc("archive_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: row.version,
    });
    expect(ok.error).toBeNull();
    expect(await canSign(owner, key)).toBe(false);
    expect(await canDownload(owner, key)).toBe(false);
    // Repeating is harmless.
    const again = await owner.client.rpc("archive_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: row.version,
    });
    expect(again.error).toBeNull();
  });

  it("updates title and kind with a version check; a no-op writes nothing; one concurrent winner", async () => {
    const w = await createWedding(owner);
    const { id } = await uploaded(owner, w);
    const { version } = await docRow(id);
    const noop = await owner.client.rpc("update_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: version,
      p_title: "Venue contract",
      p_kind: "contract",
    });
    expect(noop.error).toBeNull();
    expect((await docRow(id)).version).toBe(version);

    const race = await Promise.all(
      ["A", "B", "C"].map((t) =>
        owner.client.rpc("update_document", {
          p_wedding: w,
          p_document: id,
          p_expected_version: version,
          p_title: `Title ${t}`,
          p_kind: "receipt",
        }),
      ),
    );
    expect(race.filter((r) => !r.error)).toHaveLength(1);
    expect(race.filter((r) => r.error?.code === "55000")).toHaveLength(2);
    const bad = await owner.client.rpc("update_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: version + 1,
      p_title: " ",
      p_kind: "receipt",
    });
    expect(bad.error?.code).toBe("22023");
  });

  it("denies update and archive to a viewer and to another workspace's owner", async () => {
    const w = await createWedding(owner);
    const viewer = await addMember(w, "viewer", "docs-viewer3");
    const { id } = await uploaded(owner, w);
    const { version } = await docRow(id);
    for (const u of [viewer, stranger]) {
      const a = await u.client.rpc("archive_document", {
        p_wedding: w,
        p_document: id,
        p_expected_version: version,
      });
      expect(a.error?.code).toBe("42501");
    }
    // An owner of a different workspace naming this document through their own workspace id.
    const mine = await createWedding(stranger);
    const x = await stranger.client.rpc("archive_document", {
      p_wedding: mine,
      p_document: id,
      p_expected_version: version,
    });
    expect(x.error?.code).toBe("42501");
    expect((await docRow(id)).archived_at).toBeNull();
  });
});

describe("links", () => {
  async function bookedWedding() {
    const w = await createWedding(owner, { guests: 100 });
    const cand = await owner.client.rpc("create_candidate", {
      p_wedding: w,
      p_kind: "venue",
      p_category: "venue",
      p_name: "Garden House",
    });
    const cat = await owner.client.rpc("create_budget_category", { p_wedding: w, p_name: "Venue" });
    const item = await owner.client.rpc("create_budget_item", {
      p_wedding: w,
      p_category: cat.data,
      p_name: "Venue fee",
      p_amount_minor: 900_000,
    });
    const commitment = await owner.client.rpc("book_commitment", {
      p_wedding: w,
      p_candidate: cand.data,
      p_expected_candidate_version: 1,
      p_title: "Venue contract",
      p_amount_minor: 1_000_000,
      p_allocations: [{ itemId: item.data, amountMinor: 1_000_000 }],
      p_installments: [],
      p_confirmed: true,
    });
    expect(commitment.error).toBeNull();
    const payment = await owner.client.rpc("record_payment", {
      p_wedding: w,
      p_kind: "charge",
      p_amount_minor: 250_000,
      p_paid_on: "2026-01-02",
      p_commitment: commitment.data,
    });
    expect(payment.error).toBeNull();
    return {
      w,
      candidate: cand.data as string,
      commitment: commitment.data as string,
      payment: payment.data as string,
    };
  }
  const link = (w: string, doc: string, type: string, target: string) =>
    owner.client.rpc("link_document", {
      p_wedding: w,
      p_document: doc,
      p_target_type: type,
      p_target: target,
    });
  const linkCount = async (doc: string) =>
    (
      await withSuperuser((db) =>
        db.query("select count(*)::int as n from public.document_links where document_id=$1", [
          doc,
        ]),
      )
    ).rows[0].n as number;

  it("attaches to a booking, a payment and a vendor, idempotently, and detaches", async () => {
    const s = await bookedWedding();
    const { id } = await uploaded(owner, s.w);
    expect((await link(s.w, id, "commitment", s.commitment)).error).toBeNull();
    expect((await link(s.w, id, "payment", s.payment)).error).toBeNull();
    expect((await link(s.w, id, "candidate", s.candidate)).error).toBeNull();
    expect(await linkCount(id)).toBe(3);
    expect((await link(s.w, id, "payment", s.payment)).error).toBeNull();
    expect(await linkCount(id)).toBe(3);
    const un = await owner.client.rpc("unlink_document", {
      p_wedding: s.w,
      p_document: id,
      p_target_type: "payment",
      p_target: s.payment,
    });
    expect(un.error).toBeNull();
    expect(await linkCount(id)).toBe(2);
  });

  it("refuses targets from another workspace and unknown target types", async () => {
    const s = await bookedWedding();
    const o = await bookedWedding();
    const { id } = await uploaded(owner, s.w);
    const cross = await link(s.w, id, "commitment", o.commitment);
    expect(cross.error?.code).toBe("22023");
    expect((await link(s.w, id, "guest", s.commitment)).error?.code).toBe("22023");
    expect((await link(s.w, id, "commitment", randomUUID())).error?.code).toBe("22023");
    expect(await linkCount(id)).toBe(0);
  });

  it("refuses links to a pending or archived document, and hides links from non-managers", async () => {
    const s = await bookedWedding();
    const pending = await newIntent(owner, s.w);
    expect((await link(s.w, pending, "commitment", s.commitment)).error?.code).toBe("55000");
    const { id } = await uploaded(owner, s.w);
    await link(s.w, id, "commitment", s.commitment);
    const viewer = await addMember(s.w, "viewer", "docs-viewer4");
    const seen = await viewer.client.from("document_links").select("id").eq("document_id", id);
    expect(seen.data).toHaveLength(0);
    const { version } = await docRow(id);
    await owner.client.rpc("archive_document", {
      p_wedding: s.w,
      p_document: id,
      p_expected_version: version,
    });
    expect((await link(s.w, id, "candidate", s.candidate)).error?.code).toBe("55000");
  });

  it("denies link changes to editors and viewers", async () => {
    const s = await bookedWedding();
    const { id } = await uploaded(owner, s.w);
    const editor = await addMember(s.w, "editor", "docs-editor5");
    const r = await editor.client.rpc("link_document", {
      p_wedding: s.w,
      p_document: id,
      p_target_type: "commitment",
      p_target: s.commitment,
    });
    expect(r.error?.code).toBe("42501");
    const u = await editor.client.rpc("unlink_document", {
      p_wedding: s.w,
      p_document: id,
      p_target_type: "commitment",
      p_target: s.commitment,
    });
    expect(u.error?.code).toBe("42501");
  });
});

describe("audit", () => {
  it("records actions by field name only, never titles, names or contents", async () => {
    const w = await createWedding(owner);
    const { id } = await uploaded(owner, w, {
      title: "Secret venue contract",
      name: "private-name.pdf",
    });
    const { version } = await docRow(id);
    await owner.client.rpc("update_document", {
      p_wedding: w,
      p_document: id,
      p_expected_version: version,
      p_title: "Another secret title",
      p_kind: "invoice",
    });
    const events = await withSuperuser((db) =>
      db.query(
        "select action, safe_changes from public.audit_events where entity_id=$1 order by occurred_at, id",
        [id],
      ),
    );
    const actions = events.rows.map((r) => r.action);
    expect(actions).toEqual(["document.upload_started", "document.uploaded", "document.updated"]);
    const text = JSON.stringify(events.rows);
    expect(text).not.toMatch(/secret|private-name/i);
    expect(events.rows[2].safe_changes).toEqual({ fields: ["title", "kind"] });
  });
});
