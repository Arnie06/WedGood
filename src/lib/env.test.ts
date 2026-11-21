import { describe, expect, it } from "vitest";
import { EnvValidationError, parsePublicEnv } from "./env";

describe("parsePublicEnv", () => {
  it("defaults to localhost outside production", () => {
    expect(parsePublicEnv({}, "development").appUrl.href).toBe("http://localhost:3000/");
    expect(parsePublicEnv({ NEXT_PUBLIC_APP_URL: "  " }, "test").appUrl.href).toBe(
      "http://localhost:3000/",
    );
  });

  it("uses a configured URL", () => {
    const env = parsePublicEnv({ NEXT_PUBLIC_APP_URL: "https://example.test" }, "production");
    expect(env.appUrl.origin).toBe("https://example.test");
  });

  it("requires the app URL in production", () => {
    expect(() => parsePublicEnv({}, "production")).toThrow(EnvValidationError);
  });

  it("rejects plain http for non-localhost hosts in production", () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_APP_URL: "http://example.test" }, "production"),
    ).toThrow(/https/);
  });

  it("allows http://localhost for a local production build", () => {
    const env = parsePublicEnv({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, "production");
    expect(env.appUrl.hostname).toBe("localhost");
  });

  it("rejects malformed and non-http URLs", () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_APP_URL: "not a url" }, "development")).toThrow(
      EnvValidationError,
    );
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }, "development"),
    ).toThrow(EnvValidationError);
  });

  describe("Supabase variables", () => {
    const key = "sb_publishable_0123456789abcdef";
    const app = { NEXT_PUBLIC_APP_URL: "https://example.test" };

    it("is null when both are unset (honest unconfigured state)", () => {
      expect(parsePublicEnv(app, "production").supabase).toBeNull();
    });

    it("parses a complete pair", () => {
      const env = parsePublicEnv(
        {
          ...app,
          NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.test",
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
        },
        "production",
      );
      expect(env.supabase?.url.hostname).toBe("x.supabase.test");
      expect(env.supabase?.publishableKey).toBe(key);
    });

    it("treats blank values as unset", () => {
      const env = parsePublicEnv(
        { NEXT_PUBLIC_SUPABASE_URL: " ", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" },
        "development",
      );
      expect(env.supabase).toBeNull();
    });

    it("rejects a half-configured pair in either direction", () => {
      expect(() =>
        parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, "development"),
      ).toThrow(/together/);
      expect(() =>
        parsePublicEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }, "development"),
      ).toThrow(/together/);
    });

    it("rejects malformed URLs and implausibly short keys", () => {
      expect(() =>
        parsePublicEnv(
          { NEXT_PUBLIC_SUPABASE_URL: "nope", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key },
          "development",
        ),
      ).toThrow(EnvValidationError);
      expect(() =>
        parsePublicEnv(
          {
            NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "short",
          },
          "development",
        ),
      ).toThrow(EnvValidationError);
    });

    it("requires https for remote hosts in production but allows loopback", () => {
      const base = { ...app, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key };
      expect(() =>
        parsePublicEnv(
          { ...base, NEXT_PUBLIC_SUPABASE_URL: "http://db.example.test" },
          "production",
        ),
      ).toThrow(/https/);
      expect(
        parsePublicEnv(
          { ...base, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
          "production",
        ).supabase,
      ).not.toBeNull();
    });
  });
});
