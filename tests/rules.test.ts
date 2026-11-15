// The evidence rules added after the first live audit: question relevance by price tier,
// quotes that must be about the brand, brand capitalisation, and patterns that are only called
// "observed" when the audit holds the evidence. No network and no storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobData, JobMeta } from '../lib/audit/job';
import { QUESTION_BANK, templateQuestions } from '../lib/audit/questions';
import { casingLooksDeliberate, mostCommonCasing, titleCaseBrand } from '../lib/evidence/brand-match';
import { asHypothesis, NEUTRAL_HYPOTHESIS, overclaims, withoutOverclaim } from '../lib/evidence/overclaim';
import { findStatedPricePosition, questionPriceTier, tierWordsIn, verifiedPriceTier } from '../lib/evidence/price';
import { passageAround, quoteIsAboutBrand } from '../lib/evidence/quotes';
import { buildReport } from '../lib/report/build';
import { computeCore, establishedPricePosition, outOfRangeQuestions } from '../lib/report/core';
import type { CategoryQuestion, GeminiAnswer, PricePosition } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';

const BRAND = 'Cetaphil';

function meta(overrides: Partial<JobMeta> = {}): JobMeta {
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
    ...overrides,
  };
}

function answers(questions: CategoryQuestion[], brandNamedIn: string[] = []): GeminiAnswer[] {
  return questions.map((q, i) => {
    const names = brandNamedIn.includes(q.id) ? ['CeraVe', BRAND] : ['CeraVe', 'Vanicream'];
    return {
      id: `G${i + 1}`,
      questionId: q.id,
      question: q.text,
      intent: q.intent,
      status: 'answered',
      answer: `I would suggest ${names.join(' and ')}.`,
      recommendations: names.map((brand) => ({ brand, why: `${brand} is a sound choice here.` })),
      alsoMentioned: [],
      model: 'gemini-3.5-flash-lite',
    };
  });
}

const budgetFromReview: PricePosition = {
  tier: 'budget',
  origin: 'independent_source',
  evidenceId: 'R1',
  url: 'https://www.cosmopolitan.com/cerave-or-cetaphil',
  domain: 'cosmopolitan.com',
  quote: 'I Tested Both Drugstore Skincare Brands',
};

function labels(pricePosition: PricePosition | null): NonNullable<JobData['labels']> {
  return { available: true, labels: [], praise: [], complaints: [], concerns: [], advocacy: [], creatorVsCustomer: '', droppedThemes: 0, pricePosition };
}

test('every category with price-tier questions tags them the same way', () => {
  for (const category of ['skincare', 'fashion', 'homeware', 'cookware'] as const) {
    const tiers = QUESTION_BANK[category].map((q) => questionPriceTier(q));
    assert.equal(tiers.filter((t) => t === 'budget').length, 1, `${category}: one low-priced question`);
    assert.equal(tiers.filter((t) => t === 'premium').length, 1, `${category}: one premium question`);
  }
  assert.deepEqual(templateQuestions('running shoes').map((q) => questionPriceTier(q)).filter(Boolean), ['budget', 'premium']);
  assert.ok(QUESTION_BANK.beverages.every((q) => questionPriceTier(q) === null), 'beverages has no price-tier question');
  // A question written by the model for a typed-in category is read by its words.
  assert.equal(questionPriceTier({ intent: 'gifting', text: 'Which luxury candle brands make the best gifts?' }), 'premium');
  assert.equal(questionPriceTier({ intent: 'students', text: 'What are good cheap laptop brands for students?' }), 'budget');
  assert.equal(questionPriceTier({ intent: 'comparison', text: 'Which affordable brands rival the expensive ones?' }), null, 'both tiers named: not a tier question');
});

