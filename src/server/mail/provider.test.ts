import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { selectMailProvider, devSinkMailProvider, unconfiguredMailProvider } =
  await import("./provider");

describe("selectMailProvider", () => {
  it("is unconfigured by default", () => {
    const p = selectMailProvider({
      provider: undefined,
      allowDevSink: undefined,
      production: false,
    });
    expect(p).toBe(unconfiguredMailProvider);
    expect(p.configured).toBe(false);
  });

  it("uses the dev sink in development", () => {
    const p = selectMailProvider({
      provider: " Dev-Sink ",
      allowDevSink: undefined,
      production: false,
    });
    expect(p).toBe(devSinkMailProvider);
    expect(p.captureOnly).toBe(true);
  });

  it("refuses the dev sink in production unless explicitly allowed", () => {
    expect(
      selectMailProvider({ provider: "dev-sink", allowDevSink: undefined, production: true }),
    ).toBe(unconfiguredMailProvider);
    expect(
      selectMailProvider({ provider: "dev-sink", allowDevSink: "yes", production: true }),
    ).toBe(unconfiguredMailProvider);
    expect(
      selectMailProvider({ provider: "dev-sink", allowDevSink: "true", production: true }),
    ).toBe(devSinkMailProvider);
  });

  it("treats unknown providers as unconfigured", () => {
    expect(
      selectMailProvider({ provider: "postmark", allowDevSink: "true", production: false }),
    ).toBe(unconfiguredMailProvider);
  });
});

describe("adapters", () => {
  it("the unconfigured adapter never claims a send", async () => {
    await expect(
      unconfiguredMailProvider.send({
        to: "a@example.test",
        subject: "s",
        text: "t",
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({ status: "unconfigured" });
  });

  it("the dev sink returns a labelled receipt keyed by the idempotency key", async () => {
    await expect(
      devSinkMailProvider.send({
        to: "a@example.test",
        subject: "s",
        text: "t",
        idempotencyKey: "k1",
      }),
    ).resolves.toEqual({ status: "succeeded", providerReceipt: "dev-sink:k1" });
  });
});
