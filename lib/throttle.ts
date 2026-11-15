// A small in-memory request throttle.
//
// One copy lives inside each running copy of the server, so this is a speed bump against a
// script hammering the site, not an exact limit. The exact limits (daily audits, per-visitor,
// monthly search credits) are enforced atomically in Redis: see lib/quota.
// Its job is to stop refused requests from eating the free Redis command allowance.

const hits = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 5000;

export function allowRequest(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [other, times] of hits) {
      if (times.every((time) => now - time >= windowMs)) hits.delete(other);
    }
    // Still too many distinct callers inside one window: start again rather than grow without end.
    if (hits.size > MAX_TRACKED_KEYS) hits.clear();
  }
  return true;
}

export function resetThrottle(): void {
  hits.clear();
}