test('a price position needs the price word in the quote, the quote in the source, and the brand beside it', () => {
  const title = 'CeraVe or Cetaphil? I Tested Both Drugstore Skincare Brands';
  const text = 'After a month of testing both ranges on my dry, sensitive skin, here is how the cleansers and creams compared day to day.';
  const base = { title, text, brand: BRAND, ownSite: false };
  assert.equal(verifiedPriceTier({ ...base, tier: 'budget', quote: 'I Tested Both Drugstore Skincare Brands' }), 'budget');
  assert.equal(verifiedPriceTier({ ...base, tier: 'premium', quote: 'I Tested Both Drugstore Skincare Brands' }), null, 'the quote says the opposite tier');
  assert.equal(verifiedPriceTier({ ...base, tier: 'budget', quote: 'how the cleansers and creams compared day to day' }), null, 'no price word in the quote');
  assert.equal(verifiedPriceTier({ ...base, tier: 'budget', quote: 'a famously affordable drugstore staple for decades' }), null, 'the quote is not in the source');
  assert.equal(verifiedPriceTier({ ...base, tier: 'unclear', quote: '' }), null);
  // A listicle that names the brand far away from the quoted sentence proves nothing about the brand.
  const listicle = `Here are some product recommendations in the budget category. ${'Many shoppers start with a basic routine and add steps slowly over several months. '.repeat(6)} Further down, Cetaphil appears in a different section.`;
  assert.equal(verifiedPriceTier({ tier: 'budget', quote: 'Here are some product recommendations in the budget category', title: 'Skincare on a budget', text: listicle, brand: BRAND, ownSite: false }), null);
  assert.equal(tierWordsIn('premium quality at affordable prices'), 'both');
});

test('a plain statement of price position is read from source titles, and comparisons are never used', () => {
  const titled = (title: string) => ({ title });
  const cosmo = titled('CeraVe or Cetaphil? I Tested Both Drugstore Skincare Brands');
  const found = findStatedPricePosition([cosmo], BRAND);
  assert.deepEqual([found?.tier, found?.quote], ['budget', 'CeraVe or Cetaphil? I Tested Both Drugstore Skincare Brands']);

  const rejected = [
    'I found a serum that is cheaper than Cetaphil',
    'Cetaphil is not cheap anymore where I live',
    'Looking for an affordable alternative to Cetaphil',
    'Cetaphil is the expensive option at my drugstore', // names both tiers
    'Why I switched from luxury skincare to Cetaphil',
    'Is Cetaphil more expensive now?',
    'This drugstore cleanser is lovely and gentle', // no brand named
    'Cetaphil review after one month', // no price word
  ];
  for (const title of rejected) assert.equal(findStatedPricePosition([titled(title)], BRAND), null, title);

  assert.equal(findStatedPricePosition([titled('Is La Mer the luxury brand worth saving for?')], 'La Mer')?.tier, 'premium');
  const disagreeing = [cosmo, titled('Cetaphil, a luxury brand in some markets')];
  assert.equal(findStatedPricePosition(disagreeing, BRAND), null, 'titles that disagree establish nothing');
});

test('quotes must be about the brand: the rule behind "supported by a source"', () => {
  const far = `Here are some product recommendations in the budget category. ${'This paragraph talks about routines in general and names no brand at all. '.repeat(6)} Cetaphil is covered later.`;
  assert.equal(quoteIsAboutBrand({ quote: 'Here are some product recommendations in the budget category', title: 'Skincare basics', text: far, brand: BRAND, ownSite: false }), 'not_about_brand');
  const near = 'Here are some product recommendations in the budget category. Cetaphil Gentle Skin Cleanser is the first pick.';
  assert.equal(quoteIsAboutBrand({ quote: 'Here are some product recommendations in the budget category', title: 'Skincare basics', text: near, brand: BRAND, ownSite: false }), 'ok');
  assert.equal(quoteIsAboutBrand({ quote: 'more than 550 Galderma clinical studies', title: 'Cetaphil | Galderma', text: 'Backed by more than 550 Galderma clinical studies worldwide.', brand: BRAND, ownSite: false }), 'ok', 'the title names the brand');
  assert.equal(quoteIsAboutBrand({ quote: 'trusted for 75 years for sensitive skin', title: 'Our story', text: 'Our products have been trusted for 75 years for sensitive skin.', brand: BRAND, ownSite: true }), 'ok', "the brand's own site");
  assert.equal(quoteIsAboutBrand({ quote: 'words that are nowhere in the page', title: 'Cetaphil', text: 'Something else entirely.', brand: BRAND, ownSite: true }), 'not_found');
  assert.equal(passageAround('nowhere to be found in this text', 'A short text.'), null);
});

