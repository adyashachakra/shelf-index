// The per-audit Gemini request ceiling (Stage 2): one audit may send at most GEMINI_AUDIT_REQUEST_CEILING (60)
// requests. The 61st is never sent. The audit keeps what it has finished, marks the rest unavailable (never as a
// zero), says why in its report, and its report is not saved as the cached result for the brand.
//
// Redis and its Lua scripts are REAL (a local redis-server behind the Upstash REST shim). Gemini, Tavily and
// YouTube are SIMULATED (tests/helpers/mock-apis.ts). Nothing here contacts a real service, so these tests prove
// the app's logic only: not how Google counts requests, not what Google's 429 replies really say, and not that
// the script runs on Upstash itself.
import assert from 'node:assert/strict';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { createContext } from '../lib/audit/context';
import { askQuestionPrompt } from '../lib/audit/prompts';
import { loadJob, saveMeta } from '../lib/cache/jobs';
import { findCachedReportId, loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { GEMINI_AUDIT_REQUEST_CEILING, READABLE_REPORT_VERSIONS, REPORT_FORMAT_VERSION, USER_MESSAGES } from '../lib/config';
import { auditCounterKey, geminiRequestsForAudit, geminiRequestsToday } from '../lib/quota/gemini-limiter';
import { quotaSnapshot } from '../lib/quota/reservations';
import { GEMINI_SLOT_SCRIPT } from '../lib/quota/scripts';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockFault, type MockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
let logged: string[] = [];
const realLog = console.log;
let ipCounter = 0;

before(async () => {
  shim = await startShim(6399, 10);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3';
  process.env.PER_VISITOR_DAILY_LIMIT = '1';
  state = newMockState();
  restoreFetch = installMockFetch(state, shim.url);
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  await shim.close();
});
beforeEach(async () => {
  await shim.flush();
  resetGeminiFeatureMemory();
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  state.generateCalls = 0;
  state.generateBodies = [];
  state.fault = null;
  state.rejectJsonSchemaOnce = false;
  state.rateLimitOnce = false;
  state.failQuestionContaining = null;
  shim.intercept = null;
  shim.sent.length = 0;
  shim.executed.length = 0;
  logged = [];
});
afterEach(() => {
  shim.intercept = null;
});

// ---------- helpers ----------

function input(brand = 'Glowwell', category = 'skincare', customCategory?: string) {
  const parsed = validateAuditInput({ brand, category, customCategory });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

/** Start an audit from a fresh visitor address (the per-visitor limit is 1 a day). */
async function begin(brand = 'Glowwell', category = 'skincare', customCategory?: string): Promise<string> {
  ipCounter += 1;
  const started = await startAudit(input(brand, category, customCategory), `203.0.113.${ipCounter}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') throw new Error('not started');
  return started.body.id;
}

/** Advance until the audit is complete, failed or paused, skipping real-time waits. */
async function runToEnd(id: string, maxCalls = 400): Promise<{ last: JobSnapshot; waits: string[] }> {
  const waits: string[] = [];
  for (let calls = 0; calls < maxCalls; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds && snapshot.waitReason) {
      waits.push(snapshot.waitReason);
      if (snapshot.status === 'paused') return { last: snapshot, waits };
      await shim.raw('DEL', 'si:gemini:cooldown');
    }
    if (snapshot.status === 'complete' || snapshot.status === 'failed' || snapshot.status === 'paused') {
      return { last: snapshot, waits };
    }
  }
  throw new Error('the audit did not finish');
}

async function loadMeta(id: string) {
  const job = await loadJob(id);
  assert.ok(job);
  return job.meta;
}

async function geminiKeys(): Promise<Record<string, string | null>> {
  const keys = ((await shim.raw('KEYS', 'si:gemini:*')) as string[]).sort();
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = (await shim.raw('GET', key)) as string | null;
  return out;
}

const isGeminiSlotScript = (args: string[]) => args[0] === 'EVAL' && args[1] === GEMINI_SLOT_SCRIPT;

/** A per-minute rate limit, worded like Google's (the mock's own wording). */
const PER_MINUTE_429: MockFault = {
  status: 429,
  body: {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded. Please retry in 7.5s.',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
      ],
    },
  },
};

/** Gemini answers the first `n` requests normally, then rate-limits every request after that. */
function succeedThenRateLimit(n: number): void {
  state.fault = (number) => (number > n ? PER_MINUTE_429 : null);
}

const ceilingLogs = () => logged.filter((line) => line.includes('gemini_ceiling_reached'));

/** The request steps in the order a normal audit makes them (verified against a healthy run's ledger). */
const NORMAL_STEPS = ['profile', 'ask:q1', 'ask:q2', 'ask:q3', 'ask:q4', 'ask:q5', 'ask:q6', 'ask:q7', 'ask:q8', 'perception', 'site_analysis', 'signature', 'claims', 'competitors', 'synthesis', 'fixes'];

// ---------- the constant itself ----------

test('the ceiling is 60, a code constant, and it sits above everything the existing 3-attempt rule allows', () => {
  assert.equal(GEMINI_AUDIT_REQUEST_CEILING, 60);
  const largestByAttemptRule = 17 * 3; // an "Other" audit asks 17 things, each at most 3 attempts
  assert.ok(GEMINI_AUDIT_REQUEST_CEILING > largestByAttemptRule, 'the ceiling must not override the 3-attempt rule');
  assert.equal(REPORT_FORMAT_VERSION, 8, 'Stage 2 keeps report format 8');
  assert.deepEqual([...READABLE_REPORT_VERSIONS], [8, 7, 6, 5, 4, 3, 2]);
});

// ---------- 3b / 6a: a failing provider: exactly 60 requests, then a partial report ----------

test('3b/6a. 9 answers, then a 429 on every request: exactly 60 are sent, the 61st never reaches Gemini, finished work is kept, the rest is unavailable (not zero)', async () => {
  succeedThenRateLimit(9); // the profile and all 8 questions answer; everything after is rate-limited
  const id = await begin();
  const { last, waits } = await runToEnd(id);

  assert.equal(last.status, 'complete', 'the audit still finishes, with a partial report');
  assert.equal(state.generateCalls, 60, 'exactly 60 requests reached Gemini');
  assert.equal(await geminiRequestsForAudit(id), 60, 'the Redis audit counter agrees');
  assert.equal(await geminiRequestsToday(), 60, 'so does the day counter');
  assert.ok(waits.includes('Gemini asked us to slow down'), 'each 429 was a visible wait, as before');

  const meta = await loadMeta(id);
  assert.equal(meta.geminiCeilingReached, true);
  assert.equal(meta.geminiRequests, 60);
  assert.equal(ceilingLogs().length, 1, 'the ceiling is logged once');

  const report = (await loadReport(id)) as Report;
  assert.equal(report.version, 8);
  assert.equal(report.methodology.geminiRequests, 60);
  const outcomes = report.methodology.geminiRequestOutcomes ?? {};
  assert.equal(outcomes.ok, 9);
  assert.equal(outcomes.http_429, 51);
  assert.equal(outcomes.interrupted, undefined, 'every request has a recorded outcome');

  // The reason is stated first, in the list of what was missing.
  assert.equal(report.warnings[0], USER_MESSAGES.geminiCeiling);
  assert.ok(report.methodology.unavailable.includes(USER_MESSAGES.geminiCeiling));
  assert.match(USER_MESSAGES.geminiCeiling, /limit of 60 Gemini requests/);
  assert.match(USER_MESSAGES.geminiCeiling, /not saved as the cached result/);

  // Finished work is preserved...
  assert.equal(report.answers.filter((a) => a.status === 'answered').length, 8, 'all 8 answers are kept');
  assert.equal(report.visibility.metric.status, 'scored', 'the visibility score rests on the answers that were collected');
  assert.ok(report.brandProfile, "Gemini's description of the brand is kept");
  // ...and what had not finished is unavailable, not scored as zero.
  assert.notEqual(report.perception.metric.status, 'scored', 'audience perception was not analysed, so it has no score');
  assert.notEqual(report.contentGap.metric.status, 'scored', 'the site analysis did not run, so content gap has no score');
  assert.equal(report.fixes.length, 0);
  assert.equal(report.fixesNote, 'Recommendations could not be generated for this audit.');
  assert.equal(report.disconnect.status, 'cannot_assess');
  assert.ok(report.warnings.length > 1, 'each unfinished step says that it is unavailable');
});

test('6a (mid-question). the ceiling arrives while questions are being asked: the answered ones stay answered, the rest say why they were not answered', async () => {
  succeedThenRateLimit(3); // the profile, question 1 and question 2 answer; question 3 meets rate limits
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 60);
  assert.equal(await geminiRequestsForAudit(id), 60);

  const report = (await loadReport(id)) as Report;
  const answered = report.answers.filter((a) => a.status === 'answered');
  const failed = report.answers.filter((a) => a.status === 'failed');
  assert.equal(answered.length, 2);
  assert.equal(failed.length, 6);
  for (const answer of failed) {
    assert.equal(answer.failureReason, USER_MESSAGES.geminiCeilingQuestion, 'not "after 3 attempts": that would be untrue');
    assert.ok(!answer.recommendations?.length, 'a question that was not answered recommends nothing');
  }
  assert.equal(report.methodology.questions.answered, 2);
  assert.equal(report.methodology.questions.failed, 6);
  assert.equal(report.warnings[0], USER_MESSAGES.geminiCeiling);
  // Missing data is not the brand being absent: no question is counted as "not named".
  assert.equal(report.methodology.questions.counted, 2);
});

// ---------- 6b: the ceiling before any answer ----------

test('6b. the ceiling before any question is answered: a cause-aware stop, nothing is sent after 60, and the audit keeps its slots (Q-B)', async () => {
  succeedThenRateLimit(0);
  const id = await begin();
  const { last } = await runToEnd(id);

  assert.equal(last.status, 'failed');
  assert.equal(last.error, USER_MESSAGES.geminiCeilingNoAnswers);
  assert.doesNotMatch(String(last.error), /after 3 attempts/);
  assert.equal(state.generateCalls, 60);
  assert.equal(await geminiRequestsForAudit(id), 60);
  assert.equal(ceilingLogs().length, 1);

  const meta = await loadMeta(id);
  assert.equal(meta.geminiCeilingReached, true);
  assert.equal(meta.status, 'failed');
  // Q-B: the slot is not handed back. (In this realistic path research credits were already spent before the
  // questions were asked, which alone keeps the slot; the next two tests cover the paths where nothing was spent.)
  assert.equal((await quotaSnapshot()).scansToday, 1, 'the day still has one fewer slot');
  const again = await startAudit(input(), `203.0.113.${ipCounter}`); // the same visitor address again
  assert.equal(again.body.status, 'error');
  if (again.body.status === 'error') assert.equal(again.body.code, 'visitor_limit', 'the visitor still cannot re-run the same day');
});

test('6b (control). an ordinary failure that is NOT the ceiling, before anything is spent (400 on every request: a setup stop), still returns the slot, exactly as before', async () => {
  state.fault = () => ({ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } } });
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'failed');
  assert.equal((await loadMeta(id)).geminiCeilingReached, undefined);
  assert.equal((await quotaSnapshot()).scansToday, 0, 'unchanged behaviour: nothing was spent, so the daily slot goes back');
});

test('6b (Q-B, nothing else spent). the same kind of early failure AFTER the ceiling does not return the slot: the audit did spend 60 Gemini requests', async () => {
  // Gemini rate-limits every request, so the audit reaches its ceiling at the first step. Then Tavily's monthly
  // allowance turns out to be used up, which ends the audit before any research credit was spent.
  succeedThenRateLimit(0);
  state.tavilyQuotaExhausted = true;
  const id = await begin();
  const { last } = await runToEnd(id);
  state.tavilyQuotaExhausted = false;
  assert.equal(last.status, 'failed');
  assert.equal(state.generateCalls, 60);
  const meta = await loadMeta(id);
  assert.equal(meta.geminiCeilingReached, true);
  assert.equal(meta.creditsSpent, 0, 'no research credit was spent');
  assert.equal((await quotaSnapshot()).scansToday, 1, 'Q-B: the slot is kept');
});

test('6b (same early failure, no ceiling). with Tavily out of allowance and Gemini healthy, nothing is spent and the slot goes back, as before', async () => {
  state.tavilyQuotaExhausted = true;
  const id = await begin();
  const { last } = await runToEnd(id);
  state.tavilyQuotaExhausted = false;
  assert.equal(last.status, 'failed');
  assert.equal((await loadMeta(id)).geminiCeilingReached, undefined);
  assert.equal((await loadMeta(id)).creditsSpent, 0);
  assert.equal((await quotaSnapshot()).scansToday, 0, 'unchanged behaviour');
});

test('6b (typed-in category). the ceiling arrives while the category\'s questions are being written: still exactly 60, then a cause-aware stop', async () => {
  succeedThenRateLimit(0);
  const id = await begin('Glowwell', 'other', 'luxury candles');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'failed');
  assert.equal(last.error, USER_MESSAGES.geminiCeilingNoAnswers);
  assert.equal(state.generateCalls, 60);
  assert.equal(await geminiRequestsForAudit(id), 60);
  assert.equal((await loadMeta(id)).geminiCeilingReached, true);
});

// ---------- 6c: nothing more is sent, and no Redis call is made to ask, after the ceiling ----------

test('6c. after the ceiling, further advances send nothing and do not even ask Redis for a slot; the counters do not move', async () => {
  succeedThenRateLimit(9);
  const id = await begin();
  // Advance until the ceiling has been reached but the audit is still running.
  let sawCeilingWhileRunning = false;
  for (let calls = 0; calls < 200; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot);
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    const meta = await loadMeta(id);
    if (meta.geminiCeilingReached && meta.status === 'running') {
      sawCeilingWhileRunning = true;
      break;
    }
    if (snapshot.status === 'complete') break;
  }
  assert.ok(sawCeilingWhileRunning, 'the audit should reach its ceiling while stages are still left to run');

  const mockBefore = state.generateCalls;
  const keysBefore = await geminiKeys();
  const gateCallsBefore = shim.sent.filter(isGeminiSlotScript).length;
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, mockBefore, 'not one more request reached Gemini');
  assert.equal(shim.sent.filter(isGeminiSlotScript).length, gateCallsBefore, 'the gate was not even asked: the saved flag answers at once');
  assert.deepEqual(await geminiKeys(), keysBefore, 'no Gemini counter changed');
  assert.equal(state.generateCalls, 60);
  assert.equal(ceilingLogs().length, 1);

  // Calling a finished audit again is only a read.
  await advanceJob(id);
  await advanceJob(id);
  assert.equal(state.generateCalls, 60);
  assert.equal(await geminiRequestsForAudit(id), 60);
});

// ---------- 6d: a ceiling-hit report is not cached ----------

test('6d. a ceiling-hit report opens by its id and is stored for 7 days, but is not cached: no pointer exists and a repeat audit of the brand can start', async () => {
  succeedThenRateLimit(9);
  const id = await begin();
  const input1 = input();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');

  const report = await loadReport(id);
  assert.ok(report, 'the visitor can open the report by its link');
  assert.equal(report.version, 8);
  assert.equal(await findCachedReportId(input1.cacheKey), null, 'no cached report for this brand and category');
  assert.deepEqual(await shim.raw('KEYS', 'si:cache:*'), [], 'no cache pointer was written at all');
  const reportKeys = (await shim.raw('KEYS', 'si:report:*')) as string[];
  assert.deepEqual(reportKeys, [`si:report:v8:${id}`]);
  const ttl = Number(await shim.raw('TTL', reportKeys[0]));
  assert.ok(ttl > 6 * 24 * 3600 && ttl <= 7 * 24 * 3600, `the report keeps the same 7-day expiry (ttl ${ttl}s)`);

  // A repeat audit of the same brand and category (from a different visitor) is neither "cached" nor "in progress".
  state.fault = null;
  ipCounter += 1;
  const second = await startAudit(input(), `203.0.113.${ipCounter}`);
  assert.equal(second.body.status, 'started', 'not cached, not in progress: a new audit starts');
  if (second.body.status === 'started') assert.notEqual(second.body.id, id);
});

test('6d (Q-B). a ceiling-hit audit keeps its daily and visitor slots: its visitor cannot re-run the same day', async () => {
  succeedThenRateLimit(9);
  const id = await begin();
  await runToEnd(id);
  assert.equal((await quotaSnapshot()).scansToday, 1);
  state.fault = null;
  const sameVisitor = await startAudit(input(), `203.0.113.${ipCounter}`);
  assert.equal(sameVisitor.body.status, 'error');
  if (sameVisitor.body.status === 'error') assert.equal(sameVisitor.body.code, 'visitor_limit');
});

// ---------- 6e: a normal audit is still cached ----------

test('6e. a healthy audit is unchanged: 16 requests, no ceiling, no ceiling warning, cached for repeat audits', async () => {
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  const meta = await loadMeta(id);
  assert.equal(meta.geminiCeilingReached, undefined, 'the flag is never set unless a request was actually refused');
  assert.equal(ceilingLogs().length, 0);

  const report = (await loadReport(id)) as Report;
  assert.equal(report.methodology.geminiRequests, 16);
  assert.ok(!report.warnings.includes(USER_MESSAGES.geminiCeiling));
  assert.ok(!report.methodology.unavailable.includes(USER_MESSAGES.geminiCeiling));

  assert.equal(await findCachedReportId(input().cacheKey), id, 'the report is cached for this brand');
  assert.deepEqual(await shim.raw('KEYS', 'si:cache:*'), [`si:cache:v8:${input().cacheKey}`]);
  ipCounter += 1;
  const repeat = await startAudit(input(), `203.0.113.${ipCounter}`);
  assert.deepEqual(repeat.body, { status: 'cached', id });
  assert.equal(state.generateCalls, 16, 'serving the cached report sends nothing');
});

// ---------- 8b: repeated interruptions cannot get past the ceiling ----------

test('8b. an audit that is interrupted over and over, with its saved state lost each time, still stops at 60 requests however often it is resumed', async () => {
  succeedThenRateLimit(0); // every request is rate-limited, so every advance wants one more request
  const id = await begin();
  for (let round = 0; round < 90; round += 1) {
    await advanceJob(id);
    await shim.raw('DEL', 'si:gemini:cooldown');
    // The function "was killed before it saved": the saved flag, count and ledger go back to empty, and the audit
    // is resumable again. Only the Redis audit counter remembers.
    const job = await loadJob(id);
    assert.ok(job);
    await saveMeta({ ...job.meta, geminiRequests: 0, geminiLedger: undefined, geminiCeilingReached: undefined, status: 'running', error: undefined });
  }
  assert.equal(state.generateCalls, 60, 'never more than 60 requests, however many times the audit is resumed');
  assert.equal(await geminiRequestsForAudit(id), 60);
  assert.equal(await geminiRequestsToday(), 60);
  // The Redis counter is the authority: the later attempts were refused by the gate, and a refusal writes nothing.
  assert.ok(shim.sent.filter(isGeminiSlotScript).length > 60, 'later attempts were turned away by the gate');
});

// ---------- break-it tests ----------

test('boundary. the 60th request is sent; the 61st is refused, never sent, and writes nothing', async () => {
  const id = await begin();
  await shim.raw('SET', auditCounterKey(id), '59');
  const job = await loadJob(id);
  assert.ok(job);
  job.meta.geminiRequests = 59;
  const ctx = createContext(job.meta, job.data, Date.now() + 42_000);

  const sixtieth = await ctx.gemini(askQuestionPrompt('Which brands are best?'), 'boundary:a');
  assert.ok(sixtieth, 'request 60 is allowed and answered');
  assert.equal(state.generateCalls, 1);
  assert.equal(await geminiRequestsForAudit(id), 60);
  assert.equal(job.meta.geminiCeilingReached, undefined, 'reaching 60 is not "hitting the ceiling": nothing was refused');

  const keysBefore = await geminiKeys();
  const gateCallsBefore = shim.sent.filter(isGeminiSlotScript).length;
  const sixtyFirst = await ctx.gemini(askQuestionPrompt('Which brands are best?'), 'boundary:b');
  assert.equal(sixtyFirst, null);
  assert.equal(state.generateCalls, 1, 'the 61st never reached Gemini');
  assert.equal(job.meta.geminiCeilingReached, true);
  assert.deepEqual(await geminiKeys(), keysBefore, 'a refusal writes nothing');
  assert.equal(shim.sent.filter(isGeminiSlotScript).length, gateCallsBefore, 'the app already knows it has sent 60, so it does not even ask Redis');
});

test('boundary (stale in-memory count). when the saved count lags behind Redis, the gate still refuses the 61st request', async () => {
  const id = await begin();
  await shim.raw('SET', auditCounterKey(id), '60'); // Redis knows 60
  const job = await loadJob(id);
  assert.ok(job);
  job.meta.geminiRequests = 12; // the saved state is far behind (an interrupted function)
  const ctx = createContext(job.meta, job.data, Date.now() + 42_000);
  const result = await ctx.gemini(askQuestionPrompt('Which brands are best?'), 'stale');
  assert.equal(result, null);
  assert.equal(state.generateCalls, 0, 'nothing was sent');
  assert.equal(job.meta.geminiCeilingReached, true);
  assert.equal(job.meta.geminiRequests, 60, 'the in-memory count is corrected from Redis');
  assert.equal(shim.sent.filter(isGeminiSlotScript).length, 1, 'this one took exactly one gate call');
});

test('boundary (mid-ladder). the ceiling arrives in the middle of the HTTP 400 format ladder: a soft stop, not a "setup problem"', async () => {
  const id = await begin();
  await shim.raw('SET', auditCounterKey(id), '57'); // three requests left
  state.fault = () => ({ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } } });
  const job = await loadJob(id);
  assert.ok(job);
  job.meta.geminiRequests = 57;
  const ctx = createContext(job.meta, job.data, Date.now() + 42_000);
  const result = await ctx.gemini(askQuestionPrompt('Which brands are best?'), 'ladder');
  assert.equal(result, null, 'the ceiling ends the step softly; the 400 ladder (6 requests) never got to finish');
  assert.equal(state.generateCalls, 3, 'exactly the three requests that were left, then no more');
  assert.equal(await geminiRequestsForAudit(id), 60);
  assert.equal(job.meta.geminiCeilingReached, true);
  assert.equal(logged.filter((line) => line.includes('gemini_setup_problem')).length, 0, 'not reported as a setup problem');
});

test('the worst case the existing 3-attempt rule allows for a typed-in category (51 requests) never reaches the ceiling', async () => {
  // Every logical call fails twice with a 503 and succeeds on its third request: 17 calls x 3 requests.
  state.fault = (number) => (number % 3 === 0 ? null : { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } } });
  const id = await begin('Glowwell', 'other', 'running shoes');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 51, '17 calls, 3 requests each');
  assert.equal(await geminiRequestsForAudit(id), 51);
  assert.equal((await loadMeta(id)).geminiCeilingReached, undefined, '51 is below 60: the ceiling does not override the retry rule');
  assert.equal(await findCachedReportId(input('Glowwell', 'other', 'running shoes').cacheKey), id, 'so the report is cached as usual');
});

test('precedence. the ceiling wins over an active cooldown: it is a stop, not a wait', async () => {
  const id = await begin();
  await shim.raw('SET', auditCounterKey(id), '60');
  await shim.raw('SET', 'si:gemini:cooldown', String(Date.now() + 60_000), 'EX', '60');
  const job = await loadJob(id);
  assert.ok(job);
  const ctx = createContext(job.meta, job.data, Date.now() + 42_000);
  assert.equal(await ctx.gemini(askQuestionPrompt('Which brands are best?'), 'precedence'), null, 'no WaitSignal: waiting would never help');
  assert.equal(job.meta.geminiCeilingReached, true);
});

test('an audit that has not hit the ceiling is not affected by one that has: counters and flags are per audit', async () => {
  succeedThenRateLimit(9);
  const first = await begin();
  await runToEnd(first);
  assert.equal(await geminiRequestsForAudit(first), 60);

  state.fault = null;
  state.generateCalls = 0;
  const second = await begin(); // the first audit was not cached, so the same brand can be audited again
  const { last } = await runToEnd(second);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  assert.equal(await geminiRequestsForAudit(second), 16);
  assert.equal((await loadMeta(second)).geminiCeilingReached, undefined);
  assert.equal(await geminiRequestsForAudit(first), 60, 'the first audit stays at 60');
  assert.equal(await geminiRequestsToday(), 76, 'the day counter is the sum of the audits');
});

test('the audit store failing is never mistaken for the ceiling: nothing is flagged and the audit is not stopped', async () => {
  const id = await begin();
  shim.intercept = (args) => (isGeminiSlotScript(args) ? { error: 'ERR max requests limit exceeded. Limit: 500000, Usage: 500000', status: 400 } : null);
  let signalled = false;
  for (let i = 0; i < 6 && !signalled; i += 1) {
    try {
      await advanceJob(id); // the first stages ask Gemini nothing; the profile stage is the first that does
    } catch (err) {
      signalled = (err as Error).name === 'StorageSignal';
      assert.ok(signalled, `unexpected error: ${(err as Error).message}`);
    }
  }
  assert.ok(signalled, 'the failed approval surfaced as a storage problem');
  shim.intercept = null;
  const meta = await loadMeta(id);
  assert.equal(meta.geminiCeilingReached, undefined);
  assert.equal(meta.status, 'running');
  assert.equal(state.generateCalls, 0);
  assert.equal(ceilingLogs().length, 0);
});

test('a saved audit from before Stage 2 (no ceiling field at all) is advanced exactly as before', async () => {
  const id = await begin();
  for (let i = 0; i < 3; i += 1) await advanceJob(id);
  const job = await loadJob(id);
  assert.ok(job);
  assert.equal(job.meta.geminiCeilingReached, undefined);
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
});

test('Redis cost of an audit that hits the ceiling stays inside the planning bound (1,500 commands, billed as Upstash bills)', async () => {
  succeedThenRateLimit(9);
  await shim.raw('CONFIG', 'RESETSTAT');
  const id = await begin();
  await runToEnd(id);
  const info = String(await shim.raw('INFO', 'commandstats'));
  let total = 0;
  for (const line of info.split('\n')) {
    const match = /^cmdstat_(\w+):calls=(\d+)/.exec(line.trim());
    if (match && !['config', 'info', 'flushdb', 'select', 'keys', 'ttl'].includes(match[1])) total += Number(match[2]);
  }
  console.log = realLog;
  realLog(`      [info] commands billed for one ceiling-hit audit (60 requests): about ${total}`);
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  assert.ok(total > 0 && total <= 1500, `a ceiling-hit audit used ${total} commands`);
});
