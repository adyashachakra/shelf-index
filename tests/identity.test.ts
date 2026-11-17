// Brand identity: the audit must be about the brand that was asked about, in the category it was asked about.
//
// The failure these tests guard against was found in a real audit: "COS" was audited as a Skincare brand.
// Gemini did not recognise it there; the research then matched COSRX, Cos De Baha, cos-IQ and cosgramusa.com
// on the shared letters, and the report showed 0/100 with "medium" confidence as if that were a finding.
//
// Redis and the Lua scripts are REAL. Gemini, Tavily and YouTube are SIMULATED (tests/helpers/mock-apis.ts), and the
// pages and answers below are invented reconstructions of the SHAPE of that failure. They are not copies of real
// pages, and they prove the engine's rules, not how the live services behave.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { advanceJob, getSnapshot, startAudit } from '../lib/audit/pipeline';
import { resultsToEvidence } from '../lib/audit/evidence-builders';
import { loadJob } from '../lib/cache/jobs';
import { findCachedReportId, loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { getNumber } from '../lib/clients/redis';
import { domainBelongsToBrand, domainResemblesBrand, mentionsBrand, sameBrand } from '../lib/evidence/brand-match';
import { capConfidence, confidenceCeiling, decideIdentity } from '../lib/evidence/identity';
import { reviewAuditDetails } from '../lib/form-review';
import { reservationState } from '../lib/quota/reservations';
import { overallConfidence } from '../lib/scoring/confidence';
import type { JobSnapshot, Metric, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState, type Scenario } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const realLog = console.log;
let visitor = 0;

before(async () => {
  shim = await startShim(6399, 7);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3'; // keeps the research depth at "full" (the depth depends on the daily limit)
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
  const fresh = newMockState();
  Object.assign(state, fresh);
});

function input(brand: string, category: 'skincare' | 'fashion') {
  const parsed = validateAuditInput({ brand, category });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

async function runToEnd(id: string): Promise<{ last: JobSnapshot; calls: number }> {
  for (let calls = 1; calls <= 150; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    if (['complete', 'failed', 'identity_failed'].includes(snapshot.status)) return { last: snapshot, calls };
  }
  throw new Error('the audit did not finish');
}

async function start(brand: string, category: 'skincare' | 'fashion'): Promise<string> {
  visitor += 1;
  const started = await startAudit(input(brand, category), `203.0.113.${visitor}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') throw new Error('not started');
  return started.body.id;
}

async function daySlots(): Promise<number> {
  const keys = (await shim.raw('KEYS', 'si:day:*')) as string[];
  return keys.length === 0 ? 0 : await getNumber(keys[0]);
}
async function visitorSlots(): Promise<number> {
  const keys = (await shim.raw('KEYS', 'si:visitor:*')) as string[];
  return keys.length === 0 ? 0 : await getNumber(keys[0]);
}

// ---------- the lookalike results, shaped like the real failure ----------

const COSRX_PAGE = {
  title: 'COSRX snail mucin essence review',
  url: 'https://skinreviews.example.org/cosrx-snail-mucin',
  content: 'COS RX snail mucin essence is a popular Korean skincare product, and this long-term review explains how it performed on dry and sensitive skin.',
};
const COS_DE_BAHA_PAGE = {
  title: 'Cos De Baha vitamin C serum',
  url: 'https://forum.example.com/t/cos-de-baha-serum',
  content: 'Members compare the Cos De Baha vitamin C serum with other brightening serums, and most say it suited their skin after a few weeks of use.',
};
const COS_IQ_PAGE = {
  title: 'cos-IQ skincare line',
  url: 'https://blog.example.net/cos-iq-line',
  content: 'cos-IQ is a small skincare line, and this article looks at its formulas and at how the line is marketed to shoppers online today.',
};
const COSGRAM_PAGE = {
  title: 'Cosgram USA: products and education',
  url: 'https://cosgramusa.com/products/clinic',
  content: 'Cosgram sells professional skincare products and runs training courses, with a catalogue of treatments and services for clinics.',
};
const LOOKALIKES = [COSRX_PAGE, COS_DE_BAHA_PAGE, COS_IQ_PAGE, COSGRAM_PAGE];

const COS_OWN_PAGE = {
  title: 'COS: help and delivery',
  url: 'https://www.cos.com/en/help/delivery',
  content: 'COS delivery usually takes three to five working days, and COS accepts returns for thirty days after the order arrives, with details on this page.',
};
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

const unrecognisedCos = (extra: Partial<Scenario> = {}): Scenario => ({
  brand: 'COS',
  recognised: false,
  reviews: LOOKALIKES,
  recommends: ['Alba Dermics', 'Mirelle'],
  ...extra,
});

// =====================================================================================================
// 1. The names and addresses that must not be taken for COS
// =====================================================================================================

test('COS is not COSRX', () => {
  assert.equal(mentionsBrand('COSRX snail mucin essence', 'COS'), false);
  assert.equal(mentionsBrand('COS RX snail mucin essence', 'COS'), false, 'written with a space it is still another name');
  assert.equal(sameBrand('COS', 'COSRX'), false);
  assert.equal(sameBrand('COS', 'COS RX'), false);
  assert.equal(domainBelongsToBrand('cosrx.com', 'COS'), false);
});

test('COS is not Cos De Baha', () => {
  assert.equal(mentionsBrand('The Cos De Baha vitamin C serum', 'COS'), false);
  assert.equal(sameBrand('COS', 'Cos De Baha'), false);
  assert.equal(domainBelongsToBrand('cosdebaha.com', 'COS'), false);
});

test('COS is not cos-IQ', () => {
  assert.equal(mentionsBrand('cos-IQ is a small skincare line', 'COS'), false);
  assert.equal(sameBrand('COS', 'cos-IQ'), false);
  assert.equal(domainBelongsToBrand('cos-iq.com', 'COS'), false);
});

test('COS does not own cosgramusa.com: a name that merely contains the brand is not ownership', () => {
  assert.equal(domainBelongsToBrand('cosgramusa.com', 'COS'), false);
  assert.equal(domainBelongsToBrand('www.cosgramusa.com', 'COS'), false);
  assert.equal(domainResemblesBrand('cosgramusa.com', 'COS'), true, 'it is reported as a look-alike, not silently ignored');
  for (const other of ['cosmos.com', 'cosmetics.com', 'cos.myshopify.com', 'h-cos.com']) {
    assert.equal(domainBelongsToBrand(other, 'COS'), false, other);
  }
});

test('a legitimate short-named brand with a verified official domain is not excluded', () => {
  // COS's own addresses, with the plain words a real shop adds.
  for (const domain of ['cos.com', 'www.cos.com', 'shop.cos.com', 'cos.co.uk', 'cosstores.com', 'cosusa.com', 'shopcos.com']) {
    assert.equal(domainBelongsToBrand(domain, 'COS'), true, domain);
  }
  // Ordinary uses of the name still count as the brand.
  for (const text of ['I bought a COS coat', 'COS and H&M are similar', 'COS UK has stores', 'Love COS clothing']) {
    assert.equal(mentionsBrand(text, 'COS'), true, text);
  }
  assert.equal(sameBrand('COS', 'COS Clothing'), true);
  // Short names of two letters still match their own address exactly; other brands keep working as before.
  assert.equal(domainBelongsToBrand('ao.com', 'Ao'), true);
  assert.equal(domainBelongsToBrand('hm.com', 'H&M'), true);
  assert.equal(domainBelongsToBrand('www.glossier.com', 'Glossier'), true);
  assert.equal(domainBelongsToBrand('sephora.com', 'Glossier'), false);
  assert.equal(domainBelongsToBrand('laroche-posay.us', 'La Roche-Posay'), true);
  assert.equal(domainBelongsToBrand('theinkeylist.com', 'The Inkey List'), true);
  assert.equal(sameBrand('Fenty', 'Fenty Beauty by Rihanna'), true, 'longer names that only extend a longer brand still match');
});

test('results that used a lookalike name are kept out of the evidence, and listed as set aside with the reason', () => {
  const setAside: { title: string; url: string; domain: string; reason: string }[] = [];
  const domains: string[] = [];
  const items = resultsToEvidence({
    results: [...LOOKALIKES, COS_REVIEW_1, COS_OWN_PAGE].map((r, i) => ({ ...r, rawContent: null, score: 0.9 - i * 0.01 })),
    kind: 'review',
    prefix: 'R',
    brand: 'COS',
    startIndex: 0,
    seenUrls: new Set(),
    onBrandDomain: (d) => domains.push(d),
    onSetAside: (entry) => setAside.push(entry),
  });
  assert.deepEqual(items.map((i) => i.url), [COS_REVIEW_1.url], 'only the page that is about COS is evidence');
  assert.deepEqual(domains, ['cos.com'], 'only COS\'s own address is noted as the brand\'s site');
  assert.equal(setAside.length, 4);
  assert.ok(setAside.some((e) => e.url === COSRX_PAGE.url && e.reason.includes('COS RX')));
  assert.ok(setAside.some((e) => e.url === COS_DE_BAHA_PAGE.url && e.reason.includes('Cos De Baha')));
  assert.ok(setAside.some((e) => e.url === COS_IQ_PAGE.url && e.reason.includes('cos-IQ')));
  assert.ok(setAside.some((e) => e.url === COSGRAM_PAGE.url && e.reason.includes('cosgramusa.com')));
});

// =====================================================================================================
// 2. The identity decision
// =====================================================================================================

const profile = (recognized: boolean, officialDomain = '') => ({
  recognized, description: recognized ? 'A clothing brand.' : '', knownFor: [], products: [], pricePositioning: 'unknown', officialDomain, strengths: [], criticisms: [], claims: [],
});

test('the decision: recognised proceeds; not recognised with a verified domain proceeds with limits; neither stops', () => {
  assert.equal(decideIdentity(profile(true, 'cos.com'), [], 'COS', 'Clothing and fashion').status, 'recognised');
  const verified = decideIdentity(profile(false), ['cos.com'], 'COS', 'Clothing and fashion');
  assert.equal(verified.status, 'domain_verified');
  assert.equal(verified.verifiedDomain, 'cos.com');
  const stopped = decideIdentity(profile(false), [], 'COS', 'Skincare');
  assert.equal(stopped.status, 'failed');
  assert.equal(decideIdentity(null, [], 'COS', 'Skincare').status, 'unchecked', 'a failed description is "not checked", not "not recognised"');
});

test('confidence: an unverified brand never shows high confidence', () => {
  const high: Metric = { status: 'scored', score: 70, confidence: 'high', confidenceReason: 'Plenty of evidence.' };
  assert.equal(confidenceCeiling('recognised'), 'high');
  assert.equal(confidenceCeiling('domain_verified'), 'low');
  assert.equal(confidenceCeiling('unchecked'), 'medium');
  const capped = capConfidence(high, 'domain_verified');
  assert.equal(capped.status === 'scored' && capped.confidence, 'low');
  assert.ok(capped.status === 'scored' && capped.confidenceReason.includes('identified only from its website address'));
  assert.deepEqual(capConfidence(high, 'recognised'), high, 'a recognised brand is untouched');
  const notRecognised: Metric = { status: 'not_recognised', reason: 'x' };
  assert.deepEqual(capConfidence(notRecognised, 'domain_verified'), notRecognised);
  const overall = overallConfidence([
    { name: 'Gemini API recommendation visibility', metric: notRecognised },
    { name: 'audience perception', metric: high },
  ]);
  assert.equal(overall.status, 'not_stated', 'no overall confidence is stated for a brand that was not recognised');
});

// =====================================================================================================
// 3. The original COS / Skincare failure, replayed against the simulated services
// =====================================================================================================

test('COS in Skincare: the audit stops early as an identity failure, not as a finished audit with a 0/100', async () => {
  state.scenario = unrecognisedCos();
  const id = await start('COS', 'skincare');
  const { last } = await runToEnd(id);

  assert.equal(last.status, 'identity_failed', 'a distinct status: not "complete" and not a generic failure');
  assert.ok(last.error?.startsWith('Brand not recognised in this category.'));
  assert.ok(last.error?.includes('Gemini did not recognise COS in the Skincare category'));
  // It stopped before the expensive stages: one Gemini request (the description), one search (the website check).
  assert.equal(state.geminiCalls, 1);
  assert.equal(state.tavilyCalls, 1);
  assert.equal(state.youtubeCalls, 0);
  assert.ok(state.tavilyQueries[0].includes('review honest opinion forum'), 'the website check is the reviews search, run first');
  const job = await loadJob(id);
  assert.ok(job);
  assert.equal(job.data.answers, undefined, 'the eight shopper questions were never asked');
  assert.equal(job.data.labels, undefined);
  assert.equal(job.data.identity?.status, 'failed');
  assert.deepEqual(job.data.audience?.brandDomains, [], 'cosgramusa.com was not accepted as COS\'s site');
  assert.equal(job.data.audience?.items.length, 0, 'no lookalike became evidence');
  assert.equal(job.data.audience?.setAside?.length, 4, 'but each is kept for the diagnostics, with its reason');
  assert.equal(await loadReport(id), null, 'no report exists');
  assert.equal(await findCachedReportId('skincare:cos'), null, 'nothing is cached, so a corrected audit will run');
});

test('an identity stop settles the reservation with the existing mechanism: credits returned, spent credits kept', async () => {
  state.scenario = unrecognisedCos();
  const id = await start('COS', 'skincare');
  assert.equal(await daySlots(), 1);
  await runToEnd(id);
  const resv = await reservationState(id);
  assert.equal(resv?.state, 'settled');
  assert.equal(resv?.spent, 1, 'the one search that ran is not given back');
  const monthKeys = (await shim.raw('KEYS', 'si:tavily:20*')) as string[];
  assert.equal(await getNumber(monthKeys[0]), 1, 'only the credit that was spent stays against the month; the rest was returned');
  // The existing quota policy keeps the daily and visitor slots once a search has been paid for.
  assert.equal(await daySlots(), 1);
  assert.equal(await visitorSlots(), 1);
  const job = await loadJob(id);
  assert.ok(job?.meta.error?.includes('still counts towards the daily limits'));
});

test('when no search was charged, the daily and visitor slots are returned as well', async () => {
  state.scenario = unrecognisedCos();
  state.tavilyRateLimited = true; // the search is refused before any credit is charged
  const id = await start('COS', 'skincare');
  assert.equal(await daySlots(), 1);
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'identity_failed');
  assert.ok(last.error?.includes('could not be run'), 'it says the website check did not run, not that no website exists');
  const resv = await reservationState(id);
  assert.equal(resv?.spent, 0);
  assert.equal(await daySlots(), 0, 'the global slot is back');
  assert.equal(await visitorSlots(), 0, 'the visitor slot is back');
  const job = await loadJob(id);
  assert.ok(job?.meta.error?.includes('does not count towards the daily limits'));
});

test('a stopped audit cannot be resumed by reopening it', async () => {
  state.scenario = unrecognisedCos();
  const id = await start('COS', 'skincare');
  await runToEnd(id);
  const gemini = state.geminiCalls;
  const tavily = state.tavilyCalls;
  const youtube = state.youtubeCalls;
  const before = await getSnapshot(id);
  for (let i = 0; i < 5; i += 1) {
    const again = await advanceJob(id);
    assert.equal(again?.status, 'identity_failed');
    assert.deepEqual(again, before, 'reopening shows the same ending every time');
  }
  assert.equal(state.geminiCalls, gemini, 'no Gemini request');
  assert.equal(state.tavilyCalls, tavily, 'no search');
  assert.equal(state.youtubeCalls, youtube, 'no YouTube request');
  assert.equal(await daySlots(), 1, 'and no further slot is used');
  const resv = await reservationState(id);
  assert.equal(resv?.state, 'settled');
  // Asking again for the same brand and category is a new, separate audit (nothing is in progress or cached).
  const second = await startAudit(input('COS', 'skincare'), '198.51.100.250');
  assert.equal(second.body.status, 'started');
  if (second.body.status === 'started') assert.notEqual(second.body.id, id);
});

// =====================================================================================================
// 4. COS in its own category, and brands Gemini does not know
// =====================================================================================================

const cosFashion = (extra: Partial<Scenario> = {}): Scenario => ({
  brand: 'COS',
  recognised: true,
  officialDomain: 'https://www.cos.com/',
  siteDomain: 'cos.com',
  reviews: [COSRX_PAGE, COS_REVIEW_1, COS_REVIEW_2, COS_DE_BAHA_PAGE, COS_REVIEW_3, COS_OWN_PAGE, COS_IQ_PAGE, COSGRAM_PAGE],
  recommends: ['COS', 'Arket', 'Uniqlo'],
  videoTitles: ['COS RX snail mucin review', 'COS winter coat review'],
  ...extra,
});

test('a correctly identified COS fashion brand still proceeds to a full report, with the lookalikes set aside', async () => {
  state.scenario = cosFashion();
  const id = await start('COS', 'fashion');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  const report = (await loadReport(id)) as Report;
  assert.equal(report.version, 7);
  assert.equal(report.identity?.status, 'recognised');
  assert.equal(report.visibility.metric.status, 'scored');
  assert.equal(report.competitors.kind, 'competitors');
  assert.ok(report.competitors.rows.length > 1);
  assert.ok(state.tavilyQueries.some((q) => q.includes('Arket clothing reviews honest opinions')), 'competitor sentiment is searched for a recognised brand');
  assert.equal(state.youtubeCalls > 0, true);

  // The lookalikes did not become evidence, in any section.
  const evidenceUrls = report.evidence.map((e) => e.url);
  for (const bad of [COSRX_PAGE.url, COS_DE_BAHA_PAGE.url, COS_IQ_PAGE.url, COSGRAM_PAGE.url]) {
    assert.ok(!evidenceUrls.includes(bad), `${bad} must not be evidence`);
  }
  assert.ok(evidenceUrls.includes(COS_REVIEW_1.url));
  // ...and they are listed where a reader can see what was left out and why.
  const aside = report.identity?.setAside ?? [];
  assert.ok(aside.some((e) => e.url === COSRX_PAGE.url));
  assert.ok(aside.some((e) => e.url === COSGRAM_PAGE.url));
  assert.ok(aside.some((e) => e.title.includes('COS RX snail mucin review') && e.domain === 'youtube.com'), 'a lookalike video is set aside too');
  assert.equal(report.identity?.setAsideCount, aside.length);
  assert.equal(report.contentGap.detail.domain, 'cos.com', 'the site read is COS\'s own');
});

test('genuine zero visibility stays a scored zero, separate from non-recognition', async () => {
  state.scenario = cosFashion({ recommends: ['Arket', 'Uniqlo'] }); // Gemini knows COS, and never names it
  const id = await start('COS', 'fashion');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  const report = (await loadReport(id)) as Report;
  assert.equal(report.identity?.status, 'recognised');
  assert.equal(report.visibility.metric.status, 'scored');
  assert.equal(report.visibility.metric.status === 'scored' && report.visibility.metric.score, 0, 'a real absence from the answers is still reported as 0');
});

test('a brand Gemini does not recognise, with a verified official domain, proceeds with a warning and no visibility score', async () => {
  state.scenario = cosFashion({
    recognised: false,
    officialDomain: undefined,
    reviews: [COSRX_PAGE, COS_OWN_PAGE, COS_REVIEW_1, COS_REVIEW_2, COS_REVIEW_3, COSGRAM_PAGE],
    recommends: ['Arket', 'Uniqlo'],
  });
  const id = await start('COS', 'fashion');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete', 'a verified domain is enough to go on');
  // The reviews search ran first (it is what finds the domain), and the identity was settled before the eight questions.
  assert.ok(state.tavilyQueries[0].includes('review honest opinion forum'));

  const report = (await loadReport(id)) as Report;
  assert.equal(report.identity?.status, 'domain_verified');
  assert.equal(report.identity?.verifiedDomain, 'cos.com');
  assert.ok(report.warnings.some((w) => w.includes('did not recognise COS')));

  // Visibility: no number, the agreed words, and not a zero.
  const v = report.visibility.metric;
  assert.equal(v.status, 'not_recognised');
  assert.ok(v.status === 'not_recognised' && v.reason.includes('not a score of 0'));
  assert.equal(report.overallConfidence.status, 'not_stated');
  assert.equal(report.disconnect.status, 'cannot_assess');
  // The metrics that were measured never claim high confidence.
  for (const metric of [report.perception.metric, report.contentGap.metric]) {
    if (metric.status === 'scored') assert.notEqual(metric.confidence, 'high');
    if (metric.status === 'scored') assert.equal(metric.confidence, 'low');
  }
  assert.equal(report.contentGap.detail.domain, 'cos.com');
});

test('with the brand not recognised, Gemini\'s recommendations are labelled as such, not searched, and not used for advice', async () => {
  state.scenario = cosFashion({
    recognised: false,
    officialDomain: undefined,
    reviews: [COS_OWN_PAGE, COS_REVIEW_1, COS_REVIEW_2, COS_REVIEW_3],
    recommends: ['Arket', 'Uniqlo'],
    fixIds: ['G1', 'GP', 'R1'],
  });
  const id = await start('COS', 'fashion');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  const report = (await loadReport(id)) as Report;

  assert.equal(report.competitors.kind, 'recommended_brands');
  assert.ok(report.competitors.note.includes('not verified competitors of COS'));
  assert.ok(report.competitors.rows.length > 1, 'the recommended brands are listed');
  for (const row of report.competitors.rows.filter((r) => !r.isAuditedBrand)) {
    assert.equal(row.visibility.status, 'not_recognised', 'no comparison is drawn');
    assert.equal(row.sentiment.status, 'not_measured', 'no sentiment was searched');
    assert.ok(row.appearances > 0, 'how often each was named is still shown');
  }
  assert.ok(
    state.tavilyQueries.every((q) => !q.includes('reviews honest opinions')),
    'no search was spent on the brands Gemini recommended',
  );
  // Recommendations: the ones that cite Gemini's answers (G1, GP) are dropped; the one resting on audience evidence stays.
  assert.ok(report.fixes.length > 0);
  for (const fix of report.fixes) {
    assert.ok(fix.evidenceIds.every((e) => !e.startsWith('G')), `no recommendation may rest on Gemini's answers: ${fix.evidenceIds}`);
  }
  assert.ok(report.fixesNote?.includes('None draws on the brands Gemini recommended'));
  assert.ok(report.betweenTheLines.every((c) => c.evidence.every((e) => !e.id.startsWith('G'))));
  if (process.env.SI_DUMP_IDENTITY_REPORT) writeFileSync(process.env.SI_DUMP_IDENTITY_REPORT, JSON.stringify(report));
});

test('evidence the reader shows to be about another business is excluded from scores, themes and recommendations', async () => {
  state.scenario = cosFashion({
    reviews: [COS_REVIEW_1, COS_REVIEW_2, COS_REVIEW_3, COS_OWN_PAGE],
    // R1 is judged to be about another business; R2 is unclear (excluded for a short name); R3 is the brand.
    sameBusiness: (id) => (id === 'R1' ? 'no' : id === 'R2' ? 'unclear' : 'yes'),
    fixIds: ['R1', 'R2', 'R3'],
  });
  const id = await start('COS', 'fashion');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  const report = (await loadReport(id)) as Report;
  const ids = report.evidence.map((e) => e.id);
  assert.ok(!ids.includes('R1') && !ids.includes('R2'), 'neither excluded item is shown as evidence');
  assert.ok(ids.includes('R3'));
  for (const fix of report.fixes) assert.ok(!fix.evidenceIds.includes('R1') && !fix.evidenceIds.includes('R2'), 'no recommendation cites excluded evidence');
  assert.ok(report.fixes.some((f) => f.evidenceIds.includes('R3')), 'verified evidence still supports a recommendation');
  const aside = report.identity?.setAside ?? [];
  assert.ok(aside.some((e) => e.url === COS_REVIEW_1.url && e.reason.includes('different business')), 'and the exclusion is explained');
  assert.ok(aside.some((e) => e.url === COS_REVIEW_2.url));
  assert.ok(report.perception.detail.uniqueDomains.every((d) => d !== 'styleblog.example.org'));
});

test('a longer, distinctive name keeps an "unclear" item: strictness is for short names and brands Gemini does not know', async () => {
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
    sameBusiness: () => 'unclear',
  };
  const parsed = validateAuditInput({ brand: 'Tessellate Goods', category: 'homeware' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  visitor += 1;
  const started = await startAudit(parsed.value, `203.0.114.${visitor}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') return;
  const { last } = await runToEnd(started.body.id);
  assert.equal(last.status, 'complete');
  const report = (await loadReport(started.body.id)) as Report;
  assert.ok(report.evidence.some((e) => e.id === 'R1') && report.evidence.some((e) => e.id === 'R2'), 'unclear items about a distinctive, recognised brand stay');
});

test('if Gemini\'s description cannot be retrieved, identity is "not checked", with confidence limited to medium', () => {
  const decided = decideIdentity(null, ['cos.com'], 'COS', 'Clothing and fashion');
  assert.equal(decided.status, 'unchecked');
  assert.equal(confidenceCeiling(decided.status), 'medium');
});

// =====================================================================================================
// 5. The audit form
// =====================================================================================================

test('the form: no category is preselected, and nothing can be reviewed without one', () => {
  assert.deepEqual(reviewAuditDetails({ brand: 'COS', category: '', customCategory: '' }), { ok: false, message: 'Choose a category.' });
  assert.deepEqual(reviewAuditDetails({ brand: '  ', category: 'fashion', customCategory: '' }), { ok: false, message: 'Enter a brand name.' });
  assert.deepEqual(reviewAuditDetails({ brand: 'COS', category: 'not-a-category', customCategory: '' }), { ok: false, message: 'Choose a category.' });
  assert.deepEqual(reviewAuditDetails({ brand: 'COS', category: 'other', customCategory: ' ' }), { ok: false, message: 'Describe the category.' });
});

test('the form: the review step names the brand and the category exactly as chosen', () => {
  assert.deepEqual(reviewAuditDetails({ brand: ' COS ', category: 'fashion', customCategory: '' }), { ok: true, brand: 'COS', categoryName: 'Clothing and fashion' });
  assert.deepEqual(reviewAuditDetails({ brand: 'COS', category: 'skincare', customCategory: '' }), { ok: true, brand: 'COS', categoryName: 'Skincare' });
  assert.deepEqual(reviewAuditDetails({ brand: 'COS', category: 'other', customCategory: 'running shoes' }), { ok: true, brand: 'COS', categoryName: 'running shoes' });
});

test('the form: correcting the category before starting calls no API and uses no slot', async () => {
  // Reviewing and changing the category are client-side steps. Nothing reaches the server until "Start audit".
  const gemini = state.geminiCalls;
  const tavily = state.tavilyCalls;
  reviewAuditDetails({ brand: 'COS', category: 'skincare', customCategory: '' });
  reviewAuditDetails({ brand: 'COS', category: 'fashion', customCategory: '' });
  assert.equal(state.geminiCalls, gemini);
  assert.equal(state.tavilyCalls, tavily);
  assert.equal(await daySlots(), 0);
  assert.equal(await visitorSlots(), 0);
});