test('a luxury question is left out for a lower-priced brand only with evidence, and only when Gemini did not name the brand', () => {
  const questions = QUESTION_BANK.skincare;
  // 1. No source states the price position: nothing is excluded.
  const noEvidence: JobData = { questions, answers: answers(questions), labels: labels(null) };
  assert.equal(outOfRangeQuestions(BRAND, noEvidence).size, 0);
  assert.equal(computeCore(meta(), noEvidence).visibility.detail.counted, 8);

  // 2. An independent source says "drugstore": the luxury question (q8) is left out, the affordable one (q2) stays.
  const withEvidence: JobData = { questions, answers: answers(questions), labels: labels(budgetFromReview) };
  const excluded = outOfRangeQuestions(BRAND, withEvidence);
  assert.deepEqual([...excluded.keys()], ['q8']);
  assert.equal(excluded.get('q8')?.kind, 'price_tier');
  assert.ok(excluded.get('q8')?.reason.includes('I Tested Both Drugstore Skincare Brands'));
  assert.ok(excluded.get('q8')?.reason.includes('cosmopolitan.com'));
  const core = computeCore(meta(), withEvidence);
  assert.equal(core.visibility.detail.counted, 7);
  assert.equal(core.visibility.detail.rows.find((r) => r.questionId === 'q8')?.state, 'excluded');
  assert.equal(core.visibility.detail.rows.find((r) => r.questionId === 'q2')?.state, 'counted');

  // 3. Same evidence, but Gemini DID name the brand for the luxury question: it counts.
  const named: JobData = { questions, answers: answers(questions, ['q8']), labels: labels(budgetFromReview) };
  const namedCore = computeCore(meta(), named);
  assert.equal(namedCore.visibility.detail.rows.find((r) => r.questionId === 'q8')?.state, 'counted');
  assert.equal(namedCore.visibility.detail.counted, 8);

  // 4. The formula itself is untouched: one second-place answer out of seven counted questions.
  const scored: JobData = { questions, answers: answers(questions, ['q6']), labels: labels(budgetFromReview) };
  const metric = computeCore(meta(), scored).visibility.metric;
  assert.equal(metric.status === 'scored' ? metric.score : -1, Math.round((100 * 0.85) / 7));
});

test('the same rule in the other direction and in other categories', () => {
  const premiumFromSite: PricePosition = { tier: 'premium', origin: 'brand_site', evidenceId: 'S1', url: 'https://brand.example/about', domain: 'brand.example', quote: 'a luxury cookware house since 1925' };
  const siteAnalysis: JobData['siteAnalysis'] = { available: false, productLines: [], positioning: [], signatureClaim: null, relevance: [], coverage: [], pricePosition: premiumFromSite };
  const cookware: JobData = { questions: QUESTION_BANK.cookware, answers: answers(QUESTION_BANK.cookware), siteAnalysis };
  assert.deepEqual([...outOfRangeQuestions('Maison Cuivre', cookware).keys()], ['q2'], 'a premium brand is not judged on the "affordable" question');

  const custom = templateQuestions('running shoes');
  const customData: JobData = { questions: custom, answers: answers(custom), labels: labels(budgetFromReview) };
  assert.deepEqual([...outOfRangeQuestions(BRAND, customData).keys()], ['q3'], 'typed-in categories follow the same rule');
});

test('sources that disagree about price establish nothing', () => {
  const premiumFromSite: PricePosition = { tier: 'premium', origin: 'brand_site', evidenceId: 'S1', url: 'https://cetaphil.example', domain: 'cetaphil.example', quote: 'premium care' };
  const data: JobData = {
    questions: QUESTION_BANK.skincare,
    answers: answers(QUESTION_BANK.skincare),
    labels: labels(budgetFromReview),
    siteAnalysis: { available: false, productLines: [], positioning: [], signatureClaim: null, relevance: [], coverage: [], pricePosition: premiumFromSite },
  };
  assert.equal(establishedPricePosition(BRAND, data), null);
  assert.equal(outOfRangeQuestions(BRAND, data).size, 0);
});

