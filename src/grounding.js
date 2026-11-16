/**
 * Grounding check for GENERATED answers.
 *
 * The cache has a lexical-grounding rule for hits (src/lexicon.js): a cached
 * answer may only be served if the query's specific words appear in it. This
 * is the same rule applied to the other direction -- an answer the model has
 * just produced must be grounded in the reference material it was given.
 *
 * It exists because asking a small model for MORE makes it fabricate:
 *
 *   "aws", asked for six to nine bullets, produced
 *     "AWS offers an EC2 instance type called 't2.micro' which is free-tier
 *      eligible ... billed at a rate of $0.0000002 per second"
 *
 * None of that is in the reference material. It reads well. It is false. And
 * the SOP's core principle -- "No derived content is approved only because an
 * AI generated it" -- is exactly the rule this enforces in code.
 *
 * Measured separation (the fraction of an answer's specific terms that appear
 * in the reference material it was given):
 *
 *   a grounded answer                    0.667
 *   a fabricated answer                  0.172
 *
 * so the threshold sits at 0.45, with the grounded case 0.2 clear of it and
 * the fabricated case 0.28 below.
 */

import { specificTerms } from "./lexicon.js";

/** Default threshold. Tuned on the measured separation above. */
export const GROUNDING_THRESHOLD = 0.45;

/**
 * The words that betray a fabrication: SPECIFIC identifiers and numbers.
 *
 * Measuring every content word does not work, because the instruction itself
 * asks for "the console path or API action" -- words that will never appear
 * verbatim in the reference, so a perfectly grounded answer looks ungrounded.
 *
 * What distinguishes a fabrication is a *specific* that is not in the source:
 *   "t2.micro", "RunInstances", "$0.0000002", "CreateFlowLogs"
 * versus
 *   "the console path or API action", "the AWS Management Console"
 *
 * So the check counts only identifiers that look like a NAME:
 *   multi-word CamelCase   RunInstances, PutBucketVersioning, CreateFlowLogs
 *   dotted                 t2.micro, s3:GetObject, ec2.amazonaws.com
 *   decimals / money       0.0000002, $0.0000002
 *   service acronyms       S3, EC2, IAM, KMS  (but not API, CLI, SDK, ...)
 *
 * Single-CamelCase words ("Console", "Management", "Watch") are ordinary prose and are
 * deliberately NOT counted.
 */
const GENERIC_ACRONYMS = new Set([
  "api", "cli", "sdk", "json", "yaml", "http", "https", "tls", "ssl",
  "cpu", "ram", "os", "dns", "ip", "url", "uri", "ui", "sla", "faq",
  "vm", "id", "ids", "acl", "io",
]);

export function specificIdentifiers(text) {
  const out = new Set();
  const body = String(text ?? "");

  // multi-word CamelCase: an uppercase letter AFTER the first character.
  // "RunInstances", "PutBucketVersioning", "CreateFlowLogs" -> yes.
  // "Console", "Management", "Watch" -> no: only the first letter is capital.
  for (const m of body.matchAll(/\b[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    if (GENERIC_ACRONYMS.has(m[0].toLowerCase())) continue;
    out.add(`c:${m[0]}`);
  }
  // dotted names: t2.micro, s3:GetObject, ec2.amazonaws.com
  for (const m of body.matchAll(/\b[a-z][a-z0-9]*(?:\.[a-zA-Z0-9_-]+)+\b/g)) out.add(`d:${m[0]}`);
  // decimals and money: 0.0000002, $0.0000002
  for (const m of body.matchAll(/\$?\d+\.\d+/g)) out.add(`n:${m[0]}`);
  // service acronyms: S3, EC2, IAM, KMS -- but not API, CLI, SDK
  for (const m of body.matchAll(/\b[A-Z]{2,}[A-Z0-9]*\b/g)) {
    if (m[0].length < 2) continue;
    if (GENERIC_ACRONYMS.has(m[0].toLowerCase())) continue;
    out.add(`a:${m[0]}`);
  }
  return out;
}

/** The set of terms the reference material contains. */
export function referenceTerms(chunks) {
  const set = new Set();
  for (const c of chunks ?? []) {
    for (const t of specificTerms(`${c.title ?? ""} ${c.text ?? ""}`)) set.add(t);
  }
  return set;
}

/** The set of identifiers the reference material contains. */
export function referenceIdentifiers(chunks) {
  const set = new Set();
  for (const c of chunks ?? []) {
    for (const t of specificIdentifiers(`${c.title ?? ""} ${c.text ?? ""}`)) set.add(t);
  }
  return set;
}

/**
 * @param {string} answer
 * @param {Set<string>} refTerms
 * @param {Set<string>} refIds
 * @returns {{ratio: number, novel: string[], total: number, grounded: boolean}}
 */
export function checkGrounding(answer, refTerms, refIds, threshold = GROUNDING_THRESHOLD) {
  // The "Key points:" heading is ours, not the model's content.
  const text = String(answer ?? "").replace(/^\s*Key points:\s*/i, "");

  // 1. the specific identifiers must be in the source
  const ids = [...specificIdentifiers(text)];
  const novelIds = refIds ? ids.filter((t) => !refIds.has(t)) : [];
  const idRatio = ids.length ? (ids.length - novelIds.length) / ids.length : 1;

  // 2. and the content words must mostly be in the source
  const terms = [...specificTerms(text)];
  const novelTerms = terms.filter((t) => !refTerms.has(t));
  const termRatio = terms.length ? (terms.length - novelTerms.length) / terms.length : 1;

  // The identifier signal is the precise one; the term signal is the broad
  // one. A fabricated answer fails the first; a merely reworded answer passes.
  const ratio = ids.length ? idRatio : termRatio;
  const novel = novelIds.length ? novelIds : novelTerms;

  return {
    ratio: Number(ratio.toFixed(4)),
    // the two signals kept apart: novelIdentifiers are the evidence of
    // fabrication, novelTerms are only ordinary rewording
    novelIdentifiers: novelIds,
    novelTerms,
    novel,
    total: ids.length || terms.length,
    grounded: ratio >= threshold && (novelIds.length === 0 || idRatio >= 0.85),
  };
}
