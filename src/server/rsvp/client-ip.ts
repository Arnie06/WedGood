import { isIP } from "node:net";

/**
 * UX-15: which address the public-link failure throttle counts against.
 *
 * The first `X-Forwarded-For` entry is whatever the client typed, so keying on it lets a guesser
 * rotate keys and never be throttled. In production the address must come from a header the
 * hosting platform (or our own outermost proxy) sets and overwrites, named by CLIENT_IP_HEADER,
 * for example `x-vercel-forwarded-for`, `cf-connecting-ip`, `fly-client-ip` or an `x-real-ip`
 * our nginx sets. Without it, production has no trustworthy key and public lookups report
 * "unavailable" rather than throttle on a spoofable value.
 *
 * Pure and framework-free so it can be unit tested; `clientKey()` in ./public reads the request.
 */

export type ClientIpConfig =
  | { kind: "trusted"; header: string }
  /** Development and tests only: the old best-effort key, spoofable and fine on localhost. */
  | { kind: "dev" }
  /** Production with no trusted header configured. */
  | { kind: "unconfigured" };

const HEADER_NAME = /^[a-z0-9-]+$/;

export class ClientIpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientIpConfigError";
  }
}

export function parseClientIpConfig(raw: string | undefined, production: boolean): ClientIpConfig {
  const header = raw?.trim().toLowerCase() ?? "";
  if (header === "") return production ? { kind: "unconfigured" } : { kind: "dev" };
  if (!HEADER_NAME.test(header)) {
    throw new ClientIpConfigError("CLIENT_IP_HEADER must be a single HTTP header name");
  }
  return { kind: "trusted", header };
}

type HeaderGetter = (name: string) => string | null;

/**
 * The throttle subject for a request: a normalized address, a fixed bucket, or null when
 * production is unconfigured. IPv6 addresses are grouped by their /64, because one subscriber
 * usually controls a whole /64 and could otherwise rotate through it to dodge the throttle.
 */
export function throttleSubject(get: HeaderGetter, config: ClientIpConfig): string | null {
  switch (config.kind) {
    case "unconfigured":
      return null;
    case "trusted": {
      // A trusted header normally holds one address. When the platform appends to a list (as
      // X-Forwarded-For proxies do), the last entry is the one it added itself, so use that.
      const entry = get(config.header)?.split(",").at(-1);
      // A request that skipped the platform has no such header; those all share one bucket.
      return normalizeAddress(entry) ?? "missing";
    }
    case "dev": {
      const forwarded = get("x-forwarded-for")?.split(",")[0] ?? get("x-real-ip");
      return normalizeAddress(forwarded) ?? "unknown";
    }
  }
}

/** Canonical form of an IPv4 or IPv6 address (IPv6 as its /64), or null when it isn't one. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  let value = raw?.trim() ?? "";
  if (value === "") return null;
  // "[2001:db8::1]:443" and "203.0.113.7:51234" (some proxies include the port).
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.indexOf(":"));
  // Drop an IPv6 zone id ("fe80::1%eth0").
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);

  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  const groups = expandIpv6(value.toLowerCase());
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d) is the IPv4 client, not an IPv6 /64.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Eight 16-bit groups from a valid IPv6 string (already checked with isIP). */
function expandIpv6(value: string): number[] | null {
  let text = value;
  // Trailing dotted IPv4 ("::ffff:192.0.2.1") becomes two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  const groups = all.map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}
