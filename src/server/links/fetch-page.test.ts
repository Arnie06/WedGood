import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT_POLICY, fetchPublicPage, fetchWithPolicy, type FetchPolicy } from "./fetch-page";

let server: http.Server;
let base: string;
let seenUserAgent = "";
let seenCookie: string | undefined;

// A permissive policy so the real network code can be exercised against a local server.
// The app itself only ever calls fetchPublicPage (STRICT_POLICY).
const local = (over: Partial<FetchPolicy> = {}): FetchPolicy => ({
  ...STRICT_POLICY,
  ports: [Number(new URL(base).port)],
  isAllowedAddress: () => true,
  isAllowedHost: () => true,
  timeoutMs: 1500,
  ...over,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenUserAgent = String(req.headers["user-agent"] ?? "");
    seenCookie = req.headers.cookie;
    const path = req.url ?? "/";
    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<title>Hello Venue</title>");
    } else if (path === "/gzip") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync("<title>Zipped</title>"));
    } else if (path === "/bomb") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(5 * 1024 * 1024, "a")));
    } else if (path === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("a".repeat(2 * 1024 * 1024));
    } else if (path === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (path === "/404") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("nope");
    } else if (path === "/slow") {
      // never answers
    } else if (path === "/redir") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else if (path === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (path === "/to-private") {
      res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
      res.end();
    } else if (path === "/to-file") {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    } else if (path === "/to-cred") {
      res.writeHead(302, { location: "http://user:pw@example.com/" });
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("fetchWithPolicy (real HTTP, permissive local policy)", () => {
  it("reads an HTML page, sends a generic identity and no cookies", async () => {
    const r = await fetchWithPolicy(new URL(`${base}/ok`), local());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.html).toContain("Hello Venue");
    expect(seenUserAgent).toMatch(/^WeddingWorkspace-LinkLookup\//);
    expect(seenCookie).toBeUndefined();
  });

  it("decodes gzip and follows a same-site redirect", async () => {
    const z = await fetchWithPolicy(new URL(`${base}/gzip`), local());
    expect(z.ok && z.html).toContain("Zipped");
    const r = await fetchWithPolicy(new URL(`${base}/redir`), local());
    expect(r.ok && r.finalUrl.pathname).toBe("/ok");
  });

  it("caps the decompressed size (zip bomb) and the raw size", async () => {
    expect(await fetchWithPolicy(new URL(`${base}/bomb`), local())).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(await fetchWithPolicy(new URL(`${base}/big`), local())).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses non-HTML and error statuses", async () => {
    expect(await fetchWithPolicy(new URL(`${base}/json`), local())).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await fetchWithPolicy(new URL(`${base}/404`), local())).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("times out on a server that never answers", async () => {
    const started = Date.now();
    expect(await fetchWithPolicy(new URL(`${base}/slow`), local({ timeoutMs: 400 }))).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops redirect loops and refuses redirects to unsafe targets", async () => {
    expect((await fetchWithPolicy(new URL(`${base}/loop`), local())).ok).toBe(false);
    // Strict host rules apply on each hop even if the first hop was allowed.
    const strictHosts = local({
      isAllowedHost: (h) => h === "127.0.0.1" && true,
      ports: [Number(new URL(base).port)],
    });
    expect(await fetchWithPolicy(new URL(`${base}/to-private`), strictHosts)).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(await fetchWithPolicy(new URL(`${base}/to-file`), local())).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(await fetchWithPolicy(new URL(`${base}/to-cred`), local())).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("refuses a hostname that resolves to a non-public address, even when the name looks fine", async () => {
    // 'localhost' resolves to loopback; with the real address policy the connection is never made.
    const policy = local({
      isAllowedAddress: STRICT_POLICY.isAllowedAddress,
      isAllowedHost: () => true,
    });
    const url = new URL(base.replace("127.0.0.1", "localhost"));
    url.pathname = "/ok";
    const r = await fetchWithPolicy(url, policy);
    expect(r.ok).toBe(false);
  });
});

describe("fetchPublicPage (strict policy, what the app uses)", () => {
  it("never reaches a local server, by IP or by name", async () => {
    for (const host of ["127.0.0.1", "localhost"]) {
      const url = new URL(base.replace("127.0.0.1", host));
      url.pathname = "/ok";
      const before = seenUserAgent;
      seenUserAgent = "";
      const r = await fetchPublicPage(url);
      expect(r.ok, host).toBe(false);
      expect(seenUserAgent, `${host} must not have connected`).toBe("");
      seenUserAgent = before;
    }
  });

  it("refuses metadata, private and unusual-port targets without connecting", async () => {
    for (const u of [
      "http://169.254.169.254/latest/",
      "http://10.0.0.1/",
      "https://example.com:8443/",
      "ftp://example.com/",
    ]) {
      expect((await fetchPublicPage(new URL(u))).ok, u).toBe(false);
    }
  });
});
