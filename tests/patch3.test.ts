// Patch 3 rules, tested through the same entry points the audit uses.
//   1. A price tier excludes a question only when two independent domains state it.
//   2. Content-gap items carry one of four evidence classes, and only direct evidence lowers the gap.
//   3. Product range is reported in three states, with the real counts.
// No network and no storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobData, JobMeta } from '../lib/audit/job';
import { QUESTION_BANK } from '../lib/audit/questions';
import { registrableDomain, sourceSiteKey } from '../lib/evidence/price';
import * as relevance from '../lib/evidence/relevance';
import { computeCore, establishedPricePosition, outOfRangeQuestions, priceSupport } from '../lib/report/core';
import { gapPoints } from '../lib/scoring/content-gap';
import type { CategoryQuestion, ChecklistItem, GeminiAnswer, PricePosition } from '../lib/types';

const BRAND = 'Cetaphil';

function meta(): JobMeta {
  return {
    id: 'testjob0000000000000',
    brand: BRAND,
    brandCasing: 'typed',
    brandKey: 'cetaphil',
    categoryId: 'skincare',
    categoryLabel: 'Skincare',
    categoryNoun: 'skincare',
    categoryPlural: 'skincare brands',
    cacheKey: 'skincare:cetaphil',
    tier: 'full',
    status: 'running',
    stageIndex: 10,
    notes: {},
    warnings: [],
    attempts: {},
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    model: 'gemini-3.5-flash-lite',
    keys: { day: 'd', visitor: 'v', month: 'm', resv: 'r' },
    geminiRequests: 16,
    creditsSpent: 9,
    searches: [],
  };
}

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

type Item = { id: string; domain: string; title: string };
const article = (id: string, domain: string, title: string): Item => ({ id, domain, title });
const BUDGET_TITLE = 'Cetaphil is the drugstore skincare brand to buy';

function priceData(options: { items?: Item[]; comment?: boolean; sitePosition?: PricePosition | null; siteDomain?: string } = {}): JobData {
  const items = options.items ?? [];
  const comment: PricePosition | null = options.comment
    ? { tier: 'budget', origin: 'independent_source', evidenceId: 'C12', url: 'https://www.youtube.com/watch?v=x', domain: 'youtube.com', quote: 'products that are affordable and pretty easy to find' }
    : null;
  return {
    questions: QUESTION_BANK.skincare,
    answers: answers(QUESTION_BANK.skincare),
    audience: {
      discussionsDone: true,
      reviewsDone: true,
      brandDomains: [],
      items: items.map((item) => ({ id: item.id, kind: 'review' as const, url: `https://${item.domain}/a`, domain: item.domain, title: item.title, text: 'x', sourceUrl: `https://${item.domain}/a` })),
    },
    labels: {
      available: true,
      labels: items.map((item) => ({ id: item.id, relevant: true, voice: 'publication' as const, sentiment: 'neutral' as const })),
      praise: [],
      complaints: [],
      concerns: [],
      advocacy: [],
      creatorVsCustomer: '',
      droppedThemes: 0,
      pricePosition: comment,
    },
    ...(options.siteDomain ? { site: { domain: options.siteDomain, pages: [], secondSearchDone: true } } : {}),
    siteAnalysis: { available: false, productLines: [], positioning: [], signatureClaim: null, relevance: [], coverage: [], pricePosition: options.sitePosition ?? null },
  };
}

const brandSitePrice: PricePosition = { tier: 'budget', origin: 'brand_site', evidenceId: 'S1', url: 'https://cetaphil.com/about', domain: 'cetaphil.com', quote: 'Affordable, gentle skincare for everyday use' };

// ---------- 1. independent price sources ----------

test('one independent source is not enough to leave a question out: it is reported as insufficiently supported', () => {
  const data = priceData({ items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE)] });
  const support = priceSupport(BRAND, data);
  assert.deepEqual([support.status, support.tier, support.sources.length], ['insufficient', 'budget', 1]);
  assert.equal(establishedPricePosition(BRAND, data), null);
  assert.equal(outOfRangeQuestions(BRAND, data).size, 0, 'the luxury question stays in');
  const core = computeCore(meta(), data);
  assert.equal(core.visibility.detail.rows.find((r) => r.questionId === 'q8')?.state, 'counted');
  assert.equal(core.visibility.detail.counted, 8);
  assert.equal(core.contentGap.detail.priceSupport?.status, 'insufficient');
});

