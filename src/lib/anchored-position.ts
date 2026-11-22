/**
 * Where a small card goes so it sits right next to the thing that was tapped. Pure: boxes in, a
 * position out, all in the same viewport pixels. Prefers beside the target (right, then left), then
 * below, then above, and takes the first side where the whole card fits. When no side has room (a phone
 * at 320px, a card taller than the screen) it takes the side with the most space and is kept inside the
 * viewport, so its buttons are never off screen.
 */
export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export type CardSide = "right" | "left" | "bottom" | "top";
export type CardPlacement = { left: number; top: number; side: CardSide };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));

export function placeCard(
  anchor: Box,
  card: Size,
  viewport: Size,
  { gap = 10, margin = 8 }: { gap?: number; margin?: number } = {},
): CardPlacement {
  const maxLeft = Math.max(margin, viewport.width - card.width - margin);
  const maxTop = Math.max(margin, viewport.height - card.height - margin);
  const midX = anchor.left + anchor.width / 2 - card.width / 2;
  const midY = anchor.top + anchor.height / 2 - card.height / 2;

  const room = {
    right: viewport.width - margin - (anchor.left + anchor.width + gap),
    left: anchor.left - gap - margin,
    bottom: viewport.height - margin - (anchor.top + anchor.height + gap),
    top: anchor.top - gap - margin,
  };
  const need = {
    right: card.width,
    left: card.width,
    bottom: card.height,
    top: card.height,
  };
  const at = (side: CardSide): CardPlacement => {
    switch (side) {
      case "right":
        return {
          side,
          left: anchor.left + anchor.width + gap,
          top: clamp(midY, margin, maxTop),
        };
      case "left":
        return { side, left: anchor.left - gap - card.width, top: clamp(midY, margin, maxTop) };
      case "bottom":
        return { side, left: clamp(midX, margin, maxLeft), top: anchor.top + anchor.height + gap };
      case "top":
        return { side, left: clamp(midX, margin, maxLeft), top: anchor.top - gap - card.height };
    }
  };

  const order: CardSide[] = ["right", "left", "bottom", "top"];
  const fits = order.find((side) => room[side] >= need[side]);
  if (fits) return at(fits);

  // Nothing fits whole: use the roomiest side and pull the card back onto the screen.
  const best = order.reduce((a, b) => (room[b] > room[a] ? b : a));
  const p = at(best);
  return {
    side: best,
    left: clamp(p.left, margin, maxLeft),
    top: clamp(p.top, margin, maxTop),
  };
}
