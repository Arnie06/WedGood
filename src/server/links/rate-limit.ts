/**
 * Sliding-window limiter for link lookups: `limit` per `windowMs` per key. In memory, so
 * it is per server instance and resets on restart (a known limitation in ADR-029).
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Records an attempt and returns whether it is allowed. */
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      // Keep the map from growing without bound.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.every((at) => t - at >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

export const lookupLimiter = createRateLimiter(10, 60_000);
