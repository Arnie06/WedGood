import { describe, expect, it } from "vitest";
import {
  ClientIpConfigError,
  normalizeAddress,
  parseClientIpConfig,
  throttleSubject,
} from "./client-ip";

const headers =
  (values: Record<string, string>) =>
  (name: string): string | null =>
    values[name] ?? null;

describe("parseClientIpConfig", () => {
  it("uses the dev key outside production when unset", () => {
    expect(parseClientIpConfig(undefined, false)).toEqual({ kind: "dev" });
    expect(parseClientIpConfig("  ", false)).toEqual({ kind: "dev" });
  });

  it("is unconfigured in production when unset", () => {
    expect(parseClientIpConfig(undefined, true)).toEqual({ kind: "unconfigured" });
    expect(parseClientIpConfig("", true)).toEqual({ kind: "unconfigured" });
  });

  it("lower-cases and trims a configured header", () => {
    expect(parseClientIpConfig(" CF-Connecting-IP ", true)).toEqual({
      kind: "trusted",
      header: "cf-connecting-ip",
    });
  });

  it("rejects values that are not one header name", () => {
    expect(() => parseClientIpConfig("x-real-ip, x-forwarded-for", true)).toThrow(
      ClientIpConfigError,
    );
    expect(() => parseClientIpConfig("x real ip", false)).toThrow(ClientIpConfigError);
  });
});

describe("throttleSubject", () => {
  const trusted = parseClientIpConfig("x-vercel-forwarded-for", true);

  it("ignores a client-supplied X-Forwarded-For when a trusted header is configured", () => {
    const get = headers({
      "x-forwarded-for": "198.51.100.1",
      "x-vercel-forwarded-for": "203.0.113.7",
    });
    expect(throttleSubject(get, trusted)).toBe("203.0.113.7");
  });

  it("gives the same subject however the spoofable header is rotated", () => {
    const a = headers({ "x-forwarded-for": "1.1.1.1", "x-vercel-forwarded-for": "203.0.113.7" });
    const b = headers({ "x-forwarded-for": "2.2.2.2", "x-vercel-forwarded-for": "203.0.113.7" });
    expect(throttleSubject(a, trusted)).toBe(throttleSubject(b, trusted));
  });

  it("takes the entry the proxy appended when the trusted header is a list", () => {
    const xff = parseClientIpConfig("x-forwarded-for", true);
    const get = headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(throttleSubject(get, xff)).toBe("203.0.113.7");
  });

  it("puts requests without the trusted header, or with garbage, in one shared bucket", () => {
    expect(throttleSubject(headers({ "x-forwarded-for": "1.2.3.4" }), trusted)).toBe("missing");
    expect(throttleSubject(headers({ "x-vercel-forwarded-for": "nope" }), trusted)).toBe("missing");
  });

  it("has no subject when production is unconfigured", () => {
    const get = headers({ "x-forwarded-for": "203.0.113.7" });
    expect(throttleSubject(get, { kind: "unconfigured" })).toBeNull();
  });

  it("keeps the best-effort key in development", () => {
    const dev = { kind: "dev" } as const;
    expect(throttleSubject(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), dev)).toBe(
      "203.0.113.7",
    );
    expect(throttleSubject(headers({ "x-real-ip": "::1" }), dev)).toBe("0:0:0:0::/64");
    expect(throttleSubject(headers({}), dev)).toBe("unknown");
  });
});

describe("normalizeAddress", () => {
  it("accepts IPv4, with or without a port", () => {
    expect(normalizeAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress(" 203.0.113.7:51234 ")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by /64 so one subscriber can't rotate through its range", () => {
    const one = normalizeAddress("2001:db8:1:2::1");
    expect(one).toBe("2001:db8:1:2::/64");
    expect(normalizeAddress("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(one);
    expect(normalizeAddress("[2001:db8:1:2::9]:443")).toBe(one);
    expect(normalizeAddress("2001:db8:1:3::1")).not.toBe(one);
  });

  it("treats IPv4-mapped IPv6 as the IPv4 client", () => {
    expect(normalizeAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAddress("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("drops a zone id", () => {
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("rejects anything that isn't an address", () => {
    for (const bad of [null, undefined, "", "unknown", "300.1.1.1", "1.2.3", "a:b:c", "::g"]) {
      expect(normalizeAddress(bad)).toBeNull();
    }
  });
});