test('a supported statement about price can establish the tier; an unsupported one cannot', () => {
  const claim = { id: 'k1', text: 'Products are priced in the budget category.', type: 'pricing', polarity: 'neutral' as const, origin: 'GP' };
  const source = { id: 'K1', kind: 'claim_source' as const, url: 'https://zennora.example/chart', domain: 'zennora.example', title: 'Budget chart', text: 'x', sourceUrl: 'https://zennora.example/chart' };
  const supported: JobData = { claims: { phase: 'done', sources: [source], claims: [{ ...claim, verdict: 'supported', evidenceId: 'K1', url: source.url, quote: 'Cetaphil sits firmly in the budget category' }] } };
  assert.deepEqual([establishedPricePosition(BRAND, supported)?.tier, establishedPricePosition(BRAND, supported)?.domain], ['budget', 'zennora.example']);
  const unverified: JobData = { claims: { phase: 'done', sources: [source], claims: [{ ...claim, verdict: 'unverified' }] } };
  assert.equal(establishedPricePosition(BRAND, unverified), null);
});

test('with no passage from the analysis, a source title that states the price tier is enough, and Gemini\'s own opinion never is', () => {
  const questions = QUESTION_BANK.skincare;
  const review = { id: 'R1', kind: 'review' as const, url: 'https://www.cosmopolitan.com/a', domain: 'cosmopolitan.com', title: 'CeraVe or Cetaphil? I Tested Both Drugstore Skincare Brands', text: 'I used both for a month.', sourceUrl: 'https://www.cosmopolitan.com/a' };
  const thread = { id: 'D1', kind: 'discussion' as const, url: 'https://reddit.com/r/x/1', domain: 'reddit.com', title: 'Cetaphil cleanser thoughts', text: 'It is fine.', sourceUrl: 'https://reddit.com/r/x/1' };
  const base: JobData = {
    questions,
    answers: answers(questions),
    // Gemini itself calls the brand "budget". That is its opinion, not evidence about the brand.
    profile: { recognized: true, description: 'Cetaphil is a skincare brand.', knownFor: [], products: [], pricePositioning: 'budget', officialDomain: 'cetaphil.com', strengths: [], criticisms: [], claims: [] },
    audience: { discussionsDone: true, reviewsDone: true, items: [thread], brandDomains: [] },
    labels: { ...labels(null), labels: [{ id: 'D1', relevant: true, voice: 'customer', sentiment: 'positive' }] },
  };
  assert.equal(establishedPricePosition(BRAND, base), null, "Gemini's own price label establishes nothing");
  assert.equal(outOfRangeQuestions(BRAND, base).size, 0);

  // The review is in the evidence and labeled as about the brand: its title states the tier.
  const withTitle: JobData = {
    ...base,
    audience: { discussionsDone: true, reviewsDone: true, items: [thread, review], brandDomains: [] },
    labels: { ...labels(null), labels: [{ id: 'D1', relevant: true, voice: 'customer', sentiment: 'positive' }, { id: 'R1', relevant: true, voice: 'publication', sentiment: 'positive' }] },
  };
  const position = establishedPricePosition(BRAND, withTitle);
  assert.deepEqual([position?.tier, position?.origin, position?.evidenceId, position?.domain], ['budget', 'independent_source', 'R1', 'cosmopolitan.com']);
  assert.deepEqual([...outOfRangeQuestions(BRAND, withTitle).keys()], ['q8'], 'the luxury question is left out, with the title as the stated evidence');

  // The same title on an item the analysis judged not to be about the brand is not used.
  const notRelevant: JobData = { ...withTitle, labels: { ...labels(null), labels: [{ id: 'R1', relevant: false, voice: 'publication', sentiment: 'neutral' }] } };
  assert.equal(establishedPricePosition(BRAND, notRelevant), null);

  // A page retrieved to check one of Gemini's statements counts as well, unless it is the brand's own.
  const checked = { id: 'K1', kind: 'claim_source' as const, url: 'https://beautyeditor.example/b', domain: 'beautyeditor.example', title: 'Why Cetaphil is still the best budget cleanser', text: 'x', sourceUrl: 'https://beautyeditor.example/b' };
  const fromClaimSource: JobData = { ...base, claims: { phase: 'done', sources: [checked], claims: [] } };
  assert.equal(establishedPricePosition(BRAND, fromClaimSource)?.evidenceId, 'K1');
});

