// Release hardening H1: a degraded report is kept under its own id but never becomes the cached result for its brand.
//
// Redis and the Lua scripts are REAL (a local redis-server behind the Upstash REST shim). Gemini, Tavily and YouTube are
// simulated (tests/helpers/mock-apis.ts), with scripted Gemini failures aimed at one kind of request at a time. Nothing
// here contacts a real service. The brand "Glowwell" and every page in these audits are invented.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { loadJob } from '../lib/cache/jobs';
import { findCachedReportId, loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { cacheBlockers, SUPPORTING_GEMINI_STEPS } from '../lib/audit/stages/finalize';
import { GEMINI_AUDIT_REQUEST_CEILING, REPORT_FORMAT_VERSION } from '../lib/config';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockFault, type MockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const realLog = console.log;
let visitor = 0;

const CACHE_KEY = 'skincare:glowwell';
const POINTER = `si:cache:v${REPORT_FORMAT_VERSION}:${CACHE_KEY}`;
const OVERLOADED: MockFault = { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } } };

/** The system instruction of each Gemini request kind these tests break (the same strings the mock answers on). */
const SENTIMENT = 'reading what people say about a brand';
const SITE_ANALYSIS = "auditing a brand's own website";
const COMPETITOR_LABELS = 'labeling what people say about several brands';
const PROFILE = 'Describe a brand using only what you already know';
const SYNTHESIS = 'brand strategist comparing';
const FIX_LIST = 'prioritised fix list';
const CLAIMS = 'fact-checking';

before(async () => {
  shim = await startShim(6399, 12);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  // A low daily limit keeps the credit pacing at the full research depth, so the competitor stage runs. The counters
  // are flushed before every test, so each test has its own day.
  process.env.DAILY_SCAN_LIMIT = '3';
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

/** Fail every Gemini request whose system instruction contains one of these strings. */
function failRequestsFor(...kinds: string[]): void {
  state.fault = (_n, body) => {
    const system = String(((body.systemInstruction as { parts: { text: string }[] }).parts[0] ?? { text: '' }).text);
    return kinds.some((kind) => system.includes(kind)) ? OVERLOADED : null;
  };
}

async function start(): Promise<string> {
  const parsed = validateAuditInput({ brand: 'Glowwell', category: 'skincare' });
  if (!parsed.ok) throw new Error(parsed.message);
  visitor += 1;
  const started = await startAudit(parsed.value, `203.0.118.${visitor}`);
  assert.equal(started.body.status, 'started', `expected a new audit, got ${JSON.stringify(started.body)}`);
  if (started.body.status !== 'started') throw new Error('not started');
  return started.body.id;
}

async function runToEnd(id: string, beforeEachCall?: (call: number) => Promise<void>): Promise<JobSnapshot> {
  for (let calls = 1; calls <= 200; calls += 1) {
    if (beforeEachCall) await beforeEachCall(calls);
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    if (['complete', 'failed', 'identity_failed'].includes(snapshot.status)) return snapshot;
  }
  throw new Error('the audit did not finish');
}

async function audit(): Promise<{ id: string; report: Report }> {
  const id = await start();
  const last = await runToEnd(id);
  assert.equal(last.status, 'complete');
  return { id, report: (await loadReport(id)) as Report };
}

/** The report exists under its own id, opens, and no brand pointer was written for it. */
async function assertKeptButNotCached(id: string): Promise<Report> {
  assert.equal(await shim.raw('EXISTS', `si:report:v${REPORT_FORMAT_VERSION}:${id}`), 1, 'the report is saved under its id');
  const loaded = (await loadReport(id)) as Report;
  assert.equal(loaded?.id, id, 'its link opens');
  assert.equal(await shim.raw('EXISTS', POINTER), 0, 'no brand cache pointer was written');
  assert.equal(await findCachedReportId(CACHE_KEY), null, 'a repeat request runs a fresh audit');
  return loaded;
}

/** The report is cached as the brand's result and names the missing content in "What was missing from this audit". */
async function assertCachedWithDisclosure(id: string, report: Report, disclosure: RegExp): Promise<void> {
  assert.equal(await shim.raw('GET', POINTER), id, 'cached as the brand result');
  assert.equal(await findCachedReportId(CACHE_KEY), id);
  assert.ok(report.warnings.some((w) => disclosure.test(w)), `the report names the missing content: ${JSON.stringify(report.warnings)}`);
  assert.equal(report.perception.metric.status, 'scored', 'the core scores are intact');
  assert.equal(report.contentGap.metric.status, 'scored');
  assert.equal(report.visibility.metric.status, 'scored');
}

test('H1-1: complete report: cached as before', async () => {
  const { id, report } = await audit();
  assert.equal((await loadJob(id))?.meta.tier, 'full', 'the full research depth ran, competitors included');
  assert.equal(report.perception.metric.status, 'scored');
  assert.equal(report.contentGap.metric.status, 'scored');
  assert.equal(await shim.raw('GET', POINTER), id);
  assert.equal(await findCachedReportId(CACHE_KEY), id);
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed ?? [], []);
});

test('H1-2: sentiment analysis fails after its retries: report kept under its id, not cached; the next audit is cached', async () => {
  failRequestsFor(SENTIMENT);
  const { id, report } = await audit();
  assert.notEqual(report.perception.metric.status, 'scored', 'perception is missing');
  await assertKeptButNotCached(id);
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['perception']);

  // Gemini recovers: a new audit of the same brand runs (nothing cached to serve) and its complete report is cached.
  state.fault = null;
  const next = await audit();
  assert.notEqual(next.id, id);
  assert.equal(next.report.perception.metric.status, 'scored');
  assert.equal(await shim.raw('GET', POINTER), next.id);
  assert.equal((await loadReport(id))?.id, id, 'the degraded report still opens by its link');
});

