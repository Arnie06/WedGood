import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isBlockedHostname } from "@/domain/links/url";
import { isPublicAddress } from "./ip-policy";
import { siteDecision } from "./site-rules";

/**
 * Reads one public web page for the member-initiated link lookup (ADR-029). Every
 * connection is made to an address this module has just validated (the DNS lookup used
 * by the socket is the validating one, so there is no rebinding gap), redirects are
 * re-validated hop by hop, and size and time are capped. Nothing from the page is
 * executed; the caller only receives text.
 */
export type FetchPolicy = {
  ports: readonly number[];
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
  isAllowedAddress: (address: string) => boolean;
  /** Hostname rules; tests relax this for a local server. */
  isAllowedHost: (hostname: string) => boolean;
};

export const STRICT_POLICY: FetchPolicy = {
  ports: [80, 443],
  maxRedirects: 3,
  timeoutMs: 8_000,
  maxBytes: 512 * 1024,
  isAllowedAddress: isPublicAddress,
  isAllowedHost: (hostname) => !isBlockedHostname(hostname),
};

export type FetchFailure =
  "invalid_url" | "blocked_site" | "unreachable" | "timeout" | "unsupported" | "too_large";

export type FetchResult =
  { ok: true; html: string; finalUrl: URL } | { ok: false; reason: FetchFailure; message?: string };

const USER_AGENT = "WeddingWorkspace-LinkLookup/0.1 (page read requested by a member)";

class Refused extends Error {
  constructor(readonly reason: FetchFailure) {
    super(reason);
  }
}

function validatingLookup(policy: FetchPolicy): net_Lookup {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, "", 0);
      const usable = addresses.filter((a) => policy.isAllowedAddress(a.address));
      // One non-public answer is enough to refuse: never "pick the safe one".
      if (usable.length === 0 || usable.length !== addresses.length) {
        return callback(new Refused("unreachable"), "", 0);
      }
      if (options.all) return callback(null, usable as never, 0 as never);
      const first = usable[0]!;
      return callback(null, first.address, first.family);
    });
  };
}
type net_Lookup = NonNullable<http.RequestOptions["lookup"]>;

function decoderFor(encoding: string | undefined) {
  switch ((encoding ?? "").toLowerCase().trim()) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Refused("unsupported");
  }
}

type Hop = { status: number; location: string | null; html: string | null };

function requestOnce(url: URL, policy: FetchPolicy, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Refused("timeout"));
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        lookup: validatingLookup(policy),
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location ?? null;
          return location
            ? resolve({ status, location, html: null })
            : reject(new Refused("unreachable"));
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Refused("unreachable"));
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (!/^(text\/html|application\/xhtml\+xml)/.test(type)) {
          res.resume();
          return reject(new Refused("unsupported"));
        }
        let decoder: ReturnType<typeof decoderFor>;
        try {
          decoder = decoderFor(res.headers["content-encoding"]);
        } catch (e) {
          res.resume();
          return reject(e);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = decoder ? res.pipe(decoder) : res;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > policy.maxBytes) {
            req.destroy();
            reject(new Refused("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
          let label = "utf-8";
          try {
            new TextDecoder(charset);
            label = charset;
          } catch {
            // Unknown label: fall back to UTF-8.
          }
          resolve({
            status,
            location: null,
            html: new TextDecoder(label).decode(Buffer.concat(chunks)),
          });
        });
        stream.on("error", () => reject(new Refused("unreachable")));
        res.on("error", () => reject(new Refused("unreachable")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Refused("timeout"));
    }, remaining);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) =>
      reject(error instanceof Refused ? error : new Refused("unreachable")),
    );
    req.end();
  });
}

function checkUrl(url: URL, policy: FetchPolicy): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused("invalid_url");
  if (url.username !== "" || url.password !== "") throw new Refused("invalid_url");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.ports.includes(port)) throw new Refused("invalid_url");
  if (!policy.isAllowedHost(url.hostname)) throw new Refused("invalid_url");
  if (!siteDecision(url.hostname).allowed) throw new Refused("blocked_site");
}

export async function fetchWithPolicy(start: URL, policy: FetchPolicy): Promise<FetchResult> {
  const deadline = Date.now() + policy.timeoutMs;
  let url = start;
  try {
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      checkUrl(url, policy);
      const result = await requestOnce(url, policy, deadline);
      if (result.html !== null) return { ok: true, html: result.html, finalUrl: url };
      let next: URL;
      try {
        next = new URL(result.location ?? "", url);
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      url = next;
    }
    return { ok: false, reason: "unreachable" };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    return { ok: false, reason: "unreachable" };
  }
}

/** The only entry point the app uses: always the strict policy. */
export function fetchPublicPage(url: URL): Promise<FetchResult> {
  return fetchWithPolicy(url, STRICT_POLICY);
}
