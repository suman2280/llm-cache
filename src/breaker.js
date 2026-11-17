/**
 * A small circuit breaker for the Redis-backed semantic tier.
 *
 * R-6: when the store fails repeatedly, stop trying it on every request.
 * Open the circuit, fail over to inference for `cooldownMs`, then try once
 * again (half-open) and close it on the first success.
 */
export class Breaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = 0;
  }

  get state() {
    if (!this.openedAt) return "closed";
    if (Date.now() - this.openedAt >= this.cooldownMs) return "half-open";
    return "open";
  }

  // #59: half-open must reserve ONE probe. A burst after cooldown all
  // hit the store and re-opened the circuit immediately.
  _probing = false;
  allow() {
    const st = this.state;
    if (st === "closed") return true;
    if (st === "half-open") {
      if (this._probing) return false;
      this._probing = true;
      return true;
    }
    return false;
  }
  success() {
    this._probing = false;
    this.failures = 0;
    this.openedAt = 0;
  }
  failure() {
    this._probing = false;
    // A failed probe reopens the circuit immediately; do not let the next
    // caller retry against a still-failing store.
    if (this.openedAt && Date.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = Date.now();
      this.failures = this.threshold;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }

  describe() {
    return { state: this.state, failures: this.failures, cooldown_ms: this.cooldownMs };
  }
}

/** The semantic tier's store breaker. */
export const storeBreaker = new Breaker();