test('H1-3: site analysis fails after its retries: report kept, not cached', async () => {
  failRequestsFor(SITE_ANALYSIS);
  const { id, report } = await audit();
  assert.notEqual(report.contentGap.metric.status, 'scored', 'content gap is missing');
  assert.equal(report.perception.metric.status, 'scored', 'only the site analysis failed');
  await assertKeptButNotCached(id);
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['site_analysis']);
});

test('H1-4: competitor labelling fails: a supporting step, so the report is cached and says competitor sentiment is not shown', async () => {
  failRequestsFor(COMPETITOR_LABELS);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['competitors']);
  await assertCachedWithDisclosure(id, report, /competitor sentiment is not shown/i);
});

test('H1-4b: synthesis fails: cached; "The disconnect" and the missing list say the comparison could not be generated', async () => {
  failRequestsFor(SYNTHESIS);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['synthesis']);
  await assertCachedWithDisclosure(id, report, /comparison of Gemini's view and the audience's view could not be generated/);
  assert.match(report.disconnect.note ?? '', /could not be generated/);
});

test('H1-4c: fix list fails: cached; the report says recommendations could not be generated', async () => {
  failRequestsFor(FIX_LIST);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['fixes']);
  assert.equal(report.fixes.length, 0);
  assert.match(report.fixesNote ?? '', /could not be generated/);
  await assertCachedWithDisclosure(id, report, /fix list|recommendations/i);
});

test('H1-4d: claims check fails: cached; the report says Gemini\'s statements could not be checked', async () => {
  failRequestsFor(CLAIMS);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['claims']);
  assert.match(report.claimsNote ?? '', /could not be checked/);
  await assertCachedWithDisclosure(id, report, /statements were collected but could not be checked/);
});

test('H1-4e: brand profile fails: the identity check did not run, so the report is kept but not cached', async () => {
  failRequestsFor(PROFILE);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['profile']);
  assert.equal(report.identity?.status, 'unchecked');
  assert.ok(report.warnings.some((w) => /description of the brand could not be retrieved/.test(w)));
  await assertKeptButNotCached(id);
});

test('H1-5: several stages fail in one audit (core and supporting): every failure is recorded, report kept, not cached', async () => {
  failRequestsFor(SENTIMENT, SITE_ANALYSIS, COMPETITOR_LABELS);
  const { id, report } = await audit();
  assert.notEqual(report.perception.metric.status, 'scored');
  assert.notEqual(report.contentGap.metric.status, 'scored');
  await assertKeptButNotCached(id);
  const meta = (await loadJob(id))?.meta;
  assert.deepEqual(meta?.geminiStepsFailed, ['perception', 'site_analysis', 'competitors']);
  assert.deepEqual(cacheBlockers(meta ?? {}, report), ['gemini_step:perception', 'gemini_step:site_analysis'], 'competitors alone would not have blocked it');
});

test('H1-5b: only supporting stages fail (competitors, synthesis, fix list, claims together): cached, each one disclosed', async () => {
  failRequestsFor(COMPETITOR_LABELS, SYNTHESIS, FIX_LIST, CLAIMS);
  const { id, report } = await audit();
  assert.deepEqual((await loadJob(id))?.meta.geminiStepsFailed, ['claims', 'competitors', 'synthesis', 'fixes']);
  await assertCachedWithDisclosure(id, report, /competitor sentiment is not shown/i);
  for (const disclosure of [/could not be checked/, /comparison of Gemini's view and the audience's view could not be generated/]) {
    assert.ok(report.warnings.some((w) => disclosure.test(w)), String(disclosure));
  }
  assert.match(report.fixesNote ?? '', /could not be generated/);
});

