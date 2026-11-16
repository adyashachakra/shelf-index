// Patch 4 rules, tested through the same entry points the audit uses.
//   1. A price tier needs at least one source independent of the brand. A press release, a corporate
//      announcement or other company material (a parent company's included) never counts.
//   2. For a question about what experts recommend, "worked with experts" is not "experts recommend".
// No network and no storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobData } from '../lib/audit/job';
import { QUESTION_BANK } from '../lib/audit/questions';
import { looksLikeCompanyMaterial, namedAsOwnerOnBrandSite, sourceIndependence } from '../lib/evidence/price';
import * as relevance from '../lib/evidence/relevance';
import { outOfRangeQuestions, priceSupport } from '../lib/report/core';
import type { CategoryQuestion, GeminiAnswer, PricePosition } from '../lib/types';

const BRAND = 'Cetaphil';

function answers(questions: CategoryQuestion[]): GeminiAnswer[] {
  return questions.map((q, i) => ({
    id: `G${i + 1}`,
    questionId: q.id,
    question: q.text,
    intent: q.intent,
    status: 'answered',
    answer: 'I would suggest CeraVe and Vanicream.',
    recommendations: ['CeraVe', 'Vanicream'].map((brand) => ({ brand, why: `${brand} is a sound choice here.` })),
    alsoMentioned: [],
    model: 'gemini-3.5-flash-lite',
  }));
}

type Source = { id: string; url: string; title: string };
const src = (id: string, url: string, title: string): Source => ({ id, url, title });
const domainOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

function data(options: { sources?: Source[]; sitePosition?: PricePosition | null; brandPagesText?: string; siteDomain?: string }): JobData {
  const sources = options.sources ?? [];
  const siteDomain = options.siteDomain ?? (options.brandPagesText !== undefined || options.sitePosition ? 'cetaphil.com' : '');
  return {
    questions: QUESTION_BANK.skincare,
    answers: answers(QUESTION_BANK.skincare),
    audience: {
      discussionsDone: true,
      reviewsDone: true,
      brandDomains: [],
      items: sources.map((s) => ({ id: s.id, kind: 'review' as const, url: s.url, domain: domainOf(s.url), title: s.title, text: 'x', sourceUrl: s.url })),
    },
    labels: {
      available: true,
      labels: sources.map((s) => ({ id: s.id, relevant: true, voice: 'publication' as const, sentiment: 'neutral' as const })),
      praise: [], complaints: [], concerns: [], advocacy: [], creatorVsCustomer: '', droppedThemes: 0, pricePosition: null,
    },
    ...(siteDomain
      ? { site: { domain: siteDomain, pages: [{ id: 'S1', url: `https://${siteDomain}/us`, title: 'Home', text: options.brandPagesText ?? 'Gentle skin care.', section: 'home' }], secondSearchDone: true } }
      : {}),
    siteAnalysis: { available: false, productLines: [], positioning: [], signatureClaim: null, relevance: [], coverage: [], pricePosition: options.sitePosition ?? null },
  };
}

const COSMO = src('R7', 'https://www.cosmopolitan.com/style-beauty/beauty/a62944299/cerave-vs-cetaphil', 'Cetaphil is the drugstore skincare brand to buy');
const VOGUE = src('R2', 'https://www.vogue.example.net/beauty/cetaphil-guide', 'Cetaphil is a luxury skincare brand worth the splurge');
// The press release that the third live audit counted as an independent source.
const GALDERMA = src(
  'K8',
  'https://www.galderma.com/news/cetaphilr-unveils-premium-product-line-new-hydrosensitivtm-complex-delivers-48-hour-hydration',
  'Cetaphil® Unveils Premium Product Line with New HydroSensitiv™ Complex That Delivers 48-Hour Hydration | Galderma',
);
const brandSite = (tier: 'budget' | 'premium'): PricePosition => ({
  tier, origin: 'brand_site', evidenceId: 'S1', url: 'https://www.cetaphil.com/us/about', domain: 'cetaphil.com',
  quote: tier === 'budget' ? 'Affordable, gentle skincare for everyday use' : 'Premium skincare for sensitive skin',
});

// ---------- 1. independence of price sources ----------

test('the press release from the live audit no longer counts: the position stays unestablished and the luxury question stays in', () => {
  const d = data({ sources: [COSMO, GALDERMA] });
  const support = priceSupport(BRAND, d);
  assert.notEqual(support.status, 'established');
  assert.equal(support.status, 'insufficient', 'one independent source is left');
  assert.deepEqual(support.sources.map((s) => s.domain), ['cosmopolitan.com']);
  assert.equal(support.setAside?.length, 1);
  assert.equal(support.setAside?.[0].domain, 'galderma.com');
  assert.match(support.setAside?.[0].reason ?? '', /press release/);
  assert.equal(outOfRangeQuestions(BRAND, d).size, 0);
});

