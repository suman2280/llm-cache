/**
 * Multi-intent detection.
 *
 * A user can put several questions in one message:
 *
 *   "tell me about AWS\n tell me about EC2"   (newline)
 *   "What is AWS? What is EC2?"               (question marks)
 *   "tell me about AWS and EC2"               (coordinated topics)
 *
 * The cache used to treat those as ONE question, embed it, find the nearest
 * single answer and serve it -- silently dropping the other half. Two topics
 * deserve two answers, resolved from the cache independently and composed.
 */

/**
 * A comparison is ONE question, even though it contains "and":
 * "what is the difference between a security group and a network ACL".
 * Splitting it would produce two half-questions with no answer.
 */
const COMPARISON = /\b(difference|differ|different|compare|compared|comparison|versus|\bvs\b|together|both|which is better|trade.?off)\b/i;

/**
 * Phrases that introduce a bare topic list. Only those are safe to
 * distribute over a conjunction: "tell me about AWS and EC2" ->
 * "tell me about AWS", "tell me about EC2".
 */
const TOPIC_PREFIX = /^(tell me (?:more )?about|tell me|what is|what are|explain|describe|give me (?:an? )?(?:overview|summary) of|overview of|info(?:rmation)? on|about)\s+/i;

/** Short noun phrases are topics; long clauses are not. */
const isTopic = (s) => {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 5 && /[a-z0-9]/i.test(s);
};

/**
 * Split "tell me about AWS and EC2" into two questions by distributing the
 * topic-introducing prefix over each coordinated item. Returns null when the
 * sentence is a comparison or the items are too clause-like to be safe.
 */
function splitCoordinated(text) {
  if (COMPARISON.test(text)) return null;
  const m = text.match(TOPIC_PREFIX);
  if (!m) return null;

  const prefix = m[0];
  const rest = text.slice(prefix.length).trim();
  // commas and a single "and" both join a topic list
  const items = rest.split(/\s*(?:,|and)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (items.length < 2 || items.length > 5) return null;
  if (!items.every(isTopic)) return null;

  return items.map((item) => `${prefix}${item}`);
}

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

  const base = parts.length ? parts : [body];
  const out = [];
  for (const part of base) {
    const coordinated = splitCoordinated(part);
    if (coordinated) out.push(...coordinated);
    else out.push(part);
  }
  return out.length ? out : [body];
}

/** Is this message asking more than one thing? */
export const isMultiIntent = (text) => splitIntents(text).length > 1;