test('H1-6: request-ceiling degradation after the questions: report kept, not cached (existing behaviour)', async () => {
  const id = await start();
  let limited = false;
  // Once the eight shopper questions are answered, mark the audit as having sent its limit: every later Gemini
  // request is refused by the atomic gate, so the audit finishes as a partial report.
  const last = await runToEnd(id, async () => {
    if (limited) return;
    const job = await loadJob(id);
    if (job && job.data.answers && job.data.answers.length === 8) {
      await shim.raw('SET', `si:gemini:audit:${id}`, String(GEMINI_AUDIT_REQUEST_CEILING));
      limited = true;
    }
  });
  assert.ok(limited, 'the limit was applied after the questions');
  assert.equal(last.status, 'complete');
  const meta = (await loadJob(id))?.meta;
  assert.equal(meta?.geminiCeilingReached, true);
  const report = await assertKeptButNotCached(id);
  assert.equal(report.visibility.metric.status, 'scored', 'the questions answered before the limit still count');
});

test('H1-7: an incomplete audit never replaces a valid cached pointer that appeared while it ran', async () => {
  failRequestsFor(SENTIMENT);
  const id = await start();
  const validId = 'aaaabbbbccccddddeeeeffff';
  const valid = JSON.stringify({ id: validId, version: REPORT_FORMAT_VERSION, brand: 'Glowwell' });
  // A complete report for the same brand is cached by someone else part-way through this audit.
  const last = await runToEnd(id, async (call) => {
    if (call === 2) {
      await shim.raw('SET', `si:report:v${REPORT_FORMAT_VERSION}:${validId}`, valid);
      await shim.raw('SET', POINTER, validId);
    }
  });
  assert.equal(last.status, 'complete');
  assert.equal(await shim.raw('GET', POINTER), validId, 'the valid pointer is unchanged');
  assert.equal(await shim.raw('GET', `si:report:v${REPORT_FORMAT_VERSION}:${validId}`), valid, 'the valid report is unchanged');
  assert.equal(await findCachedReportId(CACHE_KEY), validId);
  assert.equal((await loadReport(id))?.id, id, 'the incomplete report is still kept under its own id');
});

test('H1-8: one shopper question failing on its own does not block caching (visibility is still measured)', async () => {
  state.failQuestionContaining = 'luxury skincare';
  const { id, report } = await audit();
  assert.equal(report.visibility.metric.status, 'scored');
  assert.ok(((await loadJob(id))?.meta.geminiStepsFailed ?? []).every((step) => step.startsWith('ask:')));
  assert.equal(await shim.raw('GET', POINTER), id);
});

test('H1-9: cacheBlockers rules: an explicit allow-list of supporting steps; anything else blocks', () => {
  const scored = { visibility: { metric: { status: 'scored' } } } as unknown as Report;
  const unscored = { visibility: { metric: { status: 'insufficient' } } } as unknown as Report;
  assert.deepEqual([...SUPPORTING_GEMINI_STEPS].sort(), ['claims', 'competitors', 'fixes', 'questions', 'signature', 'synthesis']);
  assert.deepEqual(cacheBlockers({}, scored), []);
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: [] }, scored), []);
  for (const step of SUPPORTING_GEMINI_STEPS) assert.deepEqual(cacheBlockers({ geminiStepsFailed: [step] }, scored), [], step);
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: ['competitors', 'synthesis', 'fixes', 'claims', 'signature', 'questions'] }, scored), []);
  for (const step of ['profile', 'perception', 'site_analysis']) assert.deepEqual(cacheBlockers({ geminiStepsFailed: [step] }, scored), [`gemini_step:${step}`], step);
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: ['some_new_step'] }, scored), ['gemini_step:some_new_step'], 'an unknown or new step blocks by default');
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: ['ask:q3'] }, scored), [], 'a failed question alone is reflected in visibility, not a blocker');
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: ['ask:q3', 'ask:q4', 'ask:q5', 'ask:q6'] }, unscored), ['gemini_questions']);
  assert.deepEqual(cacheBlockers({ geminiStepsFailed: ['fixes', 'ask:q1'] }, unscored), ['gemini_questions']);
  assert.deepEqual(cacheBlockers({ geminiCeilingReached: true }, scored), ['gemini_ceiling']);
  assert.deepEqual(cacheBlockers({ geminiCeilingReached: true, geminiStepsFailed: ['site_analysis', 'fixes', 'ask:q1'] }, scored), ['gemini_ceiling', 'gemini_step:site_analysis']);
});
