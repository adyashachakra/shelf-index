// Is the page evidence about what the question asks? Applied to every content-gap verdict
// before it is accepted.
//
// A verdict of "clear" or "partial" must come with a quote that was found on the page. This
// check then asks whether the quote is about the product or category the item concerns:
//
//   direct          the same product as the item asks about
//   brand_wide      a fact about the whole brand (for example "every formula is fragrance-free")
//   indirect        related, but incomplete: the verdict is capped at "touched on"
//   different       a different product: the item is NOT addressed, however good the quote
//   uncertain       the link cannot be confirmed: left out of the content gap score, with a warning
//
// What the code can check, it checks: whether the product the model says the quote is about
// appears in the words quoted (or the page title), and whether a short word list of common
// product types puts the item and the quote in different groups. The word list is NOT
// comprehensive. Where it knows nothing, the model's own statement of how the evidence relates
// to the question is used, and a missing or unclear statement counts as uncertain.
// Nothing here changes a scoring formula. A verdict about a different product takes the level
// "none"; an uncertain one is left out of the score (see isLeftOut).

import type { CoverageLevel, EvidenceClass, EvidenceRelevance, ExpertEvidence } from '../types';

export type Relation = 'same_product' | 'brand_wide' | 'related' | 'different' | 'unknown';

export interface RelevanceInput {
  /** The shopper question or customer concern, in words. */
  itemText: string;
  /** The level the analysis gave (clear or partial). */
  level: CoverageLevel;
  relation: Relation;
  /** What the model says the item asks about (a product, a category, or "any"). */
  asksAbout: string;
  /** What the model says the quote is about (a product, a category, or "brand-wide"). */
  quoteAbout: string;
  /** The words quoted from the page. Empty when the quote could not be verified. */
  quote: string;
  pageTitle: string;
}

export interface RelevanceOutcome {
  level: CoverageLevel;
  relevance: EvidenceRelevance;
  evidenceAbout?: string;
  note?: string;
}

// Common product types, grouped. Used only to notice an obvious mismatch such as a lotion
// quote offered for a cleanser question. Products not listed here are never judged by this list.
const GROUPS: [string, RegExp][] = [
  ['cleanser', /\b(cleansers?|cleansing|face ?wash(es)?|facial wash|body wash|micellar)\b/i],
  ['moisturizer', /\b(moisturi[sz]ers?|moisturi[sz]ing|lotions?|creams?|emollients?|hydrators?|body butter)\b/i],
  ['sunscreen', /\b(sunscreens?|sunblock|spf|sun protection)\b/i],
  ['serum', /\b(serums?|ampoules?)\b/i],
  ['toner', /\b(toners?|essence)\b/i],
  ['mask', /\b(face masks?|masks?|masques?)\b/i],
  ['shampoo', /\bshampoos?\b/i],
  ['conditioner', /\bconditioners?\b/i],
  ['deodorant', /\b(deodorants?|antiperspirants?)\b/i],
  ['makeup', /\b(foundation|lipstick|mascara|concealer|eyeliner|blush)\b/i],
  ['cookware', /\b(skillets?|frying pans?|saucepans?|dutch ovens?|stockpots?|bakeware|cookware)\b/i],
  ['knives', /\b(knife|knives)\b/i],
  ['jeans', /\b(jeans|denim)\b/i],
  ['shirts', /\b(shirts?|tees?|t-shirts?|tops?)\b/i],
  ['outerwear', /\b(jackets?|coats?|parkas?)\b/i],
  ['footwear', /\b(shoes?|sneakers?|boots?|sandals?)\b/i],
  ['coffee', /\b(coffee|espresso)\b/i],
  ['tea', /\b(teas?|matcha)\b/i],
  ['juice', /\b(juices?|smoothies?)\b/i],
];

