// Mixed-brand evidence: a page that names the audited brand AND a look-alike is unverified, so it is never evidence.
//
// The failure these tests guard against was found in the live COS audit (Patch 7): a Lemon8 page titled
// "COS to COSRX - Trench Coats, Denim Jacket & Jeans - Lemon8 App" was counted as COS evidence. "COS" stood alone
// once, so the page "named COS"; "COSRX" is a single fused word, which the look-alike check did not recognise; and the
// stored excerpt (139 characters) names neither COSRX nor clothing, so the reader had little to go on.
//
// Redis and the Lua scripts are REAL. Gemini, Tavily and YouTube are SIMULATED (tests/helpers/mock-apis.ts). The Lemon8
// title and excerpt below are copied from the saved COS report; every other page is invented. These tests prove the
// engine's rules, not how the live services behave.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { audienceItems, differentBusinessItems, resultsToEvidence } from '../lib/audit/evidence-builders';
import { loadJob } from '../lib/cache/jobs';
import { loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { brandAttribution, mentionsBrand, runTogetherLookalikes } from '../lib/evidence/brand-match';
import { CompetitorLabelsSchema, LabelsSchema } from '../lib/validation/model-output';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState, type Scenario } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const realLog = console.log;
let visitor = 0;

before(async () => {
  shim = await startShim(6399, 8);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3'; // keeps the research depth at "full"
  process.env.PER_VISITOR_DAILY_LIMIT = '50';
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  state = newMockState();
  restoreFetch = installMockFetch(state, shim.url);
  console.log = () => undefined;
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  await shim.close();
});
beforeEach(async () => {
  await shim.flush();
  resetGeminiFeatureMemory();
  Object.assign(state, newMockState());
});

async function runToEnd(id: string): Promise<JobSnapshot> {
  for (let calls = 1; calls <= 150; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    if (['complete', 'failed', 'identity_failed'].includes(snapshot.status)) return snapshot;
  }
  throw new Error('the audit did not finish');
}

