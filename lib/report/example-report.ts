// The example report shown at /example. EVERYTHING here is invented: the brand, the competitors,
// the quotes, the sources and the numbers. It exists so visitors can see what a report contains
// without spending any API quota. Replace it with a real audit once one has been run and checked.
//
// The numbers are internally consistent with the scoring formulas:
//   visibility  = 100 × (0 + 0.70 + 0.85 + 0 + 0.20 + 1.00 + 0) ÷ 7 = 39
//   perception  = 100 × (12 + 0.5 × 4) ÷ 19.5 = 72   (weighted counts)
//   content gap = 100 × (4 × 1.0 + 3 × 0.5) ÷ 9 = 61

import type { EvidenceItem, GeminiAnswer, Report } from '../types';

const BRAND = 'Northmere Skin';
const SITE = 'northmere-skin.example';

function answer(n: number, intent: string, question: string, text: string, brands: [string, string][]): GeminiAnswer {
  return {
    id: `G${n}`,
    questionId: `q${n}`,
    question,
    intent,
    status: 'answered',
    answer: text,
    recommendations: brands.map(([brand, why]) => ({ brand, why })),
    alsoMentioned: [],
    model: 'illustrative-model',
    askedAt: '2026-11-14T15:00:00.000Z',
  };
}

const ANSWERS: GeminiAnswer[] = [
  answer(1, 'best overall', 'What are the best skincare brands right now?', 'For most people I would start with Ovalis Labs, Kindra & Co and Sollune. Ovalis Labs is the reliable all-rounder, Kindra & Co is strong on barrier repair, and Sollune is the one to pick for sun care.', [
    ['Ovalis Labs', 'A reliable all-rounder with a wide range.'],
    ['Kindra & Co', 'Strong on barrier repair.'],
    ['Sollune', 'The pick for sun care.'],
  ]),
  answer(2, 'value', 'Which affordable skincare brands actually work?', 'Ovalis Labs and Kindra & Co give the most for the money. Northmere Skin is also worth a look for its oat cleanser, which is inexpensive and gentle.', [
    ['Ovalis Labs', 'Most products are low priced and well formulated.'],
    ['Kindra & Co', 'Good basics at a fair price.'],
    [BRAND, 'Its oat cleanser is inexpensive and gentle.'],
  ]),
  answer(3, 'sensitive skin', 'What skincare brands are best for sensitive skin?', 'Kindra & Co is my first suggestion for sensitive skin, followed by Northmere Skin, whose fragrance-free oat cleanser suits reactive skin, and then Ovalis Labs.', [
    ['Kindra & Co', 'Formulated around barrier repair.'],
    [BRAND, 'Its fragrance-free oat cleanser suits reactive skin.'],
    ['Ovalis Labs', 'Has a dedicated gentle line.'],
  ]),
  answer(4, 'acne', 'Which skincare brands do you recommend for acne-prone skin?', 'Ovalis Labs and Sollune both have well-regarded options for acne-prone skin.', [
    ['Ovalis Labs', 'Offers proven actives at several strengths.'],
    ['Sollune', 'Light textures that do not clog pores.'],
  ]),
  answer(5, 'anti-aging', 'What are the best skincare brands for anti-aging?', 'Ovalis Labs and Sollune lead here, with strong retinoid and sun-care ranges respectively.', [
    ['Ovalis Labs', 'A full retinoid range.'],
    ['Sollune', 'Daily sun care is the best anti-aging step.'],
  ]),
  {
    ...answer(6, 'expert trust', 'Which skincare brands do dermatologists recommend most?', 'Dermatologists most often point to Kindra & Co and Ovalis Labs. Northmere Skin comes up occasionally, though it is less established.', [
      ['Kindra & Co', 'Frequently suggested for compromised skin.'],
      ['Ovalis Labs', 'Evidence-led formulas.'],
    ]),
    alsoMentioned: [{ brand: BRAND, stance: 'neutral' }],
  },
  answer(7, 'clean and fragrance-free', 'What are the best clean or fragrance-free skincare brands?', 'Northmere Skin is the first one I would look at: its whole range is fragrance-free. Kindra & Co is a good second choice.', [
    [BRAND, 'Its whole range is fragrance-free.'],
    ['Kindra & Co', 'Most products are fragrance-free.'],
  ]),
  answer(8, 'premium', 'Which luxury skincare brands are worth the money?', 'At the premium end, Sollune justifies its prices best, with Ovalis Labs offering a more affordable route to similar results.', [
    ['Sollune', 'Elegant textures and strong sun care.'],
    ['Ovalis Labs', 'A cheaper route to similar results.'],
  ]),
];

