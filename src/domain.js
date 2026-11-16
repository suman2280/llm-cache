/**
 * Domain policy -- the guard the model does not provide.
 *
 * The model card for this fine-tune promises:
 *   "Answers questions about AWS services ... and refuses out-of-scope
 *    questions."
 *   "Out-of-Scope Use: ... It will refuse questions outside the AWS domain by
 *    design."
 *   Evaluation: "Out-of-scope (3 questions) | 0.000 | Refused Correctly 100%"
 *
 * Measured on this build, that promise does not hold. The adapter is 2.5M
 * parameters (0.03%) trained for 17 minutes on 407 Q&A pairs; it learned the
 * AWS *style* but not the refusal:
 *
 *   "What is the boiling point of water in Celsius?"
 *     -> "The boiling point of water in Celsius is 100 degrees."
 *   "Who wrote the play Hamlet?"
 *     -> "Hamlet was written by William Shakespeare."
 *
 * 0 of 6 out-of-scope questions refused. So the behaviour the card advertises
 * has to be enforced by the system that owns the product, not delegated to the
 * model. That is this module.
 *
 * The classifier is a HYBRID, because either signal alone is too weak:
 *
 *   semantic  max cosine similarity to a set of domain exemplars. Catches
 *             paraphrases that avoid jargon ("how do I stop losing my objects
 *             if I delete the bucket?"), but the score floor is low for
 *             legitimate questions that use unusual words.
 *   lexical   presence of domain vocabulary (S3, IAM, subnet, ...). Extremely
 *             reliable when present, and absent from general questions.
 *
 * A request is in-domain if EITHER fires. Measured separation on this corpus:
 * out-of-domain questions score at most 0.125 semantically; in-domain ones at
 * least 0.117 -- so the semantic signal alone overlaps, and the lexical signal
 * is what carries it.
 *
 * The policy belongs to the CORPUS, not to the code: swapping the corpus from
 * AWS to the JEE *Sets* chapter swaps the domain with it, so the same guard
 * keeps working for the real content pipeline.
 */

import { embed } from "./embedder.js";

export const MODES = ["off", "bypass", "strict"];

export class DomainPolicy {
  /**
   * @param {object} spec
   * @param {string} spec.name            domain label, e.g. "aws"
   * @param {string} spec.description     one-line human description
   * @param {string[]} spec.exemplars     texts defining the domain (embedded)
   * @param {string[]} spec.terms         domain vocabulary (lexical signal)
   * @param {string[]} spec.outTerms      vocabulary that is definitely out
   * @param {number} spec.threshold       cosine threshold for the semantic signal
   * @param {string} spec.mode            "off" | "bypass" | "strict"
   */
  constructor(spec) {
    this.name = spec.name;
    this.description = spec.description;
    this.exemplars = spec.exemplars ?? [];
    this.terms = (spec.terms ?? []).map((t) => t.toLowerCase());
    this.outTerms = (spec.outTerms ?? []).map((t) => t.toLowerCase());
    this.threshold = spec.threshold ?? 0.3;
    this.mode = MODES.includes(spec.mode) ? spec.mode : "off";
    this._vectors = null;
  }

  /** Embed the exemplars once, lazily. */
  async _exemplarVectors() {
    if (this._vectors) return this._vectors;
    this._vectors = [];
    for (const e of this.exemplars) {
      this._vectors.push(await embed(e));
    }
    return this._vectors;
  }

  /**
   * @returns {Promise<{inDomain: boolean, semantic: number, lexical: number,
   *                    matched: string[], reason: string}>}
   */
  async classify(text) {
    const lower = String(text || "").toLowerCase();

    // An open policy: no exemplars and no vocabulary => nothing to check.
    if (!this.exemplars.length && !this.terms.length) {
      return {
        inDomain: true, semantic: 0, lexical: 0, matched: [], outMatched: [],
        reason: "no domain restriction",
      };
    }

    // The lexical signal is free and decisive when it fires.
    const matched = this.terms.filter((t) => lower.includes(t));
    const outMatched = this.outTerms.filter((t) => lower.includes(t));
    const lexical = this.terms.length ? matched.length / Math.min(this.terms.length, 3) : 0;

    if (outMatched.length) {
      return {
        inDomain: false, semantic: 0, lexical: 0, matched, outMatched,
        reason: `contains out-of-domain term(s): ${outMatched.join(", ")}`,
      };
    }

    let semantic = 0;
    if (this.exemplars.length) {
      const vecs = await this._exemplarVectors();
      const q = await embed(text);
      for (const v of vecs) {
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += q[i] * v[i];
        if (dot > semantic) semantic = dot;
      }
    }

    const inDomain = matched.length > 0 || semantic >= this.threshold;
    return {
      inDomain,
      semantic: Number(semantic.toFixed(4)),
      lexical: Number(lexical.toFixed(4)),
      matched,
      outMatched,
      reason: inDomain
        ? (matched.length
          ? `domain vocabulary: ${matched.slice(0, 4).join(", ")}`
          : `semantic similarity ${semantic.toFixed(3)} >= ${this.threshold}`)
        : `no domain vocabulary and semantic similarity ${semantic.toFixed(3)} < ${this.threshold}`,
    };
  }

  describe() {
    return {
      name: this.name,
      description: this.description,
      mode: this.mode,
      threshold: this.threshold,
      exemplars: this.exemplars.length,
      terms: this.terms.length,
    };
  }
}

/**
 * A policy that never restricts anything. Used when the mode is "off", so the
 * rest of the code path is identical.
 */
export const OPEN_POLICY = new DomainPolicy({
  name: "open",
  description: "no domain restriction",
  exemplars: [],
  terms: [],
  threshold: 2,
  mode: "off",
});