test('a press release agreeing with one independent source does not establish the tier either', () => {
  const premiumRelease = src('K8', GALDERMA.url, GALDERMA.title);
  const d = data({ sources: [VOGUE, premiumRelease] });
  const support = priceSupport(BRAND, d);
  assert.equal(support.status, 'insufficient');
  assert.equal(support.tier, 'premium');
  assert.equal(outOfRangeQuestions(BRAND, d).size, 0, 'two sources agree, but only one is independent');
});

test('the brand site may count as one of the two, with one genuinely independent source', () => {
  const d = data({ sources: [COSMO], sitePosition: brandSite('budget') });
  const support = priceSupport(BRAND, d);
  assert.deepEqual([support.status, support.sources.length, support.tier], ['established', 2, 'budget']);
  assert.deepEqual([...outOfRangeQuestions(BRAND, d).keys()], ['q8']);
});

test('the brand site and a press release: independence cannot be shown, so the position is not established', () => {
  const d = data({ sources: [GALDERMA], sitePosition: brandSite('premium') });
  const support = priceSupport(BRAND, d);
  assert.equal(support.status, 'not_independent');
  assert.equal(support.sources.length, 1, 'only the brand site is counted');
  assert.equal(outOfRangeQuestions(BRAND, d).size, 0);
});

test('only company material: nothing independent, nothing established', () => {
  const d = data({ sources: [GALDERMA, src('K9', 'https://www.prnewswire.com/news-releases/cetaphil-launches-premium-line-301.html', 'Cetaphil launches a premium line')] });
  const support = priceSupport(BRAND, d);
  assert.deepEqual([support.status, support.sources.length, support.setAside?.length], ['not_independent', 0, 2]);
  assert.equal(outOfRangeQuestions(BRAND, d).size, 0);
});

test('two pages of one domain are still one source, and two press pages of one company are one entry set aside', () => {
  const second = src('R9', 'https://www.cosmopolitan.com/style-beauty/cetaphil-best-budget', 'Why Cetaphil is the best budget cleanser');
  assert.equal(priceSupport(BRAND, data({ sources: [COSMO, second] })).status, 'insufficient');
  const press2 = src('K9', 'https://www.galderma.com/news/cetaphil-expands-premium-range', 'Cetaphil expands premium range');
  const support = priceSupport(BRAND, data({ sources: [GALDERMA, press2, COSMO] }));
  assert.equal(support.setAside?.length, 1);
});

test('two independent domains, neither the brand, still establish the tier', () => {
  const second = src('R2', 'https://www.beautydesk.example.net/best-budget', 'Why Cetaphil is still the best budget cleanser');
  const support = priceSupport(BRAND, data({ sources: [COSMO, second] }));
  assert.deepEqual([support.status, support.sources.length], ['established', 2]);
});

test('how each kind of source is classified, and what the rule cannot know', () => {
  const brandDomains = ['cetaphil.com'];
  const ownText = 'All rights reserved. © 2026 Galderma Laboratories, L.P. Cetaphil is a registered trademark of Galderma. As seen in Cosmopolitan and Vogue.';
  const kind = (url: string, quote = 'Cetaphil is affordable') => sourceIndependence({ domain: domainOf(url), url, quote }, brandDomains, ownText).kind;
  assert.equal(kind('https://shop.cetaphil.com/us/x'), 'brand');
  assert.equal(kind('https://www.prnewswire.com/news-releases/x.html'), 'company_material', 'a wire service');
  assert.equal(kind('https://www.example-company.com/press/2026/new-line'), 'company_material', 'a press path');
  assert.equal(kind('https://www.example-company.com/newsroom/new-line'), 'company_material', 'a newsroom path');
  assert.equal(kind('https://www.example-company.com/news/company-launches-line', 'Company launches a line'), 'company_material', 'a news path with an announcement headline');
  assert.equal(kind('https://www.galderma.com/about-us'), 'company_material', 'named on the brand site as its owner');
  assert.equal(kind('https://www.cosmopolitan.com/style-beauty/x'), 'independent', 'a media outlet listed on the brand site is not caught');
  assert.equal(kind('https://www.bbc.co.uk/news/health-123', 'Dermatologists rate Cetaphil as a budget buy'), 'independent', 'a news article without an announcement headline');
  // Known limits, stated in the README: a parent company the brand site does not name, with a plain page, is treated as independent.
  assert.equal(kind('https://www.unnamed-parent.com/about', 'Cetaphil is premium'), 'independent');
  assert.equal(looksLikeCompanyMaterial({ domain: 'a.com', url: 'https://a.com/blog/post', quote: 'Cetaphil launches' }), false);
  assert.equal(namedAsOwnerOnBrandSite('galderma.com', ''), false);
  assert.equal(namedAsOwnerOnBrandSite('ab.com', 'part of ab'), false, 'a name under four letters is never matched');
});

// ---------- 2. expert collaboration, endorsement, recommendation ----------