function item(id: string, kind: EvidenceItem['kind'], domain: string, title: string, text: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  const url = `https://${domain}/illustrative/${id.toLowerCase()}`;
  return { id, kind, url, domain, title, text, sourceUrl: url, ...extra };
}

const EVIDENCE: EvidenceItem[] = [
  item('D1', 'discussion', 'reddit.com', 'Northmere oat cleanser, six months in', 'Finally a cleanser that does not sting. I have rosacea and the oat cleanser is the only thing I have repurchased three times.'),
  item('D2', 'discussion', 'reddit.com', 'Is Northmere worth it?', 'Love the cleanser, but the pump on the moisturiser broke after two weeks and support took ten days to reply.'),
  item('D3', 'discussion', 'reddit.com', 'Fragrance-free routine help', 'Northmere is genuinely fragrance-free, which is rare. Shipping took almost three weeks though.'),
  item('R1', 'review', 'skinjournal.example', 'Northmere Skin review: gentle, but slow to arrive', 'The formulas are gentle and well priced. Our order took 18 days to arrive and the tracking link never updated.'),
  item('R2', 'review', 'beautydesk.example', 'The best fragrance-free cleansers we tested', 'Northmere Skin Oat Cleanser was the gentlest of the twelve we tried. We may earn a commission from links on this page.', { sponsored: ['earns commission'] }),
  item('V1', 'youtube_video', 'youtube.com', 'Northmere Skin: honest review after 30 days', 'Northmere Skin: honest review after 30 days. This video is sponsored by Northmere Skin. Use my code for 15% off.', {
    channel: 'Illustrative Creator',
    sponsored: ['YouTube paid-promotion flag', 'states it is sponsored', 'discount code'],
  }),
  item('C1', 'youtube_comment', 'youtube.com', 'Comment on "Northmere Skin: honest review after 30 days"', 'Bought the cleanser because of sensitive skin and it has been great, but why does delivery take so long?', { likeCount: 41 }),
  item('C2', 'youtube_comment', 'youtube.com', 'Comment on "Northmere Skin: honest review after 30 days"', 'Their pumps always break. Product is good, packaging is not.', { likeCount: 17 }),
  item('S1', 'site_page', SITE, 'Northmere Skin: fragrance-free skincare', 'Every Northmere product is fragrance-free. Gentle cleansers, moisturisers and a mineral sunscreen for reactive skin.'),
  item('S2', 'site_page', SITE, 'Shipping and returns', 'Orders ship fast, straight from our studio.'),
  item('S3', 'site_page', SITE, 'Oat Cleanser', 'Our oat cleanser is made for sensitive and reactive skin.'),
  item('K1', 'claim_source', 'skinjournal.example', 'Northmere Skin discontinues its vitamin C serum', 'Northmere Skin confirmed it discontinued the Bright C serum in March and has no plans to replace it.'),
];