async function audit(brand: string): Promise<{ id: string; report: Report }> {
  const parsed = validateAuditInput({ brand, category: 'fashion' });
  if (!parsed.ok) throw new Error(parsed.message);
  visitor += 1;
  const started = await startAudit(parsed.value, `203.0.115.${visitor}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') throw new Error('not started');
  const last = await runToEnd(started.body.id);
  assert.equal(last.status, 'complete');
  return { id: started.body.id, report: (await loadReport(started.body.id)) as Report };
}

// ---------- the real Lemon8 page, as saved in the COS report ----------

const LEMON8_TITLE = 'COS to COSRX - Trench Coats, Denim Jacket & Jeans - Lemon8 App';
// The stored excerpt is only 139 characters: it names neither COSRX nor clothing. Only the title does.
const LEMON8_EXCERPT = 'Certain “COS” things just scratch the same itch: clean, minimal, dependable, and quietly impressive. That\'s exactly how I\'d describe a good';
const LEMON8_PAGE = { title: LEMON8_TITLE, url: 'https://www.lemon8-app.com/experience/cos-reviews', content: LEMON8_EXCERPT };

// ---------- invented pages ----------

const COS_REVIEW_1 = {
  title: 'COS coats: an honest review',
  url: 'https://styleblog.example.org/cos-coat-review',
  content: 'I have worn my COS wool coat for three winters and it has kept its shape, although the sleeves are long and the price is not low at all.',
};
const COS_REVIEW_2 = {
  title: 'Is COS worth the money?',
  url: 'https://forum.example.com/t/is-cos-worth-it',
  content: 'Several members say COS knitwear pills after a season, while others say COS shirts and trousers last for years and fit better than the high street.',
};
const COS_REVIEW_3 = {
  title: 'COS versus other minimalist brands',
  url: 'https://fashiondesk.example.net/cos-vs-minimalist-brands',
  content: 'We compared COS with four other minimalist brands on fabric, cut and price, and COS came out well on cut but only average on fabric quality.',
};
const COS_OWN_PAGE = {
  title: 'COS: help and delivery',
  url: 'https://www.cos.com/en/help/delivery',
  content: 'COS delivery usually takes three to five working days, and COS accepts returns for thirty days after the order arrives, with details on this page.',
};

const cosFashion = (extra: Partial<Scenario> = {}): Scenario => ({
  brand: 'COS',
  recognised: true,
  officialDomain: 'https://www.cos.com/',
  siteDomain: 'cos.com',
  reviews: [COS_REVIEW_1, COS_REVIEW_2, COS_REVIEW_3, COS_OWN_PAGE],
  recommends: ['COS', 'Arket', 'Uniqlo'],
  videoTitles: [],
  ...extra,
});

const asResults = (pages: { title: string; url: string; content: string }[]) => pages.map((r, i) => ({ ...r, rawContent: null, score: 0.9 - i * 0.01 }));

// =====================================================================================================
// 1. The rule on its own
// =====================================================================================================

test('the real Lemon8 title and 139-character excerpt: COS stands alone and COSRX is in the same title, so it is mixed', () => {
  assert.equal(LEMON8_EXCERPT.length, 139, 'the fixture is the 139-character excerpt that was saved');
  const result = brandAttribution(`${LEMON8_TITLE} ${LEMON8_EXCERPT}`, 'COS');
  assert.equal(result.state, 'mixed');
  assert.deepEqual(result.lookalikes, ['COSRX']);
  // The old test: the page "names COS", which is how it was wrongly counted.
  assert.equal(mentionsBrand(`${LEMON8_TITLE} ${LEMON8_EXCERPT}`, 'COS'), true);
  // The excerpt alone is an ordinary COS sentence; it is the title that makes the page mixed.
  assert.equal(brandAttribution(LEMON8_EXCERPT, 'COS').state, 'clear');
  assert.equal(brandAttribution(LEMON8_TITLE, 'COS').state, 'mixed');
});

test('mixed titles: the brand and a look-alike together, written in the ways people write them', () => {
  for (const [text, lookalike] of [
    ['COSRX vs COS: which is better', 'COSRX'],
    ['COS & COSRX haul', 'COSRX'],
    ['CosRX and COS', 'CosRX'],
    ['COS RX and COS coats', 'COS RX'],
    ['cos-IQ and COS', 'cos-IQ'],
    ['Cos De Baha vs COS', 'Cos De Baha'],
    ['From COS to COSRX: what I changed this year', 'COSRX'],
  ] as const) {
    const result = brandAttribution(text, 'COS');
    assert.equal(result.state, 'mixed', text);
    assert.ok(result.lookalikes.includes(lookalike), `${text}: ${result.lookalikes.join(',')}`);
  }
});

test('ordinary COS pages stay clear, and ordinary words such as "cost" never trigger the rule', () => {
  for (const text of [
    'COS coats review',
    'COS and H&M are similar',
    'COS UK sale and COSUS shipping',
    'Love COS clothing and cosmetics',
    'COS cost me more than expected',
    'THE COST OF COS COATS',
    'COS costs more than Arket, and the costume jewellery is extra',
    'The cosy COS knit I wear every day, cosmic blue',
    'COS wool coat, COS shirts and COS trousers',
  ]) {
    assert.equal(brandAttribution(text, 'COS').state, 'clear', text);
  }
  for (const word of ['cost', 'COST', 'costs', 'cosy', 'COSY', 'cosmic', 'cosmetics', 'costume']) {
    assert.deepEqual(runTogetherLookalikes(`I love ${word} and COS`, 'COS'), [], word);
  }
});

test('a page about the look-alike alone is not mixed: it stays excluded for the reason it always had', () => {
  assert.equal(brandAttribution('COSRX snail mucin essence review', 'COS').state, 'other');
  assert.equal(brandAttribution('Nothing about it here', 'COS').state, 'none');
});

test('the run-together rule applies only to short ambiguous names: longer names are not extended', () => {
  // Four letters or fewer are examined.
  assert.equal(brandAttribution('Zara and ZaraX picks', 'Zara').state, 'mixed');
  // Longer names are not.
  for (const [text, brand] of [
    ['Cetaphil and CETAPHILX', 'Cetaphil'],
    ['Glowwell and GlowwellX together', 'Glowwell'],
    ['Fenty and FentyBeautyX', 'Fenty Beauty'],
    ['Arket and ArketOutlet', 'Arket'],
  ] as const) {
    const result = brandAttribution(text, brand);
    assert.notEqual(result.state, 'mixed', text);
    assert.deepEqual(result.lookalikes, [], text);
  }
  assert.deepEqual(runTogetherLookalikes('Cetaphil CetaphilX', 'Cetaphil'), []);
});

test('the evidence builder sets a mixed result aside, with the reason, and counts nothing from it', () => {
  const setAside: { title: string; url: string; domain: string; reason: string }[] = [];
  const items = resultsToEvidence({
    results: asResults([LEMON8_PAGE, COS_REVIEW_1, COS_OWN_PAGE]),
    kind: 'review',
    prefix: 'R',
    brand: 'COS',
    startIndex: 0,
    seenUrls: new Set(),
    onSetAside: (entry) => setAside.push(entry),
  });
  assert.deepEqual(items.map((i) => i.url), [COS_REVIEW_1.url], 'only the ordinary COS page is evidence; the brand\'s own page is not independent evidence');
  assert.equal(setAside.length, 1);
  assert.equal(setAside[0].url, LEMON8_PAGE.url);
  assert.equal(setAside[0].domain, 'lemon8-app.com');
  assert.match(setAside[0].reason, /Names both "COS" and "COSRX"/);
  assert.match(setAside[0].reason, /cannot be attributed to COS/);
});

test('the brand\'s own pages are not examined: COS\'s site may mention COSRX without becoming unusable', () => {
  const ownPage = { title: 'COS and COSRX: we are not the same company', url: 'https://www.cos.com/en/help/not-cosrx', content: 'COS is a clothing brand. COSRX is a skincare brand that has nothing to do with COS, and this page explains the difference for shoppers.' };
  const items = resultsToEvidence({
    results: asResults([ownPage]),
    kind: 'site_page',
    prefix: 'S',
    brand: 'COS',
    startIndex: 0,
    seenUrls: new Set(),
    allowBrandDomain: true,
  });
  assert.equal(items.length, 1, 'a page on the brand\'s own verified domain is kept');
});

test('legitimate short-named brands keep working: ordinary pages are counted', () => {
  for (const brand of ['COS', 'Zara', 'Gap']) {
    const page = { title: `${brand} jackets reviewed`, url: `https://reviews.example.org/${brand.toLowerCase()}-jackets`, content: `We tested the ${brand} jacket for a month and it held up well, although ${brand} sizing runs a little small for most people.` };
    const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand, startIndex: 0, seenUrls: new Set() });
    assert.equal(items.length, 1, brand);
  }
});

