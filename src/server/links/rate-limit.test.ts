import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit per window, per key, then recovers", () => {
    let t = 0;
    const limiter = createRateLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => limiter.take("a"))).toEqual([true, true, true]);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    t = 999;
    expect(limiter.take("a")).toBe(false);
    t = 1001;
    expect(limiter.take("a")).toBe(true);
  });

  it("does not count refused attempts against the window", () => {
    let t = 0;
    const limiter = createRateLimiter(1, 1000, () => t);
    expect(limiter.take("a")).toBe(true);
    t = 500;
    expect(limiter.take("a")).toBe(false);
    t = 1001;
    expect(limiter.take("a")).toBe(true);
  });
});
