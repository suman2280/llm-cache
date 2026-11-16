/**
 * Degenerate-output detection.
 *
 * A 7B on a CPU will occasionally fall into a repetition loop and emit the
 * same line over and over. Observed on the running system:
 *
 *   Q: "s3 HTTPS encription"
 *   - HTTPS in transit is separate from encryption at rest for S3 objects.
 *   - HTTPS is enabled by default for S3 buckets.
 *   ... seven good bullets ...
 *   - HTTPS can be used to secure access to S3 objects and buckets from the
 *     internet or within a VPC.        <- repeated 15 times, to the token limit
 *
 * Two things make this much worse than a bad answer:
 *
 *   1. the answer is truncated mid-sentence, and
 *   2. if it is cached, it is served to every future request for that
 *      question, and the "semantic" hits around it inherit the garbage.
 *
 * So a degenerate answer must NEVER be cached, and the generation must be
 * retried with different sampling before it is accepted.
 */

/**
 * @param {string} text
 * @returns {{degenerate: boolean, reason: string|null, metric: number}}
 */
export function detectDegeneracy(text) {
  const body = String(text ?? "");
  if (body.length < 200) return { degenerate: false, reason: null, metric: 0 };

  // 1. duplicated lines -- the shape the loop above produced
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 25);
  if (lines.length >= 4) {
    const counts = new Map();
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
    let worst = null;
    for (const [line, n] of counts) if (!worst || n > worst[1]) worst = [line, n];
    if (worst && worst[1] >= 3) {
      return {
        degenerate: true, metric: worst[1],
        reason: `the same line appears ${worst[1]} times: "${worst[0].slice(0, 70)}..."`,
      };
    }
  }

  // 2. a repeated n-gram, which catches loops that vary the line slightly
  const words = body.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length >= 40) {
    const n = 8;
    const grams = new Map();
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n).join(" ");
      grams.set(g, (grams.get(g) || 0) + 1);
    }
    let worst = null;
    for (const [g, c] of grams) if (!worst || c > worst[1]) worst = [g, c];
    if (worst && worst[1] >= 4) {
      return {
        degenerate: true, metric: worst[1],
        reason: `an ${n}-gram repeats ${worst[1]} times: "${worst[0].slice(0, 70)}..."`,
      };
    }
  }

  // 3. a truncated final line -- the loop ran into the token limit
  const trimmed = body.trimEnd();
  if (trimmed.length > 80 && !/[.!?:;)\]}">`]$/.test(trimmed)) {
    return {
      degenerate: true, metric: 1,
      reason: `the answer ends mid-sentence: "...${trimmed.slice(-60)}"`,
    };
  }

  return { degenerate: false, reason: null, metric: 0 };
}
