/**
 * Lexical grounding for the semantic tier.
 *
 * Why this exists: a cosine distance is not a correctness criterion. Measured
 * on the running system:
 *
 *   "redis aws"  vs  "What is AWS?"                  d = 0.349  (inside a 0.35 radius)
 *   "What is AWS?" vs "What are virtual machines?"   d = 0.614
 *
 * The first is a hit that must not happen: the cached answer was about AWS in
 * general, not about Redis. Short queries collapse together in embedding
 * space because one dominant word ("aws") carries the whole vector.
 *
 * The guard: a semantic hit requires the query's *specific* content words to
 * appear in the candidate's prompt or answer. Common English words and
 * domain-generic words ("aws", "cloud", "service", "difference") are excluded,
 * because those are exactly the words a rewording is allowed to change --
 * while "redis", "lifecycle", "glacier" are not.
 *
 * Calibration on 10 labelled pairs (5 must-hit, 5 must-miss): 10/10 correct,
 * with the must-hit cases sharing >= 1 specific term and every must-miss case
 * sharing none. Distance alone cannot separate them: the closest must-hit is
 * 0.031 and the farthest must-miss is 0.831, but the must-miss pair at 0.349
 * sits inside the radius.
 */

/** English function words. Never topical, so never required to match. */
const STOPWORDS = new Set(`a an the and or but if then than that this these those is are was were be been being am do does did doing have has had having i you he she it we they me him her us them my your his its our their of in on at to for with from by as into about over after before between during without within above below up down out off again further once here there when where why how all any both each few more most other some such no nor not only own same so too very can will just should now what which who whom
let lets get gets getting go goes going make makes making use uses used using
way ways thing things stuff kind sort type types
differ differs difference differences compare compares comparison comparing versus vs
explain explains explanation describe describes telling tell overview summarize summarises
means mean meaning`.split(/\s+/));

/**
 * Words that are topical only in the loosest sense. They appear in almost
 * every question about the domain, so they cannot satisfy the overlap rule on
 * their own -- otherwise "redis aws" would match "What is AWS?" on "aws".
 */
const GENERIC = new Set(`aws amazon amazon web services cloud clouds service services question questions difference differences explain explanation what how why resource resources platform platforms computing technology software server servers data system systems world web internet enterprise company organisation organization`.split(/\s+/));

