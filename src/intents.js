/**
 * Multi-intent detection.
 *
 * A user can put several questions in one message:
 *
 *   "tell me about AWS
 *    tell me about EC2"
 *
 * The cache used to treat that as ONE question, embed it, find the nearest
 * single answer ("tell me about EC2") and serve it -- silently dropping the
 * AWS half. The query's only specific term was "ec2" ("aws" is domain-generic
 * and excluded), so even the verifier accepted it.
 *
 * Two questions deserve two answers. This module splits them so each intent
 * can be resolved against the cache independently and the answers composed.
 */

/**
 * @param {string} text
 * @returns {string[]} the separate intents, or a single entry for one question
 */
export function splitIntents(text) {
  const body = String(text ?? "").trim();
  if (!body) return [];

  // A newline is the common case (paste two questions on two lines). A "?"
  // followed by whitespace starts a new question too ("What is AWS? What is
  // EC2?"). The lookbehind keeps the "?" attached to the first question.
  const parts = body
    .split(/\n+|(?<=\?)\s+(?=[A-Za-z])/)
    .map((s) => s.trim().replace(/[?.!]+$/, "").trim())
    .filter((s) => s.length >= 8);

  return parts.length ? parts : [body];
}

/** Is this message asking more than one thing? */
export const isMultiIntent = (text) => splitIntents(text).length > 1;
