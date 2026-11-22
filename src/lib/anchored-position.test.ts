import { describe, expect, it } from "vitest";
import { placeCard } from "./anchored-position";

const viewport = { width: 1000, height: 700 };
const card = { width: 280, height: 240 };
const opts = { gap: 10, margin: 8 };

describe("placeCard", () => {
  it("puts the card to the right of the target, centred on it", () => {
    const p = placeCard({ left: 100, top: 300, width: 40, height: 40 }, card, viewport, opts);
    expect(p).toEqual({ side: "right", left: 150, top: 200 });
  });

  it("moves to the left when there is no room on the right", () => {
    const p = placeCard({ left: 900, top: 300, width: 40, height: 40 }, card, viewport, opts);
    expect(p.side).toBe("left");
    expect(p.left).toBe(900 - 10 - 280);
  });

  it("keeps a side placement inside the screen vertically", () => {
    const top = placeCard({ left: 100, top: 0, width: 40, height: 40 }, card, viewport, opts);
    expect(top).toMatchObject({ side: "right", top: 8 });
    const bottom = placeCard({ left: 100, top: 690, width: 40, height: 40 }, card, viewport, opts);
    expect(bottom).toMatchObject({ side: "right", top: 700 - 240 - 8 });
  });

  it("drops below, then above, when neither side has room (a narrow phone)", () => {
    const narrow = { width: 360, height: 700 };
    const below = placeCard({ left: 160, top: 100, width: 40, height: 40 }, card, narrow, opts);
    expect(below.side).toBe("bottom");
    expect(below.top).toBe(150);
    expect(below.left).toBeGreaterThanOrEqual(8);
    expect(below.left + card.width).toBeLessThanOrEqual(360 - 8);
    const above = placeCard({ left: 160, top: 600, width: 40, height: 40 }, card, narrow, opts);
    expect(above.side).toBe("top");
    expect(above.top).toBe(600 - 10 - 240);
  });

  it("never leaves the card off screen, even when the card is bigger than the room", () => {
    const tiny = { width: 320, height: 300 };
    const p = placeCard({ left: 140, top: 130, width: 40, height: 40 }, card, tiny, opts);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left + card.width).toBeLessThanOrEqual(320 - 8);
    expect(p.top + card.height).toBeLessThanOrEqual(300 - 8);
  });

  it("is deterministic", () => {
    const a = { left: 333, top: 222, width: 20, height: 20 };
    expect(placeCard(a, card, viewport)).toEqual(placeCard(a, card, viewport));
  });
});