test('the reader\'s labels may now say "mixed"; other answers behave as before', () => {
  const base = { id: 'R1', relevant: true, voice: 'customer', sentiment: 'positive' };
  const parse = (value: unknown) => LabelsSchema.parse({ labels: [{ ...base, same_business: value }], praise_themes: [], complaint_themes: [], concerns: [], advocacy: [], creator_vs_customer: '', price_position: { tier: 'unclear', evidence_id: '', quote: '' } });
  assert.equal(parse('mixed').labels[0].same_business, 'mixed');
  assert.equal(parse(' MIXED ').labels[0].same_business, 'mixed');
  assert.equal(parse('no').labels[0].same_business, 'no');
  assert.equal(parse('something else').labels[0].same_business, undefined, 'an unknown answer is ignored, as before');
  const competitor = CompetitorLabelsSchema.parse({ labels: [{ ...base, same_business: 'mixed' }, base] });
  assert.equal(competitor.labels[0].same_business, 'mixed');
  assert.equal(competitor.labels[1].same_business, undefined, 'older answers without the field still read');
});

// =====================================================================================================
// 2. Whole audits (simulated services)
// =====================================================================================================

test('the rule catches COS + COSRX even when the reader says "yes", and only that one page moves', async () => {
  state.scenario = cosFashion({
    reviews: [COS_REVIEW_1, LEMON8_PAGE, COS_REVIEW_2, COS_REVIEW_3, COS_OWN_PAGE],
    sameBusiness: () => 'yes', // the reader is fooled, as it was in the live audit
    fixIds: ['R1', 'R2', 'R3'],
  });
  const withMixed = await audit('COS');
  await shim.flush();
  Object.assign(state, newMockState());
  state.scenario = cosFashion({ sameBusiness: () => 'yes', fixIds: ['R1', 'R2', 'R3'] });
  const control = await audit('COS');

  const urls = withMixed.report.evidence.map((e) => e.url);
  assert.ok(!urls.includes(LEMON8_PAGE.url), 'the Lemon8 page is not evidence');
  const aside = withMixed.report.identity?.setAside ?? [];
  const entry = aside.find((e) => e.url === LEMON8_PAGE.url);
  assert.ok(entry, 'it is listed under "Found but not counted"');
  assert.match(entry.reason, /Names both "COS" and "COSRX"/);
  assert.equal(withMixed.report.identity?.setAsideCount, aside.length);

  // Only that page moved: every score, count and shown source equals the run that never saw it.
  assert.deepEqual(withMixed.report.perception.metric, control.report.perception.metric);
  assert.deepEqual(withMixed.report.perception.detail.raw, control.report.perception.detail.raw);
  assert.deepEqual(withMixed.report.visibility.metric, control.report.visibility.metric);
  assert.deepEqual(withMixed.report.contentGap.metric, control.report.contentGap.metric);
  assert.deepEqual(withMixed.report.evidence.map((e) => e.url), control.report.evidence.map((e) => e.url));
  assert.deepEqual(withMixed.report.fixes.map((f) => f.evidenceIds), control.report.fixes.map((f) => f.evidenceIds));
  assert.equal(withMixed.report.version, 10, 'the report format is the current one');
  if (process.env.SI_DUMP_MIXED_REPORT) writeFileSync(process.env.SI_DUMP_MIXED_REPORT, JSON.stringify(withMixed.report));
  assert.equal(control.report.identity?.setAside?.some((e) => e.url === LEMON8_PAGE.url) ?? false, false);
});