test('the wording screen replaces the overclaiming phrasings it knows, and is not presented as catching all of them', () => {
  // The sentences from the first live report that prompted this rule.
  const flagged = [
    'the addition of ingredients like niacinamide which caused irritation and skin reactions',
    'Customers complain that the new formulation causes skin and eye irritation, leading to negative sentiment and damaged trust.',
    'Reduces negative customer feedback regarding skin reactions and rebuilds trust with users.',
    'Improves conversion and customer satisfaction for users with acne-prone skin.',
    'Ignoring reformulation backlash could alienate loyal customers.',
    'This points to a widespread ingredient safety issue.',
  ];
  for (const sentence of flagged) assert.equal(overclaims(sentence), true, sentence);
  const fine = [
    'Customers say the moisturiser stopped working because the pump jammed.', // "because" is not "cause"
    'Reviewers praise the moisture retention of the cream.',
    'Two customers report the money-back guarantee was slow to pay out.',
    'Two customers report irritation after a recent change to the cleanser.',
    'Some customers attribute their reaction to niacinamide.',
    'The site does not say which cleanser suits oily skin.',
  ];
  for (const sentence of fine) assert.equal(overclaims(sentence), false, sentence);

  // A cause is allowed only as something the customers themselves say, sentence by sentence.
  assert.equal(overclaims('Some customers say the recent reformulation caused irritation.'), false, 'attributed to the customers');
  assert.equal(overclaims('The recent reformulation caused irritation.'), true, "stated in the report's own voice");
  assert.equal(overclaims('Customers report irritation. The added niacinamide causes it.'), true, 'the second sentence asserts the cause');
  assert.equal(overclaims('Customers say it damaged their trust in the brand.'), true, 'a business outcome is never kept, attributed or not');

  assert.equal(asHypothesis('Rebuilds trust with loyal users.'), NEUTRAL_HYPOTHESIS);
  assert.equal(asHypothesis('Fewer complaints.'), NEUTRAL_HYPOTHESIS, 'not worded as a hypothesis');
  assert.equal(asHypothesis('If sales rise, the fix worked.'), NEUTRAL_HYPOTHESIS, 'a hypothesis about sales is still a claim about sales');
  const kept = 'If the page is added, a later audit could show the concern as answered on the site.';
  assert.equal(asHypothesis(kept), kept);
  assert.equal(withoutOverclaim('which caused irritation', '2 separate sources report this.'), '2 separate sources report this.');

  // Honest about its reach: these are unsupported causal claims in wordings the list does not
  // know, and they pass. The report therefore states that the screen is not comprehensive.
  assert.equal(overclaims('The new formula is behind the irritation.'), false);
  assert.equal(overclaims('Thanks to the reformulation, skin reactions are up.'), false);
  const questions = QUESTION_BANK.skincare;
  const stated = buildReport(meta(), { questions, answers: answers(questions), labels: labels(null) }).methodology.limitations;
  assert.ok(stated.some((line) => line.includes('does not detect every unsupported causal claim')), 'the report states the limit of the screen');
});