const Q6 = 'Which skincare brands do dermatologists recommend most?';
const outcome = (level: 'clear' | 'partial', relevanceKind: 'direct' | 'brand_wide' = 'brand_wide') => ({ level, relevance: relevanceKind });

test('which questions are about what experts recommend', () => {
  assert.equal(relevance.isExpertRecommendationQuestion(Q6), true);
  assert.equal(relevance.isExpertRecommendationQuestion('Do doctors recommend it for sensitive skin?'), true);
  assert.equal(relevance.isExpertRecommendationQuestion('Which shampoos are approved by dermatologists?'), true);
  assert.equal(relevance.isExpertRecommendationQuestion('What do dermatologists say about retinol?'), false);
  assert.equal(relevance.isExpertRecommendationQuestion('What are the best skincare brands for anti-aging?'), false);
  assert.equal(relevance.isExpertRecommendationQuestion('Which brands do customers recommend most?'), false);
});

test('what a quote shows about experts: collaboration, endorsement or recommendation', () => {
  assert.equal(relevance.expertEvidenceIn("We've partnered with dermatologists to identify 5 signs of sensitivity"), 'collaboration');
  assert.equal(relevance.expertEvidenceIn('Developed with dermatologists and tested on sensitive skin'), 'collaboration');
  assert.equal(relevance.expertEvidenceIn('Dermatologist tested and approved formulas'), 'endorsement', 'approved by the testers is read as an approval');
  assert.equal(relevance.expertEvidenceIn('Approved by dermatologists for sensitive skin'), 'endorsement');
  assert.equal(relevance.expertEvidenceIn('Trusted by doctors worldwide'), 'endorsement');
  assert.equal(relevance.expertEvidenceIn('The #1 dermatologist-recommended cleanser brand'), 'recommendation');
  assert.equal(relevance.expertEvidenceIn('Recommended by doctors and pharmacists'), 'recommendation');
  assert.equal(relevance.expertEvidenceIn('Clinically proven to hydrate for 48 hours'), null, 'no expert is mentioned');
});

test('the q6 case from the live audit: working with dermatologists is touched on, not a clear answer', () => {
  const quote = "We've partnered with dermatologists to identify 5 signs of sensitivity";
  const result = relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('clear') });
  assert.equal(result.level, 'partial');
  assert.equal(result.relevance, 'indirect');
  assert.equal(result.expertEvidence, 'collaboration');
  assert.match(result.note ?? '', /worked with the brand/);
  assert.equal(relevance.evidenceClass(result), 'touched_on');
  assert.equal(relevance.isLeftOut(result), false, 'it is scored as touched on, not left out');
});

test('a recommendation or endorsement stays clear only when it names who gives it (patch 5); no reference to experts cannot be tied to the question', () => {
  // Patch 4 kept these two as clear. Patch 5 reads a recommendation with nobody named as the brand's own claim:
  // see tests/patch5.test.ts for the full set of cases.
  const rec = relevance.applyExpertRule({ itemText: Q6, quote: 'Recommended by the American Academy of Dermatology', outcome: outcome('clear') });
  assert.deepEqual([rec.level, rec.relevance, rec.expertEvidence], ['clear', 'brand_wide', 'recommendation']);
  const end = relevance.applyExpertRule({ itemText: Q6, quote: 'Approved by Dr. Jane Smith, dermatologist, for sensitive skin', outcome: outcome('clear', 'direct') });
  assert.deepEqual([end.level, end.relevance, end.expertEvidence], ['clear', 'direct', 'endorsement']);
  const none = relevance.applyExpertRule({ itemText: Q6, quote: 'Clinically proven to hydrate for 48 hours', outcome: outcome('clear') });
  assert.deepEqual([none.level, none.relevance], ['none', 'uncertain']);
  assert.equal(relevance.isLeftOut(none), true);
});

test('the expert rule touches nothing else', () => {
  const quote = "We've partnered with dermatologists to identify 5 signs of sensitivity";
  const other = outcome('clear');
  assert.deepEqual(relevance.applyExpertRule({ itemText: 'What are the best skincare brands for anti-aging?', quote, outcome: other }), other, 'not an expert question');
  assert.deepEqual(relevance.applyExpertRule({ itemText: 'What do dermatologists say about retinol?', quote, outcome: other }), other, 'asks what experts say, not what they recommend');
  assert.deepEqual(relevance.applyExpertRule({ itemText: Q6, quote: '', outcome: other }), other, 'no verified quote: left to the earlier downgrade');
  const uncertain = { level: 'none' as const, relevance: 'uncertain' as const, note: 'x' };
  assert.deepEqual(relevance.applyExpertRule({ itemText: Q6, quote, outcome: uncertain }), uncertain);
  const different = { level: 'none' as const, relevance: 'different_product' as const };
  assert.deepEqual(relevance.applyExpertRule({ itemText: Q6, quote, outcome: different }), different);
  // A "touched on" verdict with collaboration evidence stays touched on.
  assert.equal(relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('partial') }).level, 'partial');
});