test('the reader\'s "mixed" answer excludes a page the rule cannot see, from every section', async () => {
  state.scenario = cosFashion({
    // R1 reads as an ordinary COS page, but the reader judges it to discuss COS together with another business.
    sameBusiness: (id) => (id === 'R1' ? 'mixed' : 'yes'),
    fixIds: ['R1', 'R2', 'R3'],
  });
  const mixed = await audit('COS');
  const job = await loadJob(mixed.id); // read before the control run clears the store
  await shim.flush();
  Object.assign(state, newMockState());
  state.scenario = cosFashion({ sameBusiness: () => 'yes', fixIds: ['R1', 'R2', 'R3'] });
  const control = await audit('COS');

  const ids = mixed.report.evidence.map((e) => e.id);
  assert.ok(!ids.includes('R1'), 'it is not shown as evidence');
  assert.ok(control.report.evidence.some((e) => e.id === 'R1'), 'and in the control run it was');
  for (const fix of mixed.report.fixes) assert.ok(!fix.evidenceIds.includes('R1'), 'no recommendation cites it');
  assert.ok(mixed.report.fixes.some((f) => f.evidenceIds.includes('R2') || f.evidenceIds.includes('R3')), 'verified evidence still supports a recommendation');
  for (const theme of [...mixed.report.perception.praise, ...mixed.report.perception.complaints]) {
    assert.ok(!theme.evidenceIds.includes('R1'), 'no theme rests on it');
  }
  assert.equal(control.report.perception.detail.raw.counted - mixed.report.perception.detail.raw.counted, 1, 'exactly one item left the sentiment counts');
  assert.deepEqual(mixed.report.visibility.metric, control.report.visibility.metric, 'the scoring formulas are unchanged');
  assert.deepEqual(mixed.report.contentGap.metric, control.report.contentGap.metric);

  const aside = mixed.report.identity?.setAside ?? [];
  const entry = aside.find((e) => e.url === COS_REVIEW_1.url);
  assert.ok(entry, 'listed under "Found but not counted"');
  assert.match(entry.reason, /discuss both COS and a different business/);

  // The synthesis input is built from the same filter, so the item is absent there too.
  assert.ok(job);
  assert.ok(!audienceItems(job.data).some((item) => item.id === 'R1'));
  const flagged = differentBusinessItems(job.data).find((item) => item.id === 'R1');
  assert.ok(flagged);
  assert.equal(job.data.labels?.labels.find((label) => label.id === 'R1')?.mixedBrand, true);
});