test('brand names are shown properly capitalised', () => {
  assert.equal(titleCaseBrand('cetaphil'), 'Cetaphil');
  assert.equal(titleCaseBrand('la roche-posay'), 'La Roche-Posay');
  assert.deepEqual(['h&m', "l'oreal", "paula's choice", 'e.l.f.', 'dr. jart+'].map(titleCaseBrand), ['H&M', "L'Oreal", "Paula's Choice", 'E.L.F.', 'Dr. Jart+']);
  assert.equal(mostCommonCasing('E.L.F.', ['e.l.f. is cheap', 'an e.l.f. haul', 'ELF']), 'e.l.f.', 'the finished report uses the spelling the sources use');
  assert.equal(casingLooksDeliberate('CeraVe'), true);
  assert.equal(casingLooksDeliberate('H&M'), true);
  assert.equal(casingLooksDeliberate('cetaphil'), false);
  assert.equal(casingLooksDeliberate('CETAPHIL'), false);

  const typedLower = validateAuditInput({ brand: 'cetaphil', category: 'skincare' });
  assert.ok(typedLower.ok);
  if (typedLower.ok) assert.deepEqual([typedLower.value.brand, typedLower.value.brandCasing, typedLower.value.cacheKey], ['Cetaphil', 'derived', 'skincare:cetaphil']);
  const typedCaps = validateAuditInput({ brand: 'CETAPHIL', category: 'skincare' });
  if (typedCaps.ok) assert.equal(typedCaps.value.brand, 'Cetaphil');
  const typedMixed = validateAuditInput({ brand: 'CeraVe', category: 'skincare' });
  if (typedMixed.ok) assert.deepEqual([typedMixed.value.brand, typedMixed.value.brandCasing], ['CeraVe', 'typed']);

  // The spelling the sources use wins over simple capitalisation, in both directions.
  assert.equal(mostCommonCasing('Cerave', ['CeraVe is a drugstore staple.', 'I tried CeraVe and Cetaphil', 'cerave review']), 'CeraVe');
  assert.equal(mostCommonCasing('E.l.f.', ['e.l.f. Cosmetics review', 'Why e.l.f. is everywhere', 'E.L.F. haul']), 'e.l.f.');
  assert.equal(mostCommonCasing('Cetaphil', ['A single Cetaphil mention']), null, 'one sighting is not enough to overrule');
});

