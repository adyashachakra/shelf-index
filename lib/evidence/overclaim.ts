// A wording screen, and only that. The model is told not to state causes, not to generalise
// from a few reports, and not to promise business outcomes. It will not always obey, so the
// sentences it writes about complaints, implications and recommendations pass through here,
// and text matching a known overclaiming phrasing is replaced by a plain statement.
//
// What this is NOT: a detector of every unsupported causal claim. It is a list of words and
// phrases. A cause worded in a way the list does not know ("X is behind Y", "thanks to X")
// passes, and the attribution test below is a word match that a sentence can satisfy without
// truly attributing anything. The report says so in its stated limits. The audit measures no
// sales, conversion, loyalty or trust, and a handful of customer reports cannot establish a
// cause or a brand-wide problem; this screen reduces how often the text suggests otherwise.

const CAUSE = /\b(caus(e|es|ed|ing)|lead(s|ing)? to|led to|result(s|ed|ing)? in|trigger(s|ed|ing)?|responsible for|proves?|proof (that|of))\b/i;
const OUTCOME =
  /\b(sales|conversions?|revenue|market share|loyalty|trust|customer retention|churn|customer satisfaction|purchase intent|profit\w*|ROI|backlash|reputation(al)? damage)\b/i;
const GENERALISED =
  /\b(widespread|brand-wide|across the board|systemic|all customers|every customer|safety (issue|problem|concern|risk)s?|unsafe|dangerous|harmful|(product|reformulation|formula) failure)\b/i;

// A cause is acceptable only as something customers themselves say: "two customers say the new
// formula caused irritation" reports their view, while "the new formula caused irritation" asserts it.
const ATTRIBUTED =
  /\b(say|says|said|report|reports|reported|reporting|attribute|attributes|attributed|blame|blames|blamed|believe|believes|believed|claim|claims|claimed|complain|complains|complained|describe|describes|described|suspect|suspects|suspected|think|thinks|feel|feels|felt|mention|mentions|mentioned|according to)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * True when any sentence promises a business outcome, generalises beyond the sample, or states
 * a cause in the report's own voice (a cause attributed to the customers who said it is allowed).
 */
export function overclaims(text: string): boolean {
  return sentencesOf(text).some((sentence) => {
    if (OUTCOME.test(sentence) || GENERALISED.test(sentence)) return true;
    return CAUSE.test(sentence) && !ATTRIBUTED.test(sentence);
  });
}

export const NEUTRAL_HYPOTHESIS =
  'If this is done, a later audit could show whether the evidence cited here changes. This audit cannot say that it will.';

/**
 * An expected result is only ever shown as a hypothesis. It must read as one ("If ...") and
 * must not overclaim; anything else is replaced by a neutral statement.
 */
export function asHypothesis(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '' || overclaims(trimmed) || !/^if\b/i.test(trimmed)) return NEUTRAL_HYPOTHESIS;
  return trimmed;
}

/** Keep a sentence only if it does not overclaim; otherwise use the plain fallback. */
export function withoutOverclaim(text: string, fallback: string): string {
  return overclaims(text) ? fallback : text;
}
