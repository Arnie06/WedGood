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
});