test('the report uses the display spelling and never calls an unproven pattern observed', () => {
  const questions = QUESTION_BANK.skincare;
  const data: JobData = {
    questions,
    answers: answers(questions, ['q6']).map((a) => ({ ...a, answer: a.answer?.replace('Cetaphil', 'CETAPHIL') })),
    profile: { recognized: true, description: 'Cetaphil is a gentle skincare brand. Cetaphil is sold in drugstores.', knownFor: [], products: ['cleansers', 'moisturizers'], pricePositioning: 'budget', officialDomain: 'cetaphil.com', strengths: [], criticisms: [], claims: [] },
    labels: labels(null),
    site: { domain: 'cetaphil.com', pages: [], secondSearchDone: true },
    siteAnalysis: {
      available: true,
      productLines: ['Cleansers', 'Moisturisers', 'Sunscreen'].map((name) => ({ name, ref: { pageId: 'S1', url: 'https://cetaphil.com', quote: 'q' } })),
      positioning: [],
      signatureClaim: null,
      relevance: [],
      coverage: [],
      pricePosition: null,
    },
    signature: null,
    synthesis: { phase: 'done', insightsAvailable: true, disagreements: [], insights: [], fixesAvailable: true, fixes: [] },
    audience: { discussionsDone: true, reviewsDone: true, items: [], brandDomains: [] },
    youtube: { status: 'ok', videos: [], comments: [] },
  };
  const searches = [
    { purpose: 'Customer discussions', query: 'q', scope: 's', results: 10, kept: 0, credits: 1, ok: true },
    { purpose: 'Independent reviews, forums and publications', query: 'q', scope: 's', results: 10, kept: 0, credits: 1, ok: true },
  ];
  const report = buildReport(meta({ brand: 'Cetaphil', brandCasing: 'derived', searches }), data);
  assert.equal(report.brand, 'Cetaphil', 'the usual spelling, not the shouted one');
  assert.equal(report.model, 'gemini-3.5-flash-lite');

  const checks = new Map(report.betweenTheLines.map((c) => [c.id, c]));
  // Product-range recognition: counted from the list Gemini gave when asked what the brand sells.
  const rangeFor = (products: string[], lineNames = ['Cleansers', 'Moisturisers', 'Sunscreen'], recognized = true) => {
    const variant: JobData = {
      ...data,
      profile: data.profile ? { ...data.profile, recognized, products } : data.profile,
      siteAnalysis: data.siteAnalysis ? { ...data.siteAnalysis, productLines: lineNames.map((name) => ({ name, ref: { pageId: 'S1', url: 'https://cetaphil.com', quote: 'q' } })) } : data.siteAnalysis,
    };
    return buildReport(meta({ brand: 'Cetaphil', brandCasing: 'derived', searches }), variant).betweenTheLines.find((c) => c.id === 'narrow_range');
  };
  const range = checks.get('narrow_range');
  assert.deepEqual([range?.status, range?.basis], ['not_observed', 'computed'], 'two product types listed: not a single-product description');
  assert.ok(range?.observed?.includes('Gemini named 2 product types'));
  assert.ok(range?.observed?.includes('does not show that every line is recognised'), 'the limit of the comparison is stated');
  // The two lists are named separately and never mixed: what Gemini says, and what the site shows.
  assert.ok(range?.observed?.startsWith('Two separate lists are set side by side here and never merged.'));
  assert.ok(range?.observed?.includes("Gemini's list:") && range?.observed?.includes("The site's range: 3 product lines were found on the pages read from cetaphil.com"));
  assert.equal(range?.evidence[0].label, "Gemini's list (what the model says Cetaphil sells; not checked against the site): cleansers, moisturizers");
  assert.deepEqual(range?.evidence.slice(1).map((e) => e.label), ['Found on cetaphil.com: Cleansers', 'Found on cetaphil.com: Moisturisers', 'Found on cetaphil.com: Sunscreen']);
  assert.ok(range?.evidence.slice(1).every((e) => e.url && e.quote), 'every site line carries its page and its quote');
  // A product only Gemini names never appears in the site's range, and a site line Gemini omits is not added to Gemini's list.
  const onlyGemini = rangeFor(['Perfume', 'Cleansers']);
  assert.ok(!onlyGemini?.evidence.some((e) => e.label.startsWith('Found on') && e.label.includes('Perfume')));
  assert.ok(!onlyGemini?.evidence[0].label.includes('Sunscreen'));
  const oneProduct = rangeFor(['Gentle Skin Cleanser']);
  assert.deepEqual([oneProduct?.status, oneProduct?.strength, oneProduct?.basis], ['observed', 'established', 'computed']);
  assert.ok(oneProduct?.observed?.includes('Gemini named one product type (Gentle Skin Cleanser)'));
  const longRange = rangeFor(['Cleansers', 'Creams'], ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(longRange?.evidence.length, 7, "Gemini's list, five site lines, and a line saying two more exist");
  assert.ok(longRange?.evidence[6].label.includes('2 more product lines'));
  assert.equal(rangeFor([])?.status, 'cannot_assess', 'no list from Gemini, so no evidence either way');
  assert.ok(rangeFor([])?.reason?.includes('no evidence of how much of the range it recognises'));
  assert.equal(rangeFor(['Cleansers'], ['Cleansers', 'Moisturisers'])?.status, 'cannot_assess', 'too few verified lines to compare with');
  assert.equal(rangeFor(['Cleansers'], undefined, false)?.status, 'cannot_assess', 'a brand Gemini does not recognise has no list');
  assert.equal(rangeFor(['Cleanser', 'cleanser ', ''])?.status, 'observed', 'repeats and blanks are not counted as extra products');

  const footprint = checks.get('source_footprint');
  assert.equal(footprint?.status, 'cannot_assess');
  assert.ok(footprint?.reason?.includes('thin footprint'), 'absence from the searches is reported as what it is');
  assert.ok(!report.betweenTheLines.some((c) => c.id === 'source_footprint' && c.status !== 'cannot_assess'));

  // Nothing in the fixed interpretation text promises a business outcome.
  for (const check of report.betweenTheLines) {
    const text = `${check.whyItMatters ?? ''} ${check.implication ?? ''}`;
    assert.ok(!/costs sales|damages trust|steered elsewhere|will increase|boost/i.test(text), `${check.id}: no causal or commercial claim`);
  }
  assert.ok(report.methodology.limitations.some((l) => l.includes('hypotheses to test')));
});
