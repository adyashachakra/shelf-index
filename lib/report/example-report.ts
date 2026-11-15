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
  version: 1,
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
      confidenceReason: '7 of 8 questions counted, covering 7 different shopper intents; 1 excluded as outside the product range. One Gemini run per question.',
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
      confidenceReason: '23 counted opinions from 9 sources across 4 unique domains; source types: customer, creator, publication.',
    },
    detail: {
      itemsRetrieved: 31,
      itemsLabeled: 31,
      raw: { positive: 14, mixed: 5, negative: 4, counted: 23, neutral: 4, irrelevant: 3, brandCreated: 1 },
      weighted: { positive: 12, mixed: 4, negative: 3.5, total: 19.5 },
      uniqueSources: 9,
      uniqueDomains: ['beautydesk.example', 'reddit.com', 'skinjournal.example', 'youtube.com'],
      sourceTypes: ['customer', 'creator', 'publication'],
      byVoice: { customer: 16, creator: 4, publication: 3, unclear: 0 },
      voiceScores: { customer: 72, creator: null, publication: null },
      sponsoredItems: [
        { evidenceId: 'V1', signals: ['YouTube paid-promotion flag', 'states it is sponsored', 'discount code'] },
        { evidenceId: 'R2', signals: ['earns commission'] },
      ],
    },
    praise: [
      { label: 'Gentle on reactive skin', summary: 'People with sensitive or reactive skin say the oat cleanser does not sting or cause flare-ups.', evidenceIds: ['D1', 'C1', 'R2'], quote: { evidenceId: 'D1', text: 'Finally a cleanser that does not sting.' } },
      { label: 'Truly fragrance-free', summary: 'Buyers value that the whole range is fragrance-free, which they describe as rare.', evidenceIds: ['D3', 'R2'] },
    ],
    complaints: [
      { label: 'Slow shipping', summary: 'Orders are reported to take two to three weeks to arrive, with poor tracking.', evidenceIds: ['D3', 'R1', 'C1'], quote: { evidenceId: 'R1', text: 'Our order took 18 days to arrive' } },
      { label: 'Pumps break', summary: 'Several buyers report the pump on the moisturiser failing within weeks.', evidenceIds: ['D2', 'C2'], quote: { evidenceId: 'C2', text: 'Their pumps always break.' } },
    ],
    concerns: [
      { id: 'c1', label: 'How long does delivery take?', evidenceIds: ['D3', 'C1'] },
      { id: 'c2', label: 'What happens if the pump breaks?', evidenceIds: ['D2', 'C2'] },
    ],
    advocacy: [{ evidenceId: 'D1', note: 'A customer with rosacea says it is the only cleanser they have repurchased three times.' }],
    creatorVsCustomer: 'The sponsored creator video is uniformly positive, while customers praise the cleanser but raise delivery and packaging problems the video does not mention.',
    themesNote: 'Fewer than three recurring themes are listed where the evidence did not support more: a theme needs at least two separate sources.',
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
      excluded: [{ questionId: 'q5', question: ANSWERS[4].question, reason: `The site lists no anti-aging products. ${SITE} shows these product lines: cleansers, moisturisers, mineral sunscreen.` }],
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
      { title: 'Customers call it their go-to; Gemini files it under "also worth a look"', kind: 'opportunity', audienceSays: 'Customers with reactive skin describe the oat cleanser as the only one they repurchase.', geminiSays: 'For sensitive skin Gemini names Kindra & Co first and Northmere Skin second, and omits it from "best overall".', implication: 'The strongest customer proof is not reaching the general recommendations.', audienceEvidenceIds: ['D1', 'C1'], geminiEvidenceIds: ['G3', 'G1'] },
      { title: 'Packaging failures are invisible to Gemini', kind: 'risk', audienceSays: 'Buyers repeatedly report pumps breaking within weeks.', geminiSays: 'Gemini lists slow shipping as the only criticism and does not mention packaging.', implication: 'A known problem that could surface later in AI answers if left unaddressed.', audienceEvidenceIds: ['D2', 'C2'], geminiEvidenceIds: ['GP'] },
    ],
  },
  betweenTheLines: [
    { id: 'signature_claim', title: "Does Gemini recommend a competitor for the brand's signature claim?", status: 'observed', basis: 'computed', observed: 'The brand\'s site leads with "fragrance-free formulas for reactive skin". Asked which skincare brands are best known for that, Gemini\'s first recommendation was Kindra & Co; Northmere Skin was recommended, position 2.', evidence: [{ id: 'S1', label: 'Brand site states: "fragrance-free formulas for reactive skin"', url: `https://${SITE}/illustrative/s1`, quote: 'Every Northmere product is fragrance-free.' }, { id: 'GS', label: 'Gemini, asked: "Which skincare brands are best known for fragrance-free formulas for reactive skin?"', quote: 'Kindra & Co is the best-known name for fragrance-free formulas aimed at reactive skin' }], whyItMatters: 'A shopper who asks an AI assistant about the very thing this brand claims to be best at is pointed to someone else first.', implication: 'Make "fragrance-free formulas for reactive skin" easy to attribute to Northmere Skin outside its own site: comparison content, independent reviews and plain-language pages that state it directly.' },
    { id: 'complaint_as_fact', title: 'Does Gemini repeat an online complaint as established fact?', status: 'observed', basis: 'ai_interpretation', observed: 'Gemini states that customers often mention slow shipping as a general fact about the brand. In the evidence this appears as individual delivery complaints.', evidence: [{ id: 'GP', label: "Gemini's own description of the brand", quote: 'Customers often mention slow shipping.' }, { id: 'R1', label: 'Article or review on skinjournal.example: Northmere Skin review', url: 'https://skinjournal.example/illustrative/r1', quote: 'Our order took 18 days to arrive and the tracking link never updated.' }], whyItMatters: 'A fixable operational problem has become part of how the model introduces the brand.', implication: 'Fix delivery times, then publish current shipping times where they can be cited.' },
    { id: 'outdated_details', title: 'Does Gemini describe discontinued, outdated or incorrect details?', status: 'observed', basis: 'ai_interpretation', observed: 'Gemini stated: "It also sells a vitamin C serum called Bright C." A retrieved source says otherwise.', evidence: [{ id: 'GP', label: "Gemini's own description of the brand", quote: 'It also sells a vitamin C serum called Bright C.' }, { id: 'K1', label: 'Source contradicting: "It also sells a vitamin C serum called Bright C."', url: 'https://skinjournal.example/illustrative/k1', quote: 'it discontinued the Bright C serum in March' }], whyItMatters: 'Shoppers act on what the model tells them. A wrong detail about products, prices or availability costs sales or creates disappointed customers.', implication: 'Correct the record where models learn from: update the brand site and product pages so the current facts are stated plainly, and fix stale listings elsewhere.' },
    { id: 'narrow_range', title: 'Is the brand known to Gemini for one product while its wider range is ignored?', status: 'observed', basis: 'ai_interpretation', observed: 'Every Gemini mention of the brand is about the oat cleanser. The site also sells moisturisers and a mineral sunscreen, which Gemini never mentions.', evidence: [{ id: 'G2', label: 'Gemini, asked: "Which affordable skincare brands actually work?"', quote: 'Northmere Skin is also worth a look for its oat cleanser' }, { id: 'S1', label: 'Brand site: Northmere Skin: fragrance-free skincare', url: `https://${SITE}/illustrative/s1` }], whyItMatters: 'The brand is a one-product recommendation in AI answers, which caps how often it can be suggested.', implication: 'Give the moisturiser and sunscreen their own explanatory pages and seek independent reviews of them.' },
    { id: 'volume_vs_visibility', title: 'Is there a mismatch between how much people discuss the brand and how often Gemini recommends it?', status: 'not_observed', basis: 'computed', observed: 'Visibility is 39 with 16 customer opinions found: neither mismatch threshold was met (15+ customer opinions with visibility under 25, or visibility 60+ with fewer than 8 counted opinions).', evidence: [{ id: 'visibility', label: 'Gemini API recommendation visibility: 39 (7 questions counted)' }, { id: 'discussion', label: '16 customer opinions and 23 counted opinions in total, from 9 sources' }] },
    { id: 'source_footprint', title: 'Is the brand missing from sources that AI and search rely on?', status: 'not_observed', basis: 'computed', observed: 'The brand appeared in every source type that could be checked.', evidence: [{ id: 'footprint1', label: 'Reddit-indexed threads naming the brand: 3' }, { id: 'footprint2', label: 'Independent sites with a page naming the brand: 2' }, { id: 'footprint3', label: 'YouTube videos naming the brand: 1' }] },
    { id: 'positioning_contradiction', title: "Does the brand's positioning contradict what customers experience?", status: 'observed', basis: 'ai_interpretation', observed: 'The site says orders ship fast, while slow delivery is the most repeated customer complaint.', evidence: [{ id: 'S2', label: 'Brand site: Shipping and returns', url: `https://${SITE}/illustrative/s2` }, { id: 'D3', label: 'Community discussion on reddit.com: Fragrance-free routine help', url: 'https://reddit.com/illustrative/d3', quote: 'Shipping took almost three weeks though.' }], whyItMatters: 'A promise customers can see being broken damages trust more than saying nothing.', implication: 'Replace "ships fast" with real delivery times until the operation can back the claim.' },
  ],
  fixes: [
    { action: 'Publish real delivery times on the shipping page and remove "ships fast" until it is true.', why: 'Slow shipping is the most repeated complaint and Gemini already repeats it.', priority: 1, effort: 'Low', expectedImpact: 'Removes a visible contradiction and gives sources an accurate statement to cite.', evidenceIds: ['S2', 'R1', 'D3', 'GP'] },
    { action: 'State on the site that Bright C is discontinued and say what replaced it, if anything.', why: 'Gemini still tells shoppers the brand sells it.', priority: 2, effort: 'Low', expectedImpact: 'Gives models and shoppers a clear, current fact.', evidenceIds: ['GP', 'K1'] },
    { action: 'Create a page answering "best skincare for sensitive skin" with the oat cleanser evidence and customer quotes.', why: 'Customers call it their go-to, yet Gemini ranks a competitor first for the same need.', priority: 3, effort: 'Medium', expectedImpact: 'Strengthens the association between the brand and its signature claim.', evidenceIds: ['D1', 'G3', 'GS'] },
    { action: 'Add a page on what to do if a pump fails, and fix the pump.', why: 'Customers ask about it and the site does not address it.', priority: 4, effort: 'Medium', expectedImpact: 'Answers a recurring customer concern before it spreads.', evidenceIds: ['D2', 'C2'] },
  ],
  fixesNote: 'Only 4 recommendations could be tied to evidence from this audit, so only those are shown.',
  evidence: EVIDENCE,
  methodology: {
    auditedAt: '2026-11-14T15:04:00.000Z',
    model: 'illustrative-model',
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
    youtube: { status: 'ok', videos: 1, comments: 2, note: 'In this illustration only one video and two comments are shown.' },
    sitePages: 9,
    unavailable: [],
    limitations: [
      'This is an illustrative example with invented data. Real reports list the limits of that particular audit here.',
      'Gemini API recommendation visibility measures one Gemini model through the developer API, without live web search. It does not reproduce the consumer Gemini app and says nothing about other AI assistants.',
      'Scores are estimates built from a sample of public information.',
    ],
  },
  warnings: [],
};