test('two independent domains establish the price tier, and the exclusion names both', () => {
  const data = priceData({ items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE), article('R2', 'beautydesk.example.com', 'Why Cetaphil is still the best budget cleanser')] });
  const support = priceSupport(BRAND, data);
  assert.deepEqual([support.status, support.sources.length], ['established', 2]);
  const excluded = outOfRangeQuestions(BRAND, data);
  assert.deepEqual([...excluded.keys()], ['q8']);
  assert.ok(excluded.get('q8')?.reason.includes('cosmopolitan.com') && excluded.get('q8')?.reason.includes('beautydesk.example.com'));
  assert.equal(excluded.get('q8')?.sources?.length, 2);
  assert.equal(computeCore(meta(), data).visibility.detail.counted, 7);
});

test('several pages from one domain count as one source', () => {
  const data = priceData({ items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE), article('R2', 'www.cosmopolitan.com', 'Why Cetaphil is still the best budget cleanser'), article('R3', 'cosmopolitan.com', 'Cetaphil: an affordable skincare staple')] });
  const support = priceSupport(BRAND, data);
  assert.deepEqual([support.status, support.sources.length], ['insufficient', 1]);
  assert.equal(outOfRangeQuestions(BRAND, data).size, 0);
});

test("the brand's own site can be one of the two, but only with another domain", () => {
  const alone = priceData({ sitePosition: brandSitePrice, siteDomain: 'cetaphil.com' });
  assert.equal(priceSupport(BRAND, alone).status, 'insufficient');
  assert.equal(outOfRangeQuestions(BRAND, alone).size, 0);

  const withOther = priceData({ sitePosition: brandSitePrice, siteDomain: 'cetaphil.com', items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, withOther).status, 'established');
  assert.deepEqual([...outOfRangeQuestions(BRAND, withOther).keys()], ['q8']);

  // A second page that happens to sit on the brand's own domain is not another source.
  const sameDomain = priceData({ sitePosition: brandSitePrice, siteDomain: 'cetaphil.com', items: [article('R1', 'www.cetaphil.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, sameDomain).status, 'insufficient');
  assert.equal(outOfRangeQuestions(BRAND, sameDomain).size, 0);
  // Nor is a subdomain of it, such as a shop page.
  const subdomain = priceData({ sitePosition: brandSitePrice, siteDomain: 'cetaphil.com', items: [article('R1', 'shop.cetaphil.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, subdomain).status, 'insufficient');
});

test('the brand root domain and its subdomains are one source, whichever of them the site was recorded as', () => {
  // The recorded site is a subdomain, and the other source is the root domain.
  const recordedSub = priceData({ sitePosition: { ...brandSitePrice, domain: 'us.cetaphil.com' }, siteDomain: 'us.cetaphil.com', items: [article('R1', 'cetaphil.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, recordedSub).status, 'insufficient');
  // Two different subdomains of the brand.
  const siblings = priceData({ siteDomain: 'cetaphil.com', items: [article('R1', 'shop.cetaphil.com', BUDGET_TITLE), article('R2', 'blog.cetaphil.com', 'Cetaphil: an affordable skincare staple')] });
  assert.equal(priceSupport(BRAND, siblings).status, 'insufficient');
  // Another domain the brand owns (found in the search results) is the same source too.
  const otherBrandDomain = priceData({ siteDomain: 'cetaphil.com', items: [article('R1', 'cetaphil.ca', BUDGET_TITLE)] });
  otherBrandDomain.audience!.brandDomains = ['cetaphil.ca'];
  otherBrandDomain.siteAnalysis!.pricePosition = brandSitePrice;
  assert.equal(priceSupport(BRAND, otherBrandDomain).status, 'insufficient');
  // A different company's site is independent, even with a similar name.
  const different = priceData({ siteDomain: 'cetaphil.com', sitePosition: brandSitePrice, items: [article('R1', 'cetaphil-reviews.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, different).status, 'established');
});

test('registrable domains: subdomains join, shared hosts and country endings are handled, no package involved', () => {
  assert.deepEqual(['brand.com', 'shop.brand.com', 'www.brand.com', 'm.brand.com', 'a.b.brand.com'].map(registrableDomain), Array(5).fill('brand.com'));
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('https://shop.brand.in/path?q=1'), 'brand.in');
  assert.equal(registrableDomain('someone.blogspot.com'), 'someone.blogspot.com');
  assert.notEqual(registrableDomain('one.blogspot.com'), registrableDomain('two.blogspot.com'), 'two blogs on a shared host are two publishers');
  assert.equal(sourceSiteKey('edition.cnn.com'), sourceSiteKey('www.cnn.com'));
});

test('a YouTube viewer comment never counts toward the two', () => {
  const commentAndOne = priceData({ comment: true, items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE)] });
  assert.equal(priceSupport(BRAND, commentAndOne).status, 'insufficient');
  assert.equal(outOfRangeQuestions(BRAND, commentAndOne).size, 0, 'one article plus one comment is not two sources');

  const commentOnly = priceData({ comment: true });
  assert.equal(priceSupport(BRAND, commentOnly).status, 'none');
  assert.equal(outOfRangeQuestions(BRAND, commentOnly).size, 0, 'what happened in the third live audit');

  const twoArticlesAndComment = priceData({ comment: true, items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE), article('R2', 'beautydesk.example.com', 'Why Cetaphil is still the best budget cleanser')] });
  const support = priceSupport(BRAND, twoArticlesAndComment);
  assert.equal(support.status, 'established');
  assert.ok(support.sources.every((s) => !s.domain.includes('youtube')), 'the comment is not among the sources shown');
});

test('sources in two tiers establish nothing', () => {
  const data = priceData({
    items: [article('R1', 'cosmopolitan.com', BUDGET_TITLE), article('R2', 'beautydesk.example.com', 'Why Cetaphil is still the best budget cleanser'), article('R3', 'vogue.example.com', 'Cetaphil is a luxury skincare brand')],
  });
  assert.equal(priceSupport(BRAND, data).status, 'conflicting');
  assert.equal(outOfRangeQuestions(BRAND, data).size, 0);
});

// ---------- 2. four evidence classes ----------

function item(partial: Partial<ChecklistItem> & Pick<ChecklistItem, 'level'>): ChecklistItem {
  return { id: 'c1', source: 'customer_concern', text: 'Does the cleanser dry out skin?', ...partial };
}

test('the four evidence classes, as a reader sees them', () => {
  const clear = item({ level: 'clear', relevance: 'direct' });
  const touched = item({ level: 'partial', relevance: 'indirect' });
  const notAddressed = item({ level: 'none', relevance: 'different_product', evidenceAbout: 'lotion' });
  const uncertain = item({ level: 'none', relevance: 'uncertain' });
  const unanswered = item({ level: 'none', unanswered: true });
  assert.deepEqual([clear, touched, notAddressed, uncertain, unanswered].map((i) => relevance.evidenceClass(i)), ['clear', 'touched_on', 'not_addressed', 'uncertain', 'uncertain']);
  // Gap points: clear 0, touched on 0.5, not addressed 1. Uncertain and unanswered are not scored at all.
  assert.deepEqual([clear, touched, notAddressed].map((i) => gapPoints([i])), [0, 0.5, 1]);
  assert.deepEqual([clear, touched, notAddressed, uncertain, unanswered].map((i) => relevance.isLeftOut(i)), [false, false, false, true, true]);
  // An old report's item, with no relevance field, is read by its level.
  assert.equal(relevance.evidenceClass(item({ level: 'partial' })), 'touched_on');
});

test('evidence about a different product does not improve the score', () => {
  const base = [item({ id: 'q1', level: 'none' }), item({ id: 'q2', level: 'none' }), item({ id: 'q3', level: 'clear', relevance: 'direct' }), item({ id: 'q4', level: 'none' })];
  const withLotion = base.map((i) => (i.id === 'q1' ? item({ id: 'q1', level: 'none', relevance: 'different_product', evidenceAbout: 'lotion' }) : i));
  assert.equal(gapPoints(withLotion), gapPoints(base), 'a lotion quote for a cleanser item adds nothing');
});

// ---------- 3. product range ----------

const page = (n: number) => ({ id: `S${n}`, url: `https://cetaphil.com/p${n}`, title: `Page ${n}`, text: 'Cetaphil page text. '.repeat(60), section: 'us' });
function rangeData(analysis: Partial<NonNullable<JobData['siteAnalysis']>>, pages = 3): JobData {
  return {
    questions: QUESTION_BANK.skincare,
    answers: answers(QUESTION_BANK.skincare),
    site: { domain: 'cetaphil.com', pages: Array.from({ length: pages }, (_, i) => page(i + 1)), secondSearchDone: true },
    siteAnalysis: { available: true, productLines: [], positioning: [], signatureClaim: null, relevance: [], coverage: [], pricePosition: null, ...analysis },
  };
}
const line = (name: string) => ({ name, ref: { pageId: 'S1', url: 'https://cetaphil.com/p1', quote: 'q' } });

test('product range: one verified line is enough to say products were identified, and the real counts are shown', () => {
  const range = computeCore(meta(), rangeData({ productLines: [line('Cleansers')] }, 3)).contentGap.detail.productRange;
  assert.deepEqual([range?.status, range?.linesIdentified, range?.pagesRead], ['identified', 1, 3], 'no three-line or five-page minimum');
  assert.ok(range?.note.includes('not a verified inventory'));
});

test('product range: partially assessed when product information was found but none could be verified', () => {
  const range = computeCore(meta(), rangeData({ productLines: [], productLinesUnverified: 2 })).contentGap.detail.productRange;
  assert.deepEqual([range?.status, range?.linesIdentified, range?.unverified], ['partial', 0, 2]);
  assert.ok(range?.note.includes('not a verified inventory'));
});

test('product range: could not be assessed when there is no reliable product information', () => {
  const noAnalysis = computeCore(meta(), rangeData({ available: false })).contentGap.detail.productRange;
  assert.equal(noAnalysis?.status, 'not_assessed');
  const nothingFound = computeCore(meta(), rangeData({ productLines: [], productLinesUnverified: 0 })).contentGap.detail.productRange;
  assert.equal(nothingFound?.status, 'not_assessed');
  assert.equal(nothingFound?.pagesRead, 3);
  const noSite = computeCore(meta(), { questions: QUESTION_BANK.skincare, answers: answers(QUESTION_BANK.skincare) }).contentGap.detail.productRange;
  assert.equal(noSite?.status, 'not_assessed');
});

// ---------- uncertain items are left out of the score ----------

function checklistData(sections: string[], pages: number, coverage: NonNullable<JobData['siteAnalysis']>['coverage']): JobData {
  const data = rangeData({ coverage, productLines: [line('Cleansers')] }, pages);
  data.site!.pages = data.site!.pages.map((p, i) => ({ ...p, section: sections[i % sections.length] }));
  return data;
}
const ev = (itemId: string, level: 'clear' | 'partial' | 'none', relevance: ChecklistItem['relevance'] = 'direct') => ({ itemId, level, relevance, url: 'https://cetaphil.com/p1', quote: 'q' });
const cover = (...rest: ReturnType<typeof ev>[]) => rest;

test('uncertain and unanswered items are left out of the content gap score, and confidence drops one level', () => {
  const coverage = [
    ev('q1', 'clear'),
    ev('q2', 'partial', 'indirect'),
    ev('q3', 'none', 'different_product'),
    ev('q4', 'none', undefined),
    ev('q5', 'none', undefined),
    ev('q6', 'none', undefined),
    { itemId: 'q7', level: 'none' as const, relevance: 'uncertain' as const, relevanceNote: 'The analysis did not say how this evidence relates to the question.' },
    { itemId: 'q8', level: 'none' as const, unanswered: true },
  ];
  const withAll = computeCore(meta(), checklistData(['a', 'b', 'c'], 8, coverage)).contentGap;
  // Six items are assessed: 0 + 0.5 + 1 + 1 + 1 + 1 = 4.5 points of 6, so 75. The two left out add nothing.
  assert.equal(withAll.metric.status === 'scored' && withAll.metric.score, 75);
  assert.equal(withAll.detail.points, 4.5);
  // 8 pages across 3 sections would be "high"; two items were left out, so "medium".
  assert.equal(withAll.metric.status === 'scored' && withAll.metric.confidence, 'medium');
  assert.ok(withAll.metric.status === 'scored' && withAll.metric.confidenceReason.includes('2 of the 8 checklist items could not be assessed'));
  assert.equal(withAll.detail.checklist.length, 8, 'the left-out items are still shown');

  // The same audit with nothing left out keeps the higher confidence.
  const clean = computeCore(meta(), checklistData(['a', 'b', 'c'], 8, [...coverage.slice(0, 6), ev('q7', 'none', 'direct'), ev('q8', 'none', 'direct')])).contentGap;
  assert.equal(clean.metric.status === 'scored' && clean.metric.confidence, 'high');
  assert.equal(clean.metric.status === 'scored' && clean.metric.score, 81, 'counted as not addressed, the same two items would give 6.5 of 8');

  // Medium goes to low.
  const medium = computeCore(meta(), checklistData(['a', 'b'], 6, coverage)).contentGap;
  assert.equal(medium.metric.status === 'scored' && medium.metric.confidence, 'low');
});

test('too few assessed items gives no score, and says why', () => {
  const coverage = [
    ev('q1', 'none', 'direct'),
    ev('q2', 'none', 'direct'),
    ev('q3', 'none', 'direct'),
    ...['q4', 'q5', 'q6', 'q7', 'q8'].map((itemId) => ({ itemId, level: 'none' as const, unanswered: true })),
  ];
  const gap = computeCore(meta(), checklistData(['a', 'b', 'c'], 8, coverage)).contentGap;
  assert.equal(gap.metric.status, 'insufficient');
  assert.ok(gap.metric.status === 'insufficient' && gap.metric.reason.includes('Only 3 of the 8 checklist items could be assessed'));
});

test('product range, partially assessed: the wording says candidates were identified but not fully verified', () => {
  const range = computeCore(meta(), rangeData({ productLines: [], productLinesUnverified: 2 })).contentGap.detail.productRange;
  assert.ok(range?.note.includes('2 product candidates were identified on the 3 pages read but could not be fully verified'));
});