/** Content words of a text: lowercased, stopwords and generic words removed. */
export function specificTerms(text) {
  const out = new Set();
  for (const t of String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []) {
    if (t.length <= 1) continue;
    if (STOPWORDS.has(t)) continue;
    if (GENERIC.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Content words, keeping the generic ones. Used to explain a rejection. */
export function contentTerms(text) {
  const out = new Set();
  for (const t of String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []) {
    if (t.length <= 1) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Light stemmer. It has to be CONSISTENT: "machines" and "machine" must land
 * on the same stem, or a legitimate rewording looks like a different
 * question. ("machines" -> "machin" and "machine" -> "machine" was a real
 * bug: it cost the cache a legitimate hit.)
 */
export function stem(word) {
  let s = word.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
  if (s.length > 5 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Stemmed specific terms. */
export function stemmedTerms(text) {
  return new Set([...specificTerms(text)].map(stem));
}

/**
 * Coverage-based acceptance for a semantic hit.
 *
 * The question this answers: two questions are the same when they ground in
 * the SAME knowledge-base chunk AND the candidate actually covers what was
 * asked. The chunk is the precise signal -- a curated, human-written unit --
 * where the embedding is a noisy one. Measured:
 *
 *   "What are virtual machines?"  and  "What is EC2?"
 *     embedding distance 0.792  (OUTSIDE any sane radius)
 *     but both ground in the chunk "ec2-instances"
 *
 * The embedding says they are unrelated. They are the same question.
 *
 * @param {string} query
 * @param {string} candPrompt
 * @param {string} candAnswer
 * @param {boolean} chunkOverlap  do the query and the candidate share a KB chunk?
 * @param {number} threshold     minimum coverage of the query's specific terms
 */
export function coverageVerdict(query, candPrompt, candAnswer, chunkOverlap, threshold = 0.75) {
  // A question made entirely of generic words ("tell me about AWS", "what is
  // EC2?") has no specific terms: the framing verbs are stopwords and the
  // domain name itself is generic. Fall back to content words so such a
  // question is still cacheable instead of scoring 0 and being rejected.
  const useGeneric = stemmedTerms(query).size === 0;
  const termFn = useGeneric
    ? (text) => new Set([...contentTerms(text)].map(stem))
    : stemmedTerms;
  const q = termFn(query);
  const c = new Set([...termFn(candPrompt), ...termFn(candAnswer)]);
  const matched = [...q].filter((t) => c.has(t));
  const unmatched = [...q].filter((t) => !c.has(t));
  const coverage = q.size ? matched.length / q.size : 0;

  const reason = unmatched.length === 0
    ? `covers every specific term (${matched.join(", ")})`
    : `covers ${matched.length}/${q.size} specific terms (missing: ${unmatched.join(", ")})`;

  if (!chunkOverlap) {
    return {
      ok: false, matched, unmatched, coverage: Number(coverage.toFixed(4)),
      reason: `different source material (no shared knowledge-base chunk); ${reason}`,
    };
  }
  if (coverage < threshold) {
    return {
      ok: false, matched, unmatched, coverage: Number(coverage.toFixed(4)),
      reason: `same source material but the candidate ${reason}`,
    };
  }
  return {
    ok: true, matched, unmatched, coverage: Number(coverage.toFixed(4)),
    reason: `same source material and the candidate ${reason}`,
  };
}

/**
 * Decide whether a candidate may be served for a query.
 *
 * @param {string} query            the incoming request text
 * @param {string} candPrompt       the cached entry's prompt
 * @param {string} candAnswer       the cached entry's answer
 * @param {number} distance         cosine distance between the two
 * @param {object} [opts]
 * @param {number} [opts.minShared=2]   specific terms that must be shared
 * @param {number} [opts.closeDist=0.15] a single shared term is enough this close
 * @returns {{ok: boolean, shared: string[], missing: string[], reason: string}}
 */
export function overlapVerdict(query, candPrompt, candAnswer, distance, opts = {}) {
  const minShared = opts.minShared ?? 2;
  const closeDist = opts.closeDist ?? 0.15;

  // If the query is made entirely of generic words ("What is AWS?"), there is
  // nothing specific to demand -- fall back to the generic words so such a
  // query is not permanently un-cacheable.
  const useGeneric = specificTerms(query).size === 0;
  const termFn = useGeneric ? contentTerms : specificTerms;

  const qt = termFn(query);
  const ct = new Set([...termFn(candPrompt), ...termFn(candAnswer)]);
  const shared = [...qt].filter((t) => ct.has(t));
  const missing = [...qt].filter((t) => !ct.has(t));

  if (shared.length >= minShared) {
    return {
      ok: true, shared, missing,
      reason: `shares ${shared.length} specific term(s) with the candidate: ${shared.slice(0, 5).join(", ")}`,
    };
  }
  if (shared.length === 1 && distance <= closeDist) {
    return {
      ok: true, shared, missing,
      reason: `shares "${shared[0]}" and is very close (d=${Number(distance).toFixed(3)})`,
    };
  }
  if (shared.length === 0) {
    return {
      ok: false, shared, missing,
      reason: missing.length
        ? `shares no specific term with the candidate (query asks about: ${missing.slice(0, 5).join(", ")})`
        : "query has no specific terms to compare",
    };
  }
  return {
    ok: false, shared, missing,
    reason: `shares only ${shared.join(", ")} and is not close enough (d=${Number(distance).toFixed(3)})`,
  };
}
