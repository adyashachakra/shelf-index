// Price-tier words. Used for one narrow job: deciding whether a shopper question about
// "luxury" (or "affordable") brands is a fair question to count for a given brand.
//
// A brand's price position is only ever taken from a quote found in a retrieved source that
// says it in words. Nothing here guesses a tier from prices, reputation or the model's memory.

import type { CategoryQuestion, PriceTier } from '../types';
import { mentionsBrand } from './brand-match';
import { quoteIsAboutBrand } from './quotes';

const BUDGET_WORDS =
  /\b(drug ?store|affordable|affordably|budget|inexpensive|cheap|low[- ]cost|low[- ]priced?|bargain|wallet[- ]friendly|pocket[- ]friendly|mass[- ]market)\b/i;
const PREMIUM_WORDS = /\b(luxury|luxurious|high[- ]end|prestige|premium|expensive|pricey|splurge|upscale|designer)\b/i;

/** Which price tier a piece of text names. "both" when it names the two, null when neither. */
export function tierWordsIn(text: string): PriceTier | 'both' | null {
  const budget = BUDGET_WORDS.test(text);
  const premium = PREMIUM_WORDS.test(text);
  if (budget && premium) return 'both';
  if (budget) return 'budget';
  if (premium) return 'premium';
  return null;
}

/**
 * The price tier a shopper question is about, if any. The question bank tags these questions
 * with the intent "value" or "premium" in every category; other questions are read by keyword.
 */
export function questionPriceTier(question: Pick<CategoryQuestion, 'intent' | 'text'>): PriceTier | null {
  const intent = question.intent.trim().toLowerCase();
  if (intent === 'premium' || intent === 'luxury') return 'premium';
  if (intent === 'value' || intent === 'small budgets' || intent === 'budget' || intent === 'affordable') return 'budget';
  const words = tierWordsIn(question.text);
  return words === 'budget' || words === 'premium' ? words : null;
}

/** A brand in the lower tier is outside a premium question, and the reverse. */
export function tiersConflict(questionTier: PriceTier, brandTier: PriceTier): boolean {
  return questionTier !== brandTier;
}

export function tierPhrase(tier: PriceTier): string {
  return tier === 'budget' ? 'a lower-priced brand' : 'a premium brand';
}

export function questionTierPhrase(tier: PriceTier): string {
  return tier === 'budget' ? 'lower-priced' : 'premium or luxury';
}

/**
 * Accept a price position only when the quoted words are really in the source, name a price
 * tier (and only one), and are about this brand. Returns the tier, or null when any check fails.
 *
 * For a page on the brand's own site the passage does not need to name the brand. For any other
 * source the brand must be named in the title or within the passage around the quote.
 */
export function verifiedPriceTier(input: {
  tier: PriceTier | 'unclear';
  quote: string;
  title: string;
  text: string;
  brand: string;
  ownSite: boolean;
}): PriceTier | null {
  if (input.tier === 'unclear' || input.quote === '') return null;
  if (tierWordsIn(input.quote) !== input.tier) return null;
  if (quoteIsAboutBrand(input) !== 'ok') return null;
  return input.tier;
}

// Words that turn a price word into a comparison, a denial or a switch ("cheaper than X",
// "not cheap", "an affordable alternative to X", "why I moved from luxury brands to X").
// A title containing one is never used as evidence.
const COMPARISON_OR_DENIAL =
  /\b(than|not|never|no longer|alternatives?|dupes?|versus|vs|compared|comparison|cheaper|pricier|unlike|instead|rather|from|switch\w*|swap\w*|ditch\w*|without|(more|less) (expensive|affordable|premium|luxurious))\b|n['’]t\b/i;

/**
 * Plain statements of the brand's price position, found by reading source TITLES directly:
 * a title that names the brand, uses a price-tier word for one tier only, and is not a
 * comparison, a denial or a story about switching. Titles are used because a title says what
 * its page is about; a sentence deep in a page can mention a price word for any reason.
 * Every matching title is returned. If the titles disagree about the tier, none is.
 */
export function findStatedPricePositions<T extends { title: string }>(
  items: T[],
  brand: string,
): { tier: PriceTier; item: T; quote: string }[] {
  const found: { tier: PriceTier; item: T; quote: string }[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (title.length < 12 || !mentionsBrand(title, brand)) continue;
    if (COMPARISON_OR_DENIAL.test(title)) continue;
    const tier = tierWordsIn(title);
    if (tier !== 'budget' && tier !== 'premium') continue;
    found.push({ tier, item, quote: title });
  }
  if (new Set(found.map((entry) => entry.tier)).size > 1) return [];
  return found;
}

/** The first such statement, or null. */
export function findStatedPricePosition<T extends { title: string }>(
  items: T[],
  brand: string,
): { tier: PriceTier; item: T; quote: string } | null {
  return findStatedPricePositions(items, brand)[0] ?? null;
}

/**
 * A statement about the brand's price level ("affordable", "luxury") needs the price level in
 * the quoted words themselves: the same level to support it, the opposite level to contradict
 * it. A comparison such as "slightly cheaper" states neither. Any statement that is not about
 * price level passes untouched.
 */
export function priceQuoteDecides(claimText: string, verdict: 'supported' | 'contradicted', quote: string): boolean {
  const claimed = tierWordsIn(claimText);
  if (claimed !== 'budget' && claimed !== 'premium') return true;
  const quoted = tierWordsIn(quote);
  if (verdict === 'supported') return quoted === claimed;
  return quoted !== null && quoted !== 'both' && quoted !== claimed;
}
