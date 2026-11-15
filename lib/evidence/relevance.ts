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

import type { CoverageLevel, EvidenceClass, EvidenceRelevance } from '../types';

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