/** The product groups a piece of text names, in a fixed order. */
export function productGroupsIn(text: string): string[] {
  return GROUPS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function stem(word: string): string {
  return word.toLowerCase().replace(/(es|s)$/, '');
}

/** Does the product the model says the quote is about actually appear in the quote or the page title? */
function termAppears(quoteAbout: string, quote: string, pageTitle: string): boolean {
  const terms = quoteAbout
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .map(stem);
  if (terms.length === 0) return false;
  const haystack = `${quote} ${pageTitle}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

const BRAND_WIDE_WORDS = /^(brand[- ]?wide|whole brand|entire brand|all products|the brand|any|general)$/i;

export function assessRelevance(input: RelevanceInput): RelevanceOutcome {
  const askGroups = productGroupsIn(`${input.itemText} ${input.asksAbout}`);
  const quoteGroups = input.quote !== '' ? productGroupsIn(input.quote) : [];
  const clash = askGroups.length > 0 && quoteGroups.length > 0 && !quoteGroups.some((g) => askGroups.includes(g));
  const about = (input.quoteAbout.trim() !== '' && !BRAND_WIDE_WORDS.test(input.quoteAbout.trim()) ? input.quoteAbout.trim() : quoteGroups.join(' and ')) || undefined;

  const different = (): RelevanceOutcome => ({
    level: 'none',
    relevance: 'different_product',
    ...(about ? { evidenceAbout: about } : {}),
    note: `The page evidence is about ${about ?? 'a different product'}, not what this item asks about, so it does not count as an answer.`,
  });
  const uncertain = (why: string): RelevanceOutcome => ({ level: 'none', relevance: 'uncertain', note: why });

  if (input.relation === 'different') return different();
  if (clash) {
    // A "brand-wide" claim whose words are only about one other product cannot be trusted either way.
    return input.relation === 'brand_wide'
      ? uncertain(`The evidence was described as about the whole brand, but the words quoted are only about ${quoteGroups.join(' and ')}.`)
      : different();
  }
  if (input.relation === 'unknown') {
    return uncertain('The analysis did not say how this evidence relates to the question, so it could not be confirmed.');
  }
  if (input.relation === 'brand_wide') return { level: input.level, relevance: 'brand_wide' };
  if (input.relation === 'related') return { level: 'partial', relevance: 'indirect', note: 'The evidence concerns a related product or a related point, not a direct answer.' };

  // same_product: the product the model names has to be in the words it quoted (or the page title),
  // or the quote has to name the product the item asks about.
  const overlaps = askGroups.length > 0 && quoteGroups.some((g) => askGroups.includes(g));
  if (overlaps || (input.quoteAbout.trim() !== '' && termAppears(input.quoteAbout, input.quote, input.pageTitle))) {
    return { level: input.level, relevance: 'direct' };
  }
  return uncertain('The product the evidence is said to be about does not appear in the words quoted, so the match could not be confirmed.');
}

/**
 * A checklist item that could not be assessed: the evidence could not be tied to the question, or
 * the analysis returned no verdict for it. Such an item is LEFT OUT of the content gap score, not
 * counted as "not addressed": a missing or incomplete model answer does not show that the site
 * fails to address the question.
 */
export function isLeftOut(item: { relevance?: EvidenceRelevance; unanswered?: boolean }): boolean {
  return item.relevance === 'uncertain' || item.unanswered === true;
}

/** What a reader is shown for a checklist item. Reports saved before the check carry no relevance field and are read by level. */
export function evidenceClass(item: { level: CoverageLevel; relevance?: EvidenceRelevance; unanswered?: boolean }): EvidenceClass {
  if (isLeftOut(item)) return 'uncertain';
  if (item.level === 'clear') return 'clear';
  if (item.level === 'partial') return 'touched_on';
  return 'not_addressed';
}

// ---------------------------------------------------------------------------------------------
// Questions about what EXPERTS recommend ("Which brands do dermatologists recommend most?").
//
// Three different things can appear on a brand's pages, and only the last two answer such a question:
//   collaboration   experts helped make or test the products ("we partnered with dermatologists",
//                   "developed with doctors", "dermatologist tested"). It shows involvement. It does not
//                   show that anyone recommends the brand.
//   endorsement     experts or an expert body approve or back the brand ("endorsed by", "approved by",
//                   "accepted by", "seal of acceptance", "trusted by", "backed by").
//   recommendation  experts recommend it ("dermatologist recommended", "recommended by doctors").
// A quote that shows collaboration only is capped at "touched on". A quote with no reference to
// experts at all cannot be tied to the question. Word lists, not comprehensive: a phrasing they do not
// know is read as collaboration or as no expert reference, never as a recommendation.
// No extra request is made: this runs on the quote the existing analysis already returned.
// ---------------------------------------------------------------------------------------------

const EXPERT_TERM =
  '(?:dermatolog\\w*|dr|professors?|doctors?|physicians?|pediatricians?|paediatricians?|clinicians?|dentists?|dental professionals?|veterinarians?|vets?|pharmacists?|nutritionists?|dietitians?|therapists?|experts?|specialists?|estheticians?|aestheticians?|medical professionals?|healthcare professionals?)';
const RECOMMEND_TERM = '(?:recommend\\w*|prescrib\\w*|suggest\\w*|advis\\w*)';
const ENDORSE_TERM = '(?:endors\\w*|approv\\w*|accept\\w*|accredit\\w*|seal of|backed|trusted|chosen|certif\\w*)';

const EXPERT_RE = new RegExp(`\\b${EXPERT_TERM}\\b`, 'i');
const ASKS_EXPERT_RECOMMENDATION = new RegExp(`\\b${EXPERT_TERM}\\b[^.?!]{0,80}\\b(?:${RECOMMEND_TERM}|${ENDORSE_TERM})|\\b(?:${RECOMMEND_TERM}|${ENDORSE_TERM})\\b[^.?!]{0,80}\\b${EXPERT_TERM}\\b`, 'i');
const RECOMMENDATION_RE = new RegExp(`\\b${EXPERT_TERM}\\b[^.]{0,60}\\b${RECOMMEND_TERM}|\\b${RECOMMEND_TERM}\\b[^.]{0,60}\\b${EXPERT_TERM}\\b`, 'i');
const ENDORSEMENT_RE = new RegExp(`\\b${EXPERT_TERM}\\b[^.]{0,60}\\b${ENDORSE_TERM}|\\b${ENDORSE_TERM}\\b[^.]{0,60}\\b${EXPERT_TERM}\\b`, 'i');

// A person with a title, or a named body. Case matters here: names are capitalised, so this is not case-insensitive.
// A word list again: a named expert written in a way it does not know is read as unnamed (the safe direction).
const NAMED_EXPERT = new RegExp(
  '\\b(?:Dr|Prof|Professor)\\.?\\s+[A-Z][a-z]+' +
    '|\\b[A-Z][A-Za-z]+\\s+(?:Academy|Association|Society|Foundation|College|Council|Institute|Federation|Board)\\b' +
    '|\\b(?:Academy|Association|Society|Foundation|College|Council|Institute|Federation|Board)\\s+of\\s+[A-Z]',
);

/** Is this checklist item asking what experts recommend or endorse? */
export function isExpertRecommendationQuestion(text: string): boolean {
  return ASKS_EXPERT_RECOMMENDATION.test(text);
}

// A recommendation that is denied is not a recommendation. "Doctors do not recommend this brand", "not
// recommended by dermatologists" and "no dermatologist endorses it" mention experts and the word
// "recommend", and must not be read as one. The negator has to sit right before the verb (at most two
// words between), so "no harsh chemicals, dermatologist recommended" and "not only recommended by doctors"
// are not mistaken for denials, and "can't recommend it enough" is the praise it is meant as.
const NEGATOR = "(?:not|never|cannot|no longer|\\w+n['\u2019]t)";
const NEGATED_VERB = new RegExp(`\\b${NEGATOR}\\s+(?!(?:only|just)\\b)(?:\\w+\\s+){0,2}${'(?:' + RECOMMEND_TERM + '|' + ENDORSE_TERM + ')'}`, 'i');
const NO_EXPERT = new RegExp(`\\b(?:no|none of the|neither|nor)\\s+(?:\\w+\\s+){0,2}${EXPERT_TERM}\\b`, 'i');
const PRAISE_IDIOM = /\b(?:can(?:not|['\u2019]t)|couldn['\u2019]t)\s+(?:\w+\s+){0,2}recommend[^.]{0,40}\benough\b/gi;

/** Does this quote deny that experts recommend or endorse the brand? */
export function isNegated(quote: string): boolean {
  const text = quote.replace(PRAISE_IDIOM, ' ');
  return NEGATED_VERB.test(text) || (NO_EXPERT.test(text) && new RegExp(`\\b(?:${RECOMMEND_TERM}|${ENDORSE_TERM})`, 'i').test(text));
}

/** What a quote shows about experts, or null when it does not mention experts at all. */
export function expertEvidenceIn(rawQuote: string): ExpertEvidence | null {
  // "Dr. Jane Smith": the full stop after a title must not end the stretch of words the patterns look across.
  const quote = rawQuote.replace(/\b(Dr|Prof|Mr|Mrs|Ms)\./g, '$1');
  if (!EXPERT_RE.test(quote)) return null;
  if (isNegated(quote)) return 'negated';
  if (RECOMMENDATION_RE.test(quote)) return 'recommendation';
  if (ENDORSEMENT_RE.test(quote)) return 'endorsement';
  return 'collaboration';
}

/**
 * Apply the expert rule to a verdict that passed the relevance check. Only a verdict with a verified
 * quote for an expert-recommendation question is touched; every other verdict is returned as it was.
 */
export function applyExpertRule(input: { itemText: string; quote: string; outcome: RelevanceOutcome }): RelevanceOutcome & { expertEvidence?: ExpertEvidence } {
  const { outcome } = input;
  if (input.quote === '' || outcome.relevance === 'different_product' || outcome.relevance === 'uncertain') return outcome;
  if (!isExpertRecommendationQuestion(input.itemText)) return outcome;
  const shown = expertEvidenceIn(input.quote);
  if (shown === null) {
    return {
      level: 'none',
      relevance: 'uncertain',
      note: 'The question asks what experts recommend, and the words quoted do not mention experts, so they could not be tied to it.',
    };
  }
  if (shown === 'negated') {
    return {
      level: 'none',
      relevance: 'indirect',
      expertEvidence: 'negated',
      note: 'The words quoted say experts do not recommend or endorse the brand, or that none do. That is not a recommendation, so it counts as not addressed.',
    };
  }
  if (shown === 'collaboration') {
    return {
      level: outcome.level === 'clear' ? 'partial' : outcome.level,
      relevance: 'indirect',
      expertEvidence: 'collaboration',
      note: 'The words quoted show experts worked with the brand (helped develop or test it), not that experts recommend or endorse it. That counts as touched on, not as a clear answer.',
    };
  }
  // Experts recommend or endorse. The words are on the brand's own page, so they are the brand's claim.
  // Only a quote that names who recommends it (a named person or an organisation) can be a clear answer;
  // "dermatologist recommended" with nobody named is shown as the brand's claim, touched on.
  if (NAMED_EXPERT.test(input.quote)) {
    return {
      ...outcome,
      expertEvidence: shown,
      note: "A named expert or organisation is quoted, on the brand's own page.",
    };
  }
  return {
    level: outcome.level === 'clear' ? 'partial' : outcome.level,
    relevance: 'indirect',
    expertEvidence: 'brand_claim',
    note: "The brand's own page says experts recommend or endorse it, but the words quoted name no expert or organisation, and this audit did not verify the claim. It is shown as the brand's claim and counts as touched on, not as a clear answer.",
  };
}

// ---------------------------------------------------------------------------------------------
// Two more cases where a page is near the question but does not answer it.
//
// 1. "Which X is best for Y?" A page that only says the brand's product SUITS a range of types
//    ("suitable for a wide range of skin types from very dry to combination or oily") does not say it is
//    the best choice for one of them. It is capped at "touched on". A quote that picks the product out
//    for that need ("best for", "specifically formulated for") is left alone.
// 2. "Is it available outside the United States or in Europe?" A page needs to say where products are
//    available. A notice that the site detected the visitor's location says nothing about availability,
//    so it is "not addressed". Availability stated only in general terms ("ships worldwide") is touched on.
//
// Both are word lists applied to the quote the existing analysis already returned: no extra request.
// A phrasing they do not know is left as the analysis judged it.
// ---------------------------------------------------------------------------------------------

const SELECTION_Q = /\b(?:which|what)\b[^?.!]{0,60}\b(?:best|ideal|right|most suitable|better|top|good|recommended)\b[^?.!]{0,80}\b(?:for|to)\b/i;
const SUITS_A_RANGE = /\b(?:suitable|appropriate|safe|designed|formulated|made|works?|good|ok|okay)\s+for\b|\bwide range\b|\b(?:all|any|every)\s+(?:\w+\s+)?types?\b/i;
const PICKS_ONE_OUT = /\b(?:best|ideal|perfect|top|recommend\w*|go-to|our pick|favou?rite|choose|choice|specifically|especially|specially|tailored|targeted|#1)\b/i;

/** Does this item ask which product is best for a need, rather than asking about the whole brand? */
export function isSelectionQuestion(text: string): boolean {
  return SELECTION_Q.test(text);
}

/** Does this quote only say a product suits a range of types, without picking it out for the need? */
export function onlyGeneralSuitability(quote: string): boolean {
  return SUITS_A_RANGE.test(quote) && !PICKS_ONE_OUT.test(quote);
}

const AVAILABILITY_VERB = /\b(?:available|availability|ship\w*|deliver\w*|sold|sells?|buy|purchase|distribut\w*|stockists?|retailers?|stores?|where to buy|order\w*|offer\w*)\b/i;
const AVAILABILITY_Q = new RegExp(
  `\\b(?:available|availability|ship\\w*|deliver\\w*|sold|sells?|buy|purchase|stock\\w*|find)\\b[^?.!]{0,80}\\b(?:outside|abroad|overseas|international\\w*|worldwide|global\\w*|europe\\w*|asia\\w*|africa\\w*|canada|mexico|australia|india|uk|united kingdom|countries|country|regions?)\\b` +
    `|\\b(?:outside|abroad|overseas|international\\w*|worldwide|europe\\w*|countries|regions?)\\b[^?.!]{0,60}\\b(?:available|availability|ship\\w*|deliver\\w*|sold|buy|purchase)\\b`,
  'i',
);
// A named place other than the United States: the question asks about availability outside it.
const NAMED_PLACE =
  /\b(?:europe\w*|european union|eu|uk|united kingdom|britain|canada|canadian|australia\w*|asia\w*|africa\w*|india\w*|japan\w*|china|chinese|germany|german|france|french|spain|spanish|italy|italian|mexico|mexican|brazil\w*|latin america|middle east|korea\w*|singapore|ireland|netherlands|sweden|norway|denmark|poland|turkey|uae|saudi arabia|new zealand)\b/i;
const GENERAL_PLACE = /\b(?:countries|international\w*|worldwide|globally|global|overseas|abroad|regions?)\b/i;

/** Is this item asking where products are available outside the United States or in another region? */
export function isAvailabilityQuestion(text: string): boolean {
  return AVAILABILITY_Q.test(text);
}

/** What a quote says about where products are available: a named place, general terms only, or nothing. */
export function regionalAvailabilityIn(quote: string): 'named' | 'general' | 'none' {
  if (!AVAILABILITY_VERB.test(quote)) return 'none';
  if (NAMED_PLACE.test(quote)) return 'named';
  if (GENERAL_PLACE.test(quote)) return 'general';
  return 'none';
}

/**
 * Apply both rules to a verdict that passed the relevance check. Only a clear or partial verdict with a
 * verified quote, for a question of the kind each rule covers, is touched. Everything else is returned as it was.
 */
export function applyQuoteRules(input: { itemText: string; quote: string; outcome: RelevanceOutcome }): RelevanceOutcome {
  const { outcome, quote, itemText } = input;
  if (quote === '' || outcome.relevance === 'different_product' || outcome.relevance === 'uncertain' || outcome.level === 'none') return outcome;

  if (isAvailabilityQuestion(itemText)) {
    const found = regionalAvailabilityIn(quote);
    if (found === 'named') return outcome;
    if (found === 'general') {
      return {
        level: outcome.level === 'clear' ? 'partial' : outcome.level,
        relevance: 'indirect',
        note: 'The words quoted speak about availability in general terms and do not name a country or region, so this counts as touched on, not as a clear answer.',
      };
    }
    const locationNotice = /\b(?:location|detected|your (?:country|region))\b/i.test(quote);
    return {
      level: 'none',
      relevance: 'indirect',
      note: `The words quoted do not say where products are available. ${locationNotice ? "A notice about the visitor's location is not availability information. " : ''}It counts as not addressed unless a page states actual regional availability.`,
    };
  }

  if (isSelectionQuestion(itemText) && onlyGeneralSuitability(quote)) {
    return {
      level: outcome.level === 'clear' ? 'partial' : outcome.level,
      relevance: 'indirect',
      note: 'The words quoted say the product suits a range of types. They do not say it is the best choice for the need asked about, so this counts as touched on, not as a clear answer.',
    };
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// The brand's own statement is a claim, not independent evidence.
//
// The content gap compares what shoppers ask with what the brand's OWN pages say. For a question of fact
// ("how long does shipping take?", "are products sold in the UK?") the brand's page is the authority, so a
// page can answer it clearly. For a question about whether a product is EFFECTIVE, SUITABLE, clinically
// proven or recommended by experts ("which cleanser is best for oily skin?", "which brands do dermatologists
// recommend?"), a brand describing itself shows what the brand CLAIMS. It does not establish the claim: this
// audit reads no independent evidence at this step. Such an item is therefore at most "touched on", shown as
// "Touched on, brand claim", whatever the page says, a named expert on the brand's page included. The brand's
// own words are still shown, as its claim.
//
// Like the other quote rules this is a word list over the item's question, applied to the quote the
// existing analysis already returned: no extra request, no change to any scoring formula. A question the list
// does not recognise as a claim question keeps the verdict the analysis gave.
// ---------------------------------------------------------------------------------------------

export type ClaimKind = 'expert' | 'clinical' | 'effectiveness' | 'suitability';

const CLINICAL_Q = /\b(?:clinical\w*|clinically|proven|proof|studies|study|trials?|dermatologist[- ]tested)\b/i;
const EFFECTIVENESS_Q = /\b(?:work|works|worked|working|effective\w*|results?|efficacy|performance|perform\w*|reduces?|reduced|improves?|improved|treat\w*|heal\w*|repair\w*)\b/i;
const SUITABILITY_Q = /\b(?:best|better|ideal|suit\w*|safe\w*|gentle|good|great|worth|top|recommend\w*|right for)\b/i;

const CLAIM_NOUN: Record<ClaimKind, string> = {
  expert: 'that experts recommend it',
  clinical: 'its clinical performance',
  effectiveness: 'that it is effective',
  suitability: 'that it is the best or a suitable choice',
};

/** What kind of claim does this question ask about, or null when it asks for a fact the brand's pages can state. */
export function claimKind(text: string): ClaimKind | null {
  if (isExpertRecommendationQuestion(text)) return 'expert';
  if (CLINICAL_Q.test(text)) return 'clinical';
  if (EFFECTIVENESS_Q.test(text)) return 'effectiveness';
  if (SUITABILITY_Q.test(text)) return 'suitability';
  return null;
}

export type CheckedOutcome = RelevanceOutcome & { expertEvidence?: ExpertEvidence; brandClaim?: true };

/**
 * For a claim question, a verified quote from the brand's own page is the brand's claim: a "clear" verdict is
 * lowered to "partial", and the item is marked as a brand claim whether it was clear or partial.
 * Other verdicts, items with no verified quote, "not addressed" and "uncertain" items are returned as they were.
 */
export function applyFirstPartyRule(input: { itemText: string; quote: string; outcome: RelevanceOutcome & { expertEvidence?: ExpertEvidence } }): CheckedOutcome {
  const { outcome, quote, itemText } = input;
  if (quote === '' || outcome.level === 'none' || outcome.relevance === 'different_product' || outcome.relevance === 'uncertain') return outcome;
  const kind = claimKind(itemText);
  if (kind === null) return outcome;
  const lowered = outcome.level === 'clear';
  // An unnamed "dermatologist recommended" already says it is the brand's claim; saying it twice adds nothing.
  const alreadySaid = outcome.expertEvidence === 'brand_claim';
  const statement = `This is the brand's own statement on its website. It shows what the brand claims; it does not independently establish ${CLAIM_NOUN[kind]}.`;
  const note = [outcome.note, alreadySaid ? '' : statement, lowered && !alreadySaid ? 'It counts as touched on, not as a clear answer.' : '']
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  return { ...outcome, level: lowered ? 'partial' : outcome.level, brandClaim: true, note };
}

/**
 * The whole chain applied to a verdict that passed the relevance check, in the order the audit applies it:
 * the quote rules (general suitability, regional availability), the expert rule, then the brand-claim rule.
 */
export function applyAllRules(input: { itemText: string; quote: string; outcome: RelevanceOutcome }): CheckedOutcome {
  const afterQuote = applyQuoteRules(input);
  const afterExpert = applyExpertRule({ itemText: input.itemText, quote: input.quote, outcome: afterQuote });
  return applyFirstPartyRule({ itemText: input.itemText, quote: input.quote, outcome: afterExpert });
}
