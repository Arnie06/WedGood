import { describe, expect, it } from "vitest";
import { isBlockedHostname, parseLookupUrl } from "./url";

const ok = (input: string) => {
  const r = parseLookupUrl(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason} for ${input}`);
  return r.url;
};
const reason = (input: string) => {
  const r = parseLookupUrl(input);
  return r.ok ? "ok" : r.reason;
};

describe("parseLookupUrl", () => {
  it("accepts normal https and http links and strips the fragment", () => {
    expect(ok("https://www.gardenhouse.com/weddings#pricing").href).toBe(
      "https://www.gardenhouse.com/weddings",
    );
    expect(ok("http://gardenhouse.com/").protocol).toBe("http:");
  });

  it("assumes https for a bare address and trims spaces", () => {
    expect(ok("  gardenhouse.com/venue ").href).toBe("https://gardenhouse.com/venue");
  });

  it("refuses non-web schemes", () => {
    for (const s of [
      "javascript:alert(1)",
      "ftp://x.com/a",
      "file:///etc/passwd",
      "data:text/html,hi",
    ])
      expect(reason(s)).toBe("scheme");
  });

  it("refuses embedded credentials and unusual ports", () => {
    expect(reason("https://user:pw@example.com/")).toBe("credentials");
    expect(reason("https://example.com:8080/")).toBe("port");
    expect(reason("example.com:22")).toBe("port");
    expect(ok("https://example.com:443/").hostname).toBe("example.com");
  });

  it("refuses local, internal and IP-literal hosts in every spelling", () => {
    for (const h of [
      "http://localhost/",
      "http://LOCALHOST./",
      "http://127.0.0.1/",
      "http://2130706433/", // decimal
      "http://0x7f000001/", // hex
      "http://0177.0.0.1/", // octal
      "http://127.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://printer/",
      "http://nas.local/",
      "http://wiki.internal/",
      "http://app.localhost/",
    ])
      expect(reason(h), h).toBe("host");
  });

  it("handles empty, malformed and very long input", () => {
    expect(reason("")).toBe("empty");
    expect(reason("   ")).toBe("empty");
    expect(reason("http://")).toBe("invalid");
    expect(reason(`https://example.com/${"a".repeat(2100)}`)).toBe("long");
  });
});

describe("isBlockedHostname", () => {
  it("allows ordinary public names", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("venues.example.co.uk")).toBe(false);
  });
});