test('"mixed" is unverified for a distinctive, recognised brand too, unlike "unclear"', async () => {
  state.scenario = {
    brand: 'Tessellate Goods',
    recognised: true,
    officialDomain: 'tessellategoods.com',
    siteDomain: 'tessellategoods.com',
    reviews: [
      { title: 'Tessellate Goods mugs reviewed', url: 'https://homeblog.example.org/tessellate-mugs', content: 'The Tessellate Goods stoneware mugs arrived well packed and have survived a year of daily use in a busy kitchen without chipping.' },
      { title: 'Tessellate Goods plates', url: 'https://forum.example.com/t/tessellate-plates', content: 'Members say the Tessellate Goods plates are heavy but attractive, and a few report the glaze marking after repeated dishwasher cycles.' },
    ],
    recommends: ['Tessellate Goods', 'Arket'],
    sameBusiness: (id) => (id === 'R1' ? 'mixed' : 'unclear'),
  };
  const parsed = validateAuditInput({ brand: 'Tessellate Goods', category: 'homeware' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  visitor += 1;
  const started = await startAudit(parsed.value, `203.0.116.${visitor}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') return;
  assert.equal((await runToEnd(started.body.id)).status, 'complete');
  const report = (await loadReport(started.body.id)) as Report;
  assert.ok(!report.evidence.some((e) => e.id === 'R1'), '"mixed" excludes the item');
  assert.ok(report.evidence.some((e) => e.id === 'R2'), 'while "unclear" is still kept for a distinctive, recognised brand');
});

test('YouTube: a mixed video is not used and neither are its comments; a mixed comment is not used', async () => {
  state.scenario = cosFashion({
    reviews: [COS_REVIEW_1, COS_REVIEW_2, COS_REVIEW_3, COS_OWN_PAGE],
    videoTitles: ['COS to COSRX haul', 'COS winter coat review'],
    videoComments: [
      'My COS wool coat has lasted three winters of daily wear and still looks new, which I did not expect.',
      'I switched from COSRX to COS and the coat fit better than anything else I have tried before now.',
      'The COS knitwear is lovely but it does pill after a season, so I wash it very carefully by hand.',
    ],
  });
  const { id, report } = await audit('COS');
  const job = await loadJob(id);
  assert.ok(job?.data.youtube);
  const youtube = job.data.youtube;
  assert.deepEqual(youtube.videos.map((v) => v.title), ['COS winter coat review'], 'only the clear video is used');
  assert.ok(youtube.comments.length > 0);
  for (const comment of youtube.comments) {
    assert.ok(comment.sourceUrl?.includes('sv1'), 'every comment comes from the clear video (the mixed one was never opened)');
    assert.ok(!/COSRX/i.test(comment.text), 'the mixed comment is not used');
  }
  const aside = report.identity?.setAside ?? [];
  assert.ok(aside.some((e) => e.title === 'COS to COSRX haul' && /Names both "COS" and "COSRX"/.test(e.reason)), 'the mixed video is listed');
  assert.ok(aside.some((e) => e.title.startsWith('Comment on') && /Names both "COS" and "COSRX"/.test(e.reason)), 'the mixed comment is listed');
});

test('competitor sentiment: a mixed page about a competitor is not counted, and the reader\'s "mixed" answer excludes one too', async () => {
  const competitorPages = (name: string) => [
    { title: `${name} review 1`, url: `https://comp1.example.org/${name}/1`, content: `${name} has been reliable and worth the price according to this long-term reviewer of the brand.` },
    { title: `${name} review 2`, url: `https://comp2.example.org/${name}/2`, content: `${name} held its shape after a year of wear, according to this long-term reviewer of the brand.` },
    { title: `${name} review 3`, url: `https://comp3.example.org/${name}/3`, content: `${name} sizing runs small, according to this long-term reviewer who bought three pieces from the brand.` },
  ];
  // Control: only ordinary pages.
  state.scenario = cosFashion({ recommends: ['Arket', 'Zara', 'Uniqlo'], competitorResults: competitorPages });
  const control = await audit('COS');
  await shim.flush();
  Object.assign(state, newMockState());

  const zaraMixed = { title: 'Zara to ZaraX: my wardrobe swap', url: 'https://comp9.example.org/zara-to-zarax', content: 'I moved my wardrobe from Zara to ZaraX this spring and wrote down what I noticed about both brands over six months.' };
  const arketMixedByReader = { title: 'Arket reviewed next to a similarly named shop', url: 'https://comp8.example.org/arket-twin', content: 'The Arket coat and the twin shop sell similar coats, and this reviewer mixes up which one she bought during the sale.' };
  state.scenario = cosFashion({
    recommends: ['Arket', 'Zara', 'Uniqlo'],
    competitorResults: (name) => (name === 'Zara' ? [...competitorPages(name), zaraMixed] : name === 'Arket' ? [...competitorPages(name), arketMixedByReader] : competitorPages(name)),
    competitorMixed: (about, text) => about === 'Arket' && text.includes('twin shop'),
  });
  const mixed = await audit('COS');
  const row = (report: Report, name: string) => (report.competitors.rows.find((r) => r.name === name) as { sentimentSample: number } | undefined)?.sentimentSample;
  assert.ok(row(control.report, 'Zara') !== undefined && row(control.report, 'Arket') !== undefined, 'both competitors were searched');
  assert.equal(row(mixed.report, 'Zara'), row(control.report, 'Zara'), 'the deterministic rule keeps the mixed Zara page out of the sample');
  assert.equal(row(mixed.report, 'Arket'), row(control.report, 'Arket'), 'the reader\'s "mixed" answer keeps the Arket page out of the sample');
  const job = await loadJob(mixed.id);
  assert.ok(job?.data.competitors);
  assert.ok(!job.data.competitors.items.some((i) => i.url === zaraMixed.url), 'the mixed Zara page was never kept as evidence');
  const flagged = job.data.competitors.items.find((i) => i.url === arketMixedByReader.url);
  assert.ok(flagged, 'the Arket page is kept as an item, but...');
  const label = job.data.competitors.labels.find((l) => l.id === flagged.id);
  assert.equal(label?.relevant, false, '...its label says it is not relevant');
  assert.equal(label?.mixedBrand, true);
});

test('an ordinary COS audit with no mixed pages is unchanged by the rule', async () => {
  state.scenario = cosFashion({ sameBusiness: () => 'yes', fixIds: ['R1', 'R2', 'R3'] });
  const { report } = await audit('COS');
  assert.equal(report.version, 10);
  assert.deepEqual(report.evidence.map((e) => e.url).filter((u) => u.includes('example')).sort(), [COS_REVIEW_1.url, COS_REVIEW_2.url, COS_REVIEW_3.url].sort());
  assert.ok((report.identity?.setAside ?? []).every((e) => !/Names both/.test(e.reason)), 'nothing is called mixed when nothing is');
});
