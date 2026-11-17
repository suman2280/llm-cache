/**
 * Per-client token bucket for expensive inferences.
 *
 * #14: a cache hit is cheap, but a miss occupies the single model slot for
 * 6-20s. Without a limit, a burst of unique questions can monopolise the
 * model. The bucket is in-process and per client address; a multi-instance
 * deployment would need Redis for shared state.
 */
export class TokenBucket {
  constructor({ capacity = 20, refillMs = 60_000 } = {}) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.buckets = new Map();
  }

  allow(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, now - b.last);
    b.tokens = Math.min(this.capacity,
      b.tokens + Math.floor((elapsed * this.capacity) / this.refillMs));
    b.last = now;
    if (b.tokens < 1) return { allowed: false, remaining: 0 };
    b.tokens -= 1;
    return { allowed: true, remaining: b.tokens };
  }

  reset() { this.buckets.clear(); }
}

/** Shared limiter for inference, configured at startup. */
export const inferenceLimiter = new TokenBucket();

export function configureLimiter(capacity, refillMs = 60_000) {
  inferenceLimiter.capacity = Math.max(1, capacity);
  inferenceLimiter.refillMs = refillMs;
  inferenceLimiter.reset();
}