export const EXAMPLE_REPORT: Report = {
  version: 2,
  id: 'example',
  illustrative: true,
  brand: BRAND,
  brandKey: 'northmere-skin',
  category: { id: 'skincare', label: 'Skincare' },
  createdAt: '2026-11-14T15:04:00.000Z',
  model: 'illustrative-model',
  tier: 'full',
  overallConfidence: { status: 'stated', level: 'medium', limitedBy: 'Gemini API recommendation visibility' },
  visibility: {
    metric: {
      status: 'scored',
      score: 39,
      confidence: 'medium',
      confidenceReason: "7 of 8 questions counted, covering 7 different shopper intents; 1 excluded as outside the brand's range. One Gemini run per question.",
    },
    detail: {
      planned: 8,
      answered: 8,
      failed: 0,
      excluded: 1,
      counted: 7,
      creditSum: 2.75,
      appearances: 4,
      averagePosition: 2,
      rows: [
        { answerId: 'G1', questionId: 'q1', question: ANSWERS[0].question, intent: 'best overall', state: 'counted', placement: { kind: 'absent' }, credit: 0, topBrands: ['Ovalis Labs', 'Kindra & Co', 'Sollune'] },
        { answerId: 'G2', questionId: 'q2', question: ANSWERS[1].question, intent: 'value', state: 'counted', placement: { kind: 'recommended', position: 3 }, credit: 0.7, topBrands: ['Ovalis Labs', 'Kindra & Co', BRAND], why: 'Its oat cleanser is inexpensive and gentle.' },
        { answerId: 'G3', questionId: 'q3', question: ANSWERS[2].question, intent: 'sensitive skin', state: 'counted', placement: { kind: 'recommended', position: 2 }, credit: 0.85, topBrands: ['Kindra & Co', BRAND, 'Ovalis Labs'], why: 'Its fragrance-free oat cleanser suits reactive skin.' },
        { answerId: 'G4', questionId: 'q4', question: ANSWERS[3].question, intent: 'acne', state: 'counted', placement: { kind: 'absent' }, credit: 0, topBrands: ['Ovalis Labs', 'Sollune'] },
        { answerId: 'G5', questionId: 'q5', question: ANSWERS[4].question, intent: 'anti-aging', state: 'excluded', placement: { kind: 'absent' }, topBrands: ['Ovalis Labs', 'Sollune'], exclusionReason: `The site lists no anti-aging products. ${SITE} shows these product lines: cleansers, moisturisers, mineral sunscreen.` },
        { answerId: 'G6', questionId: 'q6', question: ANSWERS[5].question, intent: 'expert trust', state: 'counted', placement: { kind: 'mentioned' }, credit: 0.2, topBrands: ['Kindra & Co', 'Ovalis Labs'] },
        { answerId: 'G7', questionId: 'q7', question: ANSWERS[6].question, intent: 'clean and fragrance-free', state: 'counted', placement: { kind: 'recommended', position: 1 }, credit: 1, topBrands: [BRAND, 'Kindra & Co'], why: 'Its whole range is fragrance-free.' },
        { answerId: 'G8', questionId: 'q8', question: ANSWERS[7].question, intent: 'premium', state: 'counted', placement: { kind: 'absent' }, credit: 0, topBrands: ['Sollune', 'Ovalis Labs'] },
      ],
    },
  },
  brandProfile: {
    recognized: true,
    description: 'Northmere Skin is a small fragrance-free skincare brand best known for its oat cleanser. It also sells a vitamin C serum called Bright C. Customers often mention slow shipping.',
    knownFor: ['Oat cleanser', 'Fragrance-free formulas'],
    products: ['Cleansers', 'Vitamin C serum'],
    pricePositioning: 'mid',
    officialDomain: SITE,
    strengths: ['Gentle formulas', 'Fair prices'],
    criticisms: ['Slow shipping'],
    claims: [],
    model: 'illustrative-model',
  },
  signatureAnswer: {
    id: 'GS',
    questionId: 'signature',
    question: 'Which skincare brands are best known for fragrance-free formulas for reactive skin?',
    intent: 'signature claim',
    status: 'answered',
    answer: 'Kindra & Co is the best-known name for fragrance-free formulas aimed at reactive skin, followed by Northmere Skin and Ovalis Labs.',
    recommendations: [
      { brand: 'Kindra & Co', why: 'The best-known name for reactive skin.' },
      { brand: BRAND, why: 'A fully fragrance-free range.' },
      { brand: 'Ovalis Labs', why: 'Has a gentle line.' },
    ],
    alsoMentioned: [],
    model: 'illustrative-model',
  },
  answers: ANSWERS,
  perception: {
    metric: {
      status: 'scored',
      score: 72,
      confidence: 'medium',
      confidenceReason: '23 counted opinions, drawn from 9 unique sources (threads, pages or videos) on 4 websites. Voices heard: customer, creator, publication.',
    },
    detail: {
      itemsRetrieved: 31,
      itemsLabeled: 31,
      raw: { positive: 14, mixed: 5, negative: 4, counted: 23, neutral: 4, irrelevant: 3, brandCreated: 1 },
      weighted: { positive: 12, mixed: 4, negative: 3.5, total: 19.5 },
      uniqueSources: 9,
      sourcesAboutBrand: 10,
      uniqueDomains: ['beautydesk.example', 'reddit.com', 'skinjournal.example', 'youtube.com'],
      sourceTypes: ['customer', 'creator', 'publication'],
      byVoice: { customer: 16, creator: 4, publication: 3, unclear: 0 },
      voiceScores: { customer: 72, creator: null, publication: null },
      sponsoredItems: [
        { evidenceId: 'V1', signals: ['YouTube paid-promotion flag', 'states it is sponsored', 'discount code'] },
        { evidenceId: 'R2', signals: ['earns commission'] },
      ],
      sample: {
        read: { discussions: 8, reviews: 6, videos: 1, comments: 16 },
        aboutBrand: { discussions: 7, reviews: 6, videos: 1, comments: 14 },
        counted: { discussions: 6, reviews: 6, videos: 1, comments: 10 },
      },
    },
    praise: [
      { label: 'Gentle on reactive skin', summary: 'Three sources with sensitive or reactive skin say the oat cleanser does not sting or cause flare-ups for them.', evidenceIds: ['D1', 'C1', 'R2'], quote: { evidenceId: 'D1', text: 'Finally a cleanser that does not sting.' }, itemCount: 3, sourceCount: 3, scope: 'product', product: 'Oat Cleanser' },
      { label: 'Truly fragrance-free', summary: 'Two sources value that the whole range is fragrance-free, which they describe as rare.', evidenceIds: ['D3', 'R2'], itemCount: 2, sourceCount: 2, scope: 'brand' },
    ],
    complaints: [
      { label: 'Slow shipping', summary: 'Three sources report their orders taking two to three weeks to arrive, with poor tracking.', evidenceIds: ['D3', 'R1', 'C1'], quote: { evidenceId: 'R1', text: 'Our order took 18 days to arrive' }, itemCount: 3, sourceCount: 3, scope: 'brand' },
      { label: 'Pumps break', summary: 'Two buyers report the pump on the moisturiser failing within weeks of use.', evidenceIds: ['D2', 'C2'], quote: { evidenceId: 'C2', text: 'Their pumps always break.' }, itemCount: 2, sourceCount: 2, scope: 'product', product: 'moisturiser' },
    ],
    concerns: [
      { id: 'c1', label: 'How long does delivery take?', evidenceIds: ['D3', 'C1'] },
      { id: 'c2', label: 'What happens if the pump breaks?', evidenceIds: ['D2', 'C2'] },
    ],
    advocacy: [{ evidenceId: 'D1', note: 'A customer with rosacea says it is the only cleanser they have repurchased three times.' }],
    creatorVsCustomer: 'The sponsored creator video is uniformly positive, while customers praise the cleanser but raise delivery and packaging problems the video does not mention.',
    themesNote: 'A theme is listed only when at least two separate items of evidence show it, which is why fewer than three may appear.',
  },
  contentGap: {
    metric: {
      status: 'scored',
      score: 61,
      confidence: 'high',
      confidenceReason: '9 pages read across 3 site sections; 9 checklist items. Based on pages a search surfaced, not a full crawl.',
    },
    detail: {
      domain: SITE,
      pagesRead: 9,
      sections: ['home', 'pages', 'products'],
      points: 5.5,
      checklist: [
        { id: 'q1', source: 'category_question', text: ANSWERS[0].question, level: 'none', geminiNamedBrand: false },
        { id: 'q2', source: 'category_question', text: ANSWERS[1].question, level: 'partial', url: `https://${SITE}/illustrative/s3`, quote: 'Our oat cleanser is made for sensitive and reactive skin.', geminiNamedBrand: true },
        { id: 'q3', source: 'category_question', text: ANSWERS[2].question, level: 'clear', url: `https://${SITE}/illustrative/s3`, quote: 'Our oat cleanser is made for sensitive and reactive skin.', geminiNamedBrand: true },
        { id: 'q4', source: 'category_question', text: ANSWERS[3].question, level: 'none', geminiNamedBrand: false },
        { id: 'q6', source: 'category_question', text: ANSWERS[5].question, level: 'none', geminiNamedBrand: true },
        { id: 'q7', source: 'category_question', text: ANSWERS[6].question, level: 'clear', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.', geminiNamedBrand: true },
        { id: 'q8', source: 'category_question', text: ANSWERS[7].question, level: 'partial', downgraded: true, geminiNamedBrand: false },
        { id: 'c1', source: 'customer_concern', text: 'How long does delivery take?', level: 'partial', url: `https://${SITE}/illustrative/s2`, quote: 'Orders ship fast, straight from our studio.' },
        { id: 'c2', source: 'customer_concern', text: 'What happens if the pump breaks?', level: 'none' },
      ],
      excluded: [{ questionId: 'q5', question: ANSWERS[4].question, kind: 'product_range', reason: `The site lists no anti-aging products. ${SITE} shows these product lines: cleansers, moisturisers, mineral sunscreen.` }],
      productLines: [
        { name: 'Cleansers', ref: { pageId: 'S3', url: `https://${SITE}/illustrative/s3`, quote: 'Our oat cleanser is made for sensitive and reactive skin.' } },
        { name: 'Moisturisers', ref: { pageId: 'S1', url: `https://${SITE}/illustrative/s1`, quote: 'Gentle cleansers, moisturisers and a mineral sunscreen' } },
        { name: 'Mineral sunscreen', ref: { pageId: 'S1', url: `https://${SITE}/illustrative/s1`, quote: 'Gentle cleansers, moisturisers and a mineral sunscreen' } },
      ],
      positioning: [
        { statement: 'Every product is fragrance-free and made for reactive skin.', ref: { pageId: 'S1', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.' } },
        { statement: 'Orders ship fast.', ref: { pageId: 'S2', url: `https://${SITE}/illustrative/s2`, quote: 'Orders ship fast, straight from our studio.' } },
      ],
      signatureClaim: { claim: 'fragrance-free formulas for reactive skin', ref: { pageId: 'S1', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.' } },
      pricePosition: null,
    },
  },
  claims: [
    { id: 'k1', text: 'It also sells a vitamin C serum called Bright C.', type: 'availability', polarity: 'neutral', origin: 'GP', verdict: 'contradicted', evidenceId: 'K1', url: 'https://skinjournal.example/illustrative/k1', quote: 'it discontinued the Bright C serum in March', note: 'A source says this product was discontinued.' },
    { id: 'k2', text: 'Northmere Skin is a fragrance-free skincare brand.', type: 'product', polarity: 'positive', origin: 'GP', verdict: 'supported', evidenceId: 'S1', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.' },
    { id: 'k3', text: 'Dermatologists occasionally recommend it.', type: 'reputation', polarity: 'positive', origin: 'G6', verdict: 'unverified', note: 'The sources retrieved do not address this.' },
  ],
  competitors: {
    note: 'Competitors are the brands Gemini recommended most across the same questions. Their sentiment comes from one search each, a lighter sample than the audited brand received. Content coverage is not measured for competitors in V1, and nothing is estimated in its place.',
    rows: [
      { name: BRAND, isAuditedBrand: true, visibility: { status: 'scored', score: 39, confidence: 'medium', confidenceReason: '7 questions counted.' }, appearances: 4, sentiment: { status: 'scored', score: 72, confidence: 'medium', confidenceReason: '23 counted opinions.' }, sentimentSample: 23, contentCoverage: { status: 'not_measured', reason: 'See the content gap section for the audited brand.' } },
      { name: 'Ovalis Labs', isAuditedBrand: false, visibility: { status: 'scored', score: 77, confidence: 'medium', confidenceReason: 'Same formula over the same counted questions as the audited brand.' }, appearances: 6, sentiment: { status: 'scored', score: 66, confidence: 'low', confidenceReason: '9 counted opinions from 5 sources across 3 unique domains.' }, sentimentSample: 9, contentCoverage: { status: 'not_measured', reason: 'Competitor content coverage is not measured in V1.' } },
      { name: 'Kindra & Co', isAuditedBrand: false, visibility: { status: 'scored', score: 65, confidence: 'medium', confidenceReason: 'Same formula over the same counted questions as the audited brand.' }, appearances: 5, sentiment: { status: 'scored', score: 81, confidence: 'low', confidenceReason: '8 counted opinions from 4 sources across 3 unique domains.' }, sentimentSample: 8, contentCoverage: { status: 'not_measured', reason: 'Competitor content coverage is not measured in V1.' } },
      { name: 'Sollune', isAuditedBrand: false, visibility: { status: 'scored', score: 36, confidence: 'medium', confidenceReason: 'Same formula over the same counted questions as the audited brand.' }, appearances: 3, sentiment: { status: 'insufficient', reason: 'Only 5 usable opinions about the brand were found (at least 8 are needed).' }, sentimentSample: 5, contentCoverage: { status: 'not_measured', reason: 'Competitor content coverage is not measured in V1.' } },
    ],
  },
  disconnect: {
    status: 'assessed',
    direction: 'ai_under',
    gap: -33,
    headline: 'People rate this brand better than Gemini recommends it: audience perception is 72, Gemini API recommendation visibility is 39.',
    disagreements: [
      { title: 'Two customers call it their go-to; Gemini names a competitor first', kind: 'opportunity', audienceSays: 'Two customers with reactive skin describe the oat cleanser as the one they keep repurchasing.', geminiSays: 'For sensitive skin Gemini names Kindra & Co first and Northmere Skin second, and omits it from "best overall".', implication: 'The customer accounts found here may not be reaching the general recommendations. Two accounts are too few to say more.', audienceEvidenceIds: ['D1', 'C1'], geminiEvidenceIds: ['G3', 'G1'], audienceSourceCount: 2 },
      { title: "Packaging complaints do not appear in Gemini's description", kind: 'risk', audienceSays: 'Two buyers report the moisturiser pump breaking within weeks.', geminiSays: 'Gemini lists slow shipping as the only criticism and does not mention packaging.', implication: 'Worth keeping an eye on. Two reports do not show how common this is.', audienceEvidenceIds: ['D2', 'C2'], geminiEvidenceIds: ['GP'], audienceSourceCount: 2 },
    ],
  },
  betweenTheLines: [
    { id: 'signature_claim', title: "Does Gemini recommend a competitor for the brand's signature claim?", status: 'observed', basis: 'computed', strength: 'established', observed: 'The brand\'s site leads with "fragrance-free formulas for reactive skin". Asked which skincare brands are best known for that, Gemini\'s first recommendation was Kindra & Co; Northmere Skin was recommended, position 2. This is one answer from one model, asked once.', evidence: [{ id: 'S1', label: 'Brand site states: "fragrance-free formulas for reactive skin"', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.' }, { id: 'GS', label: 'Gemini, asked: "Which skincare brands are best known for fragrance-free formulas for reactive skin?"', quote: 'Kindra & Co is the best-known name for fragrance-free formulas aimed at reactive skin' }], whyItMatters: 'In this answer a competitor was named first for the claim the brand leads with on its own site.', implication: 'If "fragrance-free formulas for reactive skin" were stated plainly in places other than Northmere Skin\'s own site, such as independent reviews and comparisons, a later audit could show whether Gemini\'s answer changes. This audit did not test that.' },
    { id: 'complaint_as_fact', title: 'Does Gemini repeat an online complaint as established fact?', status: 'observed', basis: 'ai_interpretation', strength: 'tentative', statusLabel: 'Possible pattern, limited evidence', observed: 'Gemini says customers often mention slow shipping, as a general fact about the brand. In the evidence it appears as three individual delivery complaints. The complaint is reported by 3 customer or reviewer sources of the 9 read.', evidence: [{ id: 'GP', label: "Gemini's own description of the brand", quote: 'Customers often mention slow shipping.' }, { id: 'R1', label: 'Article or review on skinjournal.example: Northmere Skin review', url: 'https://skinjournal.example/illustrative/r1', quote: 'Our order took 18 days to arrive and the tracking link never updated.' }, { id: 'D3', label: 'Community discussion on reddit.com: Fragrance-free routine help', url: 'https://reddit.com/illustrative/d3', quote: 'Shipping took almost three weeks though.' }], whyItMatters: 'Gemini words a handful of delivery complaints as something customers often say.', implication: 'If delivery times are published and current, a later audit could show whether Gemini still describes shipping this way.' },
    { id: 'outdated_details', title: 'Does Gemini describe discontinued, outdated or incorrect details?', status: 'observed', basis: 'ai_interpretation', strength: 'established', observed: 'Gemini stated: "It also sells a vitamin C serum called Bright C." A retrieved source says otherwise.', evidence: [{ id: 'GP', label: "Gemini's own description of the brand", quote: 'It also sells a vitamin C serum called Bright C.' }, { id: 'K1', label: 'Source contradicting: "It also sells a vitamin C serum called Bright C."', url: 'https://skinjournal.example/illustrative/k1', quote: 'it discontinued the Bright C serum in March' }], whyItMatters: 'A shopper relying on this answer would be given a detail that a retrieved source contradicts.', implication: "Check which version is current. If the source is right, stating the correct detail plainly on the brand's own pages is a reasonable first step. This audit cannot show whether that would change Gemini's answer." },
    { id: 'narrow_range', title: 'Is the brand known to Gemini for one product while its wider range is ignored?', status: 'not_observed', basis: 'computed', observed: "Two separate lists are set side by side here and never merged. Gemini's list: asked what Northmere Skin sells, Gemini named 2 product types. The site's range: 3 product lines were found on the pages read from northmere-skin.example, each confirmed by a quote from a page. Gemini named more than one, so this answer does not describe the brand through a single product. The lists are not matched item by item (Gemini names types of product in its own words, while the site list uses the names on the pages), so this does not show that every line is recognised.", evidence: [{ id: 'GP', label: "Gemini's list (what the model says Northmere Skin sells; not checked against the site): Cleansers, Vitamin C serum" }, { id: 'S3', label: 'Found on northmere-skin.example: Cleansers', url: `https://${SITE}/illustrative/s3`, quote: 'Our oat cleanser is made for sensitive and reactive skin.' }, { id: 'S1', label: 'Found on northmere-skin.example: Moisturisers', url: `https://${SITE}/illustrative/s1`, quote: 'Gentle cleansers, moisturisers and a mineral sunscreen' }, { id: 'S1', label: 'Found on northmere-skin.example: Mineral sunscreen', url: `https://${SITE}/illustrative/s1`, quote: 'Gentle cleansers, moisturisers and a mineral sunscreen' }] },
    { id: 'volume_vs_visibility', title: 'Is there a mismatch between how much people discuss the brand and how often Gemini recommends it?', status: 'not_observed', basis: 'computed', observed: 'Visibility is 39 with 16 customer opinions found: neither mismatch threshold was met (15+ customer opinions with visibility under 25, or visibility 60+ with fewer than 8 counted opinions).', evidence: [{ id: 'visibility', label: 'Gemini API recommendation visibility: 39 (7 questions counted)' }, { id: 'discussion', label: '16 customer opinions and 23 counted opinions in total, from 9 unique sources' }] },
    { id: 'source_footprint', title: 'Is the brand missing from sources that AI and search rely on?', status: 'cannot_assess', basis: 'computed', reason: 'This audit cannot tell which sources Gemini relies on: its answers here carry no citations, and web search was switched off. What it did measure is where Northmere Skin is publicly discussed, shown below. Being present in those places does not show that Gemini draws on them.', evidence: [{ id: 'footprint1', label: 'Measured: Reddit-indexed threads naming the brand: 3' }, { id: 'footprint2', label: 'Measured: Independent sites with a page naming the brand: 2' }, { id: 'footprint3', label: 'Measured: YouTube videos naming the brand: 1' }] },
    { id: 'positioning_contradiction', title: "Does the brand's positioning contradict what customers experience?", status: 'observed', basis: 'ai_interpretation', strength: 'tentative', statusLabel: 'Potential tension, limited evidence', observed: 'The site says orders ship fast, while three sources report waiting two to three weeks. This rests on 3 customer or reviewer sources of the 9 read, so it is a potential tension, not a verified contradiction.', evidence: [{ id: 'S2', label: 'Brand site states: "Orders ship fast."', url: `https://${SITE}/illustrative/s2`, quote: 'Orders ship fast, straight from our studio.' }, { id: 'D3', label: 'Community discussion on reddit.com: Fragrance-free routine help', url: 'https://reddit.com/illustrative/d3', quote: 'Shipping took almost three weeks though.' }, { id: 'R1', label: 'Article or review on skinjournal.example: Northmere Skin review', url: 'https://skinjournal.example/illustrative/r1', quote: 'Our order took 18 days to arrive and the tracking link never updated.' }], whyItMatters: "The brand's own site makes a promise that some customers in this sample say their experience did not match.", implication: 'Read the cited reports before acting on this, and check whether they concern one product or a recent change. This audit cannot show how common the experience is among all customers.' },
  ],
  fixes: [
    { action: 'Publish real delivery times on the shipping page, and check whether "ships fast" matches current delivery.', why: 'Three sources report slow delivery, and the site says orders ship fast.', priority: 1, effort: 'Low', expectedImpact: 'If delivery times are stated plainly, a later audit could show fewer sources reporting surprise at slow delivery.', evidenceIds: ['S2', 'R1', 'D3', 'C1', 'GP'], evidenceBase: "3 customer or reviewer sources, 1 Gemini answer, 1 page of the brand's own site" },
    { action: 'State on the site that Bright C is discontinued and say what replaced it, if anything.', why: 'Gemini still describes the brand as selling it, and a retrieved source says it was discontinued.', priority: 2, effort: 'Low', expectedImpact: 'If the site states this, a later audit could show whether Gemini still describes the product as available.', evidenceIds: ['GP', 'K1'], evidenceBase: '1 Gemini answer, 1 other web source' },
    { action: 'Create a page answering "best skincare for sensitive skin" that uses the oat cleanser evidence.', why: 'One customer calls the cleanser their repeat purchase, and Gemini named a competitor first for the same need.', priority: 3, effort: 'Medium', expectedImpact: 'If the claim is stated plainly on more pages, a later audit could show whether Gemini names the brand earlier for this question.', evidenceIds: ['D1', 'G3', 'GS'], evidenceBase: '1 customer or reviewer source, 2 Gemini answers' },
    { action: 'Add a page on what to do if a pump fails, and look into the two reports.', why: 'Two customers report pumps failing, and the site does not address it.', priority: 4, effort: 'Medium', expectedImpact: 'If the page exists, a later audit could show this concern as answered on the site.', evidenceIds: ['D2', 'C2'], evidenceBase: '2 customer or reviewer sources' },
  ],
  fixesNote: "Only 4 recommendations passed this audit's rules, so only those are shown. A recommendation must cite evidence found in this audit and must not assert a cause or a business result.",
  evidence: EVIDENCE,
  methodology: {
    auditedAt: '2026-11-14T15:04:00.000Z',
    model: 'illustrative-model',
    modelConfigured: 'illustrative-model',
    modelNote: 'In a real report this line names the Gemini model the site is configured to use and explains why, from the limits of its free tier.',
    questionBankVersion: '2026-11-14',
    tier: 'full',
    questions: { planned: 8, answered: 8, failed: 0, excluded: 1, counted: 7 },
    searches: [
      { purpose: 'Customer discussions', query: '(illustrative)', scope: 'reddit.com, as indexed by Tavily', results: 10, kept: 3, credits: 1, ok: true },
      { purpose: 'Independent reviews, forums and publications', query: '(illustrative)', scope: 'open web, excluding social platforms and the brand site', results: 10, kept: 2, credits: 1, ok: true },
      { purpose: "The brand's own site: products", query: '(illustrative)', scope: SITE, results: 8, kept: 6, credits: 1, ok: true },
      { purpose: "The brand's own site: guides, FAQ and blog", query: '(illustrative)', scope: SITE, results: 5, kept: 3, credits: 1, ok: true },
      { purpose: 'Checking a statement Gemini made', query: '(illustrative)', scope: 'open web, excluding social platforms', results: 5, kept: 1, credits: 1, ok: true },
      { purpose: 'Competitor sentiment: Ovalis Labs', query: '(illustrative)', scope: 'open web, excluding social platforms', results: 10, kept: 9, credits: 1, ok: true },
      { purpose: 'Competitor sentiment: Kindra & Co', query: '(illustrative)', scope: 'open web, excluding social platforms', results: 10, kept: 8, credits: 1, ok: true },
      { purpose: 'Competitor sentiment: Sollune', query: '(illustrative)', scope: 'open web, excluding social platforms', results: 10, kept: 5, credits: 1, ok: true },
    ],
    tavilyCreditsUsed: 8,
    geminiRequests: 16,
    youtube: { status: 'ok', videos: 1, comments: 16, note: 'This illustration lists only two of the comments.' },
    sitePages: 9,
    unavailable: [],
    limitations: [
      'This is an illustrative example with invented data. Real reports list the limits of that particular audit here.',
      'Gemini API recommendation visibility measures one Gemini model through the developer API, without live web search. It does not reproduce the consumer Gemini app and says nothing about other AI assistants.',
      'Scores are estimates built from a sample of public information.',
      'A complaint theme shows that some customers reported something. It does not show how common it is among all customers.',
      'No sales, conversion, loyalty or trust data was measured. Implications and expected results are hypotheses to test, not outcomes.',
      'A wording screen replaces known overclaiming phrasings in what the AI model writes. It is a list of phrasings and does not detect every unsupported causal claim.',
    ],
  },
  warnings: [],
};
