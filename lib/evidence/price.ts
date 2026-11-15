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
 * Every matching title is returned, whatever tier it names; the caller decides what to do when they disagree.
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
  return found;
}

/** The first such statement, or null. */
export function findStatedPricePosition<T extends { title: string }>(
  items: T[],
  brand: string,
): { tier: PriceTier; item: T; quote: string } | null {
  const found = findStatedPricePositions(items, brand);
  if (new Set(found.map((entry) => entry.tier)).size > 1) return null; // titles that disagree establish nothing
  return found[0] ?? null;
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

// Hosts where every customer gets their own subdomain, so two subdomains are two different
// publishers, not one site (two blogspot.com blogs are not one source).
const SHARED_HOSTS = [
  'blogspot.com', 'wordpress.com', 'substack.com', 'medium.com', 'tumblr.com', 'github.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'herokuapp.com', 'wixsite.com', 'weebly.com', 'myshopify.com', 'squarespace.com', 'ghost.io', 'beehiiv.com',
];
// Second-level endings under a country code (co.uk, com.au, org.in...). Not a full public-suffix list.
const SECOND_LEVELS = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or'];

function hostOf(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').replace(/^(www|m|amp)\./, '');
}

/**
 * The registrable domain: "shop.brand.com" and "brand.com" both give "brand.com"; "news.bbc.co.uk"
 * gives "bbc.co.uk"; "someone.blogspot.com" stays "someone.blogspot.com". Plain string rules, no
 * lookup and no package. It does not know every public suffix: an unusual ending is treated as
 * a plain ".com"-style one, which can join two sites into one (the safe direction here).
 */
export function registrableDomain(domain: string): string {
  const host = hostOf(domain);
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length <= 2) return labels.join('.');
  const shared = SHARED_HOSTS.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (shared) return labels.slice(-(shared.split('.').length + 1)).join('.');
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const twoPart = last.length === 2 && SECOND_LEVELS.includes(second);
  return labels.slice(twoPart ? -3 : -2).join('.');
}

/**
 * The site a source belongs to, for deciding whether two sources are independent. Pages of one
 * site, and its www., m., amp. and any other subdomain, are ONE source. Anything on the brand's
 * own registrable domain (brand.com, shop.brand.com, us.brand.com), and on any other domain the
 * brand is known to own, is the brand's own site: one source in total, whichever of them the
 * brand's site was recorded as.
 */
export function sourceSiteKey(domain: string, brandDomains: string[] = []): string {
  const key = registrableDomain(domain);
  if (key === '') return '';
  const own = brandDomains.map(registrableDomain).filter((d) => d !== '');
  return own.includes(key) ? own[0] : key; // every domain the brand owns is one source
}

// ---------------------------------------------------------------------------------------------
// Which sources may count as INDEPENDENT support for a price tier.
//
// The brand's own site may be one of the two sources a price tier needs. Everything else must be
// a source the brand did not write and does not own: a corporate press release, an announcement
// by the company (or its parent company), or other company-owned promotional material is NOT
// independent evidence, whatever domain it is on. At least one genuinely independent source is
// always required. When independence cannot be shown, the price position stays unestablished.
//
// What this code can check, with plain string rules and no lookup, no search and no package:
//   1. the domain is the brand's own or one it is known to own                       -> brand
//   2. the domain is a press-release wire service (prnewswire.com and similar)       -> company material
//   3. the address is under a press or newsroom path, or a news path with an
//      announcement headline ("... Unveils ...", "... Announces ...")                -> company material
//   4. the brand's own pages name the domain's company as the owner, publisher or
//      copyright holder (for example "(c) Galderma", "a brand of Galderma")           -> company material
// LIMITS, stated in the README and in the report: this cannot discover every parent company, every
// subsidiary or every advertorial. A company site that fits none of the four tests is treated as
// independent. A genuine news article under a news path with an announcement-style headline is
// set aside by test 3 (the safe direction: the price position then stays unestablished).
// ---------------------------------------------------------------------------------------------

export type SourceIndependence = 'brand' | 'company_material' | 'independent';

const WIRE_SERVICES = [
  'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'prweb.com', 'einpresswire.com', 'newswire.com',
  'accesswire.com', 'openpr.com', 'pressrelease.com', '24-7pressrelease.com', 'send2press.com', 'prlog.org',
  'issuewire.com', 'mynewsdesk.com', 'newsdirect.com',
];
const PRESS_PATH = /(^|\/)(press|press-?releases?|news-?releases?|news-?room|press-?room|media-?(centre|center|room|kit)|investors?|investor-relations|ir|corporate(-news)?)(\/|$)/i;
const NEWS_PATH = /(^|\/)(news|media|company-news)(\/|$)/i;
const ANNOUNCEMENT = /\b(unveils?|announces?|launch(es|ed)?|introduces?|debuts?|reveals?|expands?|appoints?|welcomes?|celebrates?|partners? with|signs|completes|acquires?)\b/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\/[^/]*/, '').replace(/[?#].*$/, '');
  }
}

/** A press release or corporate announcement, judged from the domain, the address and the headline. */
export function looksLikeCompanyMaterial(input: { domain: string; url: string; quote: string }): boolean {
  const registrable = registrableDomain(input.domain);
  if (WIRE_SERVICES.includes(registrable)) return true;
  const path = pathOf(input.url);
  if (PRESS_PATH.test(path)) return true;
  return NEWS_PATH.test(path) && (ANNOUNCEMENT.test(input.quote) || ANNOUNCEMENT.test(path.replace(/[-_/]+/g, ' ')));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Do the brand's own pages name this domain's company as the owner, publisher or copyright holder?
 * Looks for the company name (the first label of the domain, at least four letters) next to a
 * word such as "(c)", "copyright", "a brand of", "owned by", "part of", "manufactured by" or
 * "trademark of". A media outlet merely listed on the brand's site ("as seen in ...") is not caught.
 */
export function namedAsOwnerOnBrandSite(domain: string, brandPagesText: string): boolean {
  const label = registrableDomain(domain).split('.')[0] ?? '';
  if (label.length < 4 || brandPagesText === '') return false;
  const name = escapeRegExp(label);
  const before = '(?:©|\\(c\\)|copyright|trademarks? of|registered trademarks? of|owned by|a (?:division|brand|business|company|subsidiary|member) of|part of(?: the)?|manufactured by|marketed by|distributed by|made by|produced by)';
  return new RegExp(`${before}[^.\\n]{0,70}\\b${name}\\b`, 'i').test(brandPagesText);
}

/** The independence of one source: the brand's own site, company material, or independent. */
export function sourceIndependence(
  entry: { domain: string; url: string; quote: string },
  brandDomains: string[],
  brandPagesText: string,
): { kind: SourceIndependence; reason?: string } {
  const key = registrableDomain(entry.domain);
  if (key !== '' && brandDomains.map(registrableDomain).includes(key)) return { kind: 'brand' };
  if (looksLikeCompanyMaterial(entry)) return { kind: 'company_material', reason: 'a press release or company announcement' };
  if (key !== '' && namedAsOwnerOnBrandSite(entry.domain, brandPagesText)) {
    return { kind: 'company_material', reason: "the company is named on the brand's own site as its owner or publisher" };
  }
  return { kind: 'independent' };
}
