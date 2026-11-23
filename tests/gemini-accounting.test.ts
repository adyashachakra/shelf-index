// Gemini request accounting (Stage 1): every outbound Gemini request is counted once, atomically, before it is
// sent; a refused request is never sent and consumes nothing; and when the audit store (Redis/Upstash) cannot
// approve a request, nothing is sent and nothing is counted (fail closed).
//
// Redis and its Lua scripts are REAL (a local redis-server behind the Upstash REST shim). Gemini, Tavily and
// YouTube are SIMULATED (tests/helpers/mock-apis.ts). Nothing here contacts a real service, so these tests prove
// the app's logic only: not how Google counts requests, not Upstash's real error replies, and not that the script
// runs on Upstash itself.
//
// Accounting tests. The per-audit ceiling (60) is tested in tests/gemini-ceiling.test.ts. Here it only appears where a
// test hands the gate a limit directly (0 = none, or 60 in I3c); the audits in this file never come near 60 requests.
import assert from 'node:assert/strict';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { POST as advanceRoute } from '../app/api/audits/[id]/advance/route';
import { PauseSignal, StorageSignal, WaitSignal } from '../lib/audit/context';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { loadJob } from '../lib/cache/jobs';
import { loadReport } from '../lib/cache/reports';
import { generateJson, resetGeminiFeatureMemory, type RequestGate, type RequestOutcome } from '../lib/clients/gemini';
import { USER_MESSAGES } from '../lib/config';
import {
  acquireGeminiSlot,
  auditCounterKey,
  geminiRequestsForAudit,
  geminiRequestsToday,
  isGeminiDailyExhausted,
} from '../lib/quota/gemini-limiter';
import { GEMINI_SLOT_SCRIPT } from '../lib/quota/scripts';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
let logged: string[] = [];
const realLog = console.log;
let ipCounter = 0;

before(async () => {
  shim = await startShim(6399, 9);
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

async function begin(brand = 'Glowwell', category = 'skincare', customCategory?: string): Promise<string> {
  ipCounter += 1;
  const started = await startAudit(input(brand, category, customCategory), `203.0.113.${ipCounter}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') throw new Error('not started');
  return started.body.id;
}

/** Advance until the audit is complete, failed or paused (skipping real-time waits). */
async function runToEnd(id: string, maxCalls = 150): Promise<{ last: JobSnapshot; waits: string[] }> {
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

/** Every si:gemini:* key and its value: used to prove that "nothing changed". */
async function geminiKeys(): Promise<Record<string, string | null>> {
  const keys = ((await shim.raw('KEYS', 'si:gemini:*')) as string[]).sort();
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = (await shim.raw('GET', key)) as string | null;
  return out;
}

async function sumOfAuditCounters(): Promise<number> {
  const keys = (await shim.raw('KEYS', 'si:gemini:audit:*')) as string[];
  let sum = 0;
  for (const key of keys) sum += Number((await shim.raw('GET', key)) ?? 0);
  return sum;
}

async function loadMeta(id: string) {
  const job = await loadJob(id);
  assert.ok(job);
  return job.meta;
}

const isGeminiSlotScript = (args: string[]) => args[0] === 'EVAL' && args[1] === GEMINI_SLOT_SCRIPT;
const QUOTA_ERROR =
  'ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details';

function fakeGate(): { gate: RequestGate; outcomes: RequestOutcome[]; granted: () => number } {
  const outcomes: RequestOutcome[] = [];
  let granted = 0;
  return {
    outcomes,
    granted: () => granted,
    gate: {
      async beforeRequest() {
        const slot = await acquireGeminiSlot('gate-test', 0);
        if (!slot.ok) throw new Error(`refused:${slot.kind}`);
        granted += 1;
      },
      afterRequest(outcome) {
        outcomes.push(outcome);
      },
    },
  };
}

const parseAnything = (value: unknown) => value;
const SCHEMA = { type: 'object', properties: {} };
const request = (gate: RequestGate) => ({ label: 'gate_test', system: 'answering a shopper', user: 'hello', schema: SCHEMA, parse: parseAnything, gate });

// ---------- 1. healthy audits: the count equals the requests the mock really received (I1) ----------

test('1. a healthy normal audit: the Redis counter, the day counter and the report all equal the requests the mock received (I1)', async () => {
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');

  assert.equal(state.generateCalls, 16, 'a normal audit asks Gemini 16 things, once each');
  assert.equal(await geminiRequestsForAudit(id), state.generateCalls);
  assert.equal(await geminiRequestsToday(), state.generateCalls);
  const report = (await loadReport(id)) as Report;
  assert.equal(report.version, 9);
  assert.equal(report.methodology.geminiRequests, state.generateCalls);
  assert.deepEqual(report.methodology.geminiRequestOutcomes, { ok: 16 });
  const meta = await loadMeta(id);
  assert.equal(meta.geminiLedger?.started, 16);
  assert.equal(meta.attempts.profile, undefined, 'no step needed a retry');
  assert.ok(Object.keys(meta.attempts).every((key) => key.startsWith('competitor:')), 'only the existing per-competitor markers');
});

test('1b. a healthy "Other" audit asks 17 things and is counted the same way (I1)', async () => {
  const id = await begin('Glowwell', 'other', 'running shoes');
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 17);
  assert.equal(await geminiRequestsForAudit(id), 17);
  assert.equal(await geminiRequestsToday(), 17);
  assert.equal(((await loadReport(id)) as Report).methodology.geminiRequests, 17);
});

// ---------- 2. HTTP 400: format-negotiation retries are counted ----------

test('2a. an HTTP 400 that is rejected once: the retry is counted, and it is not a step attempt', async () => {
  state.rejectJsonSchemaOnce = true;
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 17, '16 questions plus one rejected request');
  assert.equal(await geminiRequestsForAudit(id), 17);
  assert.equal(await geminiRequestsToday(), 17);
  const report = (await loadReport(id)) as Report;
  assert.equal(report.methodology.geminiRequests, 17);
  assert.deepEqual(report.methodology.geminiRequestOutcomes, { http_400: 1, ok: 16 });
  assert.equal((await loadMeta(id)).attempts.profile, undefined, 'a format retry is not one of the 3 attempts of its step (the 400 hit the first request, the profile step)');
});

test('2b. HTTP 400 on every request: 6 requests (one format ladder), then the existing setup stop; all 6 are counted', async () => {
  state.fault = () => ({ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload. Unknown name "responseJsonSchema" at generation_config' } } });
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'failed');
  assert.equal(state.generateCalls, 6);
  assert.equal(await geminiRequestsForAudit(id), 6);
  assert.equal(await geminiRequestsToday(), 6);
  assert.equal((await loadMeta(id)).geminiLedger?.outcomes.http_400, 6);
});

test('2c. a format retry that meets an active cooldown is refused, not sent; the learned format is kept for the next request', async () => {
  let n = 0;
  state.fault = (_number, body) => {
    n += 1;
    const generation = (body.generationConfig ?? {}) as Record<string, unknown>;
    return n === 1 && generation.responseJsonSchema !== undefined
      ? { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "responseJsonSchema" at generation_config' } } }
      : null;
  };
  const gate = fakeGate();
  const refusing: RequestGate = {
    async beforeRequest() {
      // Just before the retry, a different audit's 429 sets the shared cooldown.
      if (gate.granted() === 1) await shim.raw('SET', 'si:gemini:cooldown', String(Date.now() + 60_000), 'EX', '60');
      await gate.gate.beforeRequest();
    },
    afterRequest: gate.gate.afterRequest,
  };
  await assert.rejects(generateJson(request(refusing)), /refused:wait/);
  assert.equal(state.generateCalls, 1, 'only the first request was sent');
  assert.equal(await geminiRequestsForAudit('gate-test'), 1, 'the refused retry consumed nothing');
  assert.deepEqual(gate.outcomes, ['http_400']);

  await shim.raw('DEL', 'si:gemini:cooldown');
  const answered = await generateJson(request(gate.gate));
  assert.ok(answered);
  const retryBody = state.generateBodies[1];
  assert.equal(((retryBody.generationConfig ?? {}) as Record<string, unknown>).responseJsonSchema, undefined, 'the downgraded format was kept');
  assert.equal(await geminiRequestsForAudit('gate-test'), 2);
  assert.equal(state.generateCalls, 2);
});

// ---------- 3. HTTP 429 ----------

test('3a. one per-minute 429: counted, becomes a visible wait, and the audit recovers', async () => {
  state.rateLimitOnce = true;
  const id = await begin();
  const { last, waits } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.ok(waits.includes('Gemini asked us to slow down'));
  assert.equal(state.generateCalls, 17);
  assert.equal(await geminiRequestsForAudit(id), 17);
  assert.equal(await geminiRequestsToday(), 17);
  assert.equal(((await loadReport(id)) as Report).methodology.geminiRequestOutcomes?.http_429, 1);
});

test('3c. a daily-style 429: counted, the audit pauses, the provider-daily marker is set, and the next request is refused and not sent (I3)', async () => {
  state.fault = (number) =>
    number === 3
      ? { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } }
      : null;
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'paused');
  assert.equal(await isGeminiDailyExhausted(), true);
  assert.equal(state.generateCalls, 3);
  assert.equal(await geminiRequestsForAudit(id), 3);

  const before = await geminiKeys();
  await advanceJob(id);
  await advanceJob(id);
  assert.equal(state.generateCalls, 3, 'nothing was sent while the provider-daily marker is set');
  assert.deepEqual(await geminiKeys(), before, 'and nothing was counted');
});

// ---------- 4 and 5. 503, timeouts, network errors ----------

test('4a. a step that always gets 503: 3 requests for it, all counted, recorded as failed', async () => {
  state.failQuestionContaining = 'luxury skincare';
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 15 + 3);
  assert.equal(await geminiRequestsForAudit(id), state.generateCalls);
  const meta = await loadMeta(id);
  assert.equal(meta.attempts['ask:q8'], 3);
  assert.equal(meta.geminiLedger?.steps['ask:q8'], 3);
  assert.equal(meta.geminiLedger?.outcomes.http_5xx, 3);
});

test('4b. 503 on every request: never more than the 48 the 3-attempt rule allows, and the counters equal the mock (I1)', async () => {
  state.fault = () => ({ status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } } });
  const id = await begin();
  await runToEnd(id);
  assert.ok(state.generateCalls >= 3 && state.generateCalls <= 48, `sent ${state.generateCalls}`);
  assert.equal(await geminiRequestsForAudit(id), state.generateCalls);
  assert.equal(await geminiRequestsToday(), state.generateCalls);
});

test('5. a network error and a timeout are each counted once and retried within the 3 attempts', async () => {
  state.fault = (number) => (number === 1 ? 'network' : number === 3 ? 'timeout' : null);
  const id = await begin();
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 18, '16 steps plus one retry for each failure');
  assert.equal(await geminiRequestsForAudit(id), 18);
  const outcomes = ((await loadReport(id)) as Report).methodology.geminiRequestOutcomes;
  assert.equal(outcomes?.network, 1);
  assert.equal(outcomes?.timeout, 1);
  assert.equal(outcomes?.ok, 16);
});

// ---------- I3: a refused request is never sent and consumes nothing ----------

test('I3. every kind of refusal writes nothing, and the next granted request adds exactly one to each counter', async () => {
  const day = async () => geminiRequestsToday();
  const audit = async () => geminiRequestsForAudit('refusal-test');
  const snapshotKeys = async () => geminiKeys();

  // A first grant, so that the minute, day and audit counters exist.
  assert.equal((await acquireGeminiSlot('refusal-test', 0)).ok, true);
  assert.equal(await audit(), 1);

  const kinds: { name: string; arrange: () => Promise<void>; undo: () => Promise<void>; ceiling?: number; expect: string }[] = [
    {
      name: 'cooldown',
      arrange: async () => void (await shim.raw('SET', 'si:gemini:cooldown', String(Date.now() + 30_000), 'EX', '30')),
      undo: async () => void (await shim.raw('DEL', 'si:gemini:cooldown')),
      expect: 'wait',
    },
    {
      name: 'provider-daily marker',
      arrange: async () => {
        const { markGeminiDailyExhausted } = await import('../lib/quota/gemini-limiter');
        await markGeminiDailyExhausted();
      },
      undo: async () => void (await shim.raw('DEL', ...((await shim.raw('KEYS', 'si:gemini:exhausted:*')) as string[]))),
      expect: 'daily',
    },
    {
      name: 'daily limit',
      arrange: async () => void (process.env.GEMINI_RPD = '1'),
      undo: async () => void delete process.env.GEMINI_RPD,
      expect: 'daily',
    },
    {
      name: 'per-minute pacing',
      arrange: async () => void (process.env.GEMINI_RPM = '1'),
      undo: async () => void delete process.env.GEMINI_RPM,
      expect: 'wait',
    },
    { name: 'audit ceiling', arrange: async () => {}, undo: async () => {}, ceiling: 1, expect: 'ceiling' },
  ];

  for (const kind of kinds) {
    await kind.arrange();
    const before = await snapshotKeys();
    const calls = state.generateCalls;
    const result = await acquireGeminiSlot('refusal-test', kind.ceiling ?? 0);
    assert.equal(result.ok, false, `${kind.name} refuses`);
    if (!result.ok) assert.equal(result.kind, kind.expect, `${kind.name}`);
    assert.deepEqual(await snapshotKeys(), before, `${kind.name}: no counter, key or expiry marker was written`);
    assert.equal(state.generateCalls, calls, `${kind.name}: nothing reached the mock`);
    await kind.undo();
  }

  // After the refusals: a granted request adds exactly one to the minute, day and audit counters.
  const minuteSum = async () => {
    const keys = (await shim.raw('KEYS', 'si:gemini:min:*')) as string[];
    let sum = 0;
    for (const key of keys) sum += Number((await shim.raw('GET', key)) ?? 0);
    return sum;
  };
  const before = { minute: await minuteSum(), day: await day(), audit: await audit() };
  assert.equal((await acquireGeminiSlot('refusal-test', 0)).ok, true);
  assert.deepEqual({ minute: await minuteSum(), day: await day(), audit: await audit() }, { minute: before.minute + 1, day: before.day + 1, audit: before.audit + 1 });
});

test('I3b. a limit of 0 means no per-audit limit: 70 requests of one audit are all granted', async () => {
  for (let i = 1; i <= 70; i += 1) {
    const result = await acquireGeminiSlot('no-ceiling', 0);
    assert.equal(result.ok, true, `request ${i}`);
  }
  assert.equal(await geminiRequestsForAudit('no-ceiling'), 70);
});

test('I3c. the script enforces a ceiling when one is passed: the 61st is refused and writes nothing', async () => {
  for (let i = 1; i <= 60; i += 1) assert.equal((await acquireGeminiSlot('ceiling-60', 60)).ok, true);
  const before = await geminiKeys();
  const refused = await acquireGeminiSlot('ceiling-60', 60);
  assert.deepEqual(refused, { ok: false, kind: 'ceiling', auditCount: 60 });
  assert.deepEqual(await geminiKeys(), before);
});

// ---------- 7. concurrency (I2) ----------

test('7. two audits advanced at the same time with a low daily limit: the day counter equals the sum of the audit counters and the mock, never above the limit (I2)', async () => {
  process.env.GEMINI_RPD = '20';
  const a = await begin('Glowwell');
  const b = await begin('Otherbrand');
  for (let round = 0; round < 40; round += 1) {
    await Promise.all([advanceJob(a), advanceJob(b)]);
    await shim.raw('DEL', 'si:gemini:cooldown');
  }
  const total = state.generateCalls;
  assert.ok(total <= 20, `sent ${total}`);
  assert.equal(await geminiRequestsToday(), total);
  assert.equal(await sumOfAuditCounters(), total);
  assert.equal((await geminiRequestsForAudit(a)) + (await geminiRequestsForAudit(b)), total);
  const statuses = [(await loadMeta(a)).status, (await loadMeta(b)).status];
  assert.ok(statuses.every((s) => s === 'paused' || s === 'running'), `paused, not failed: ${statuses.join(',')}`);
  assert.ok(statuses.includes('paused'));
});

test('7b. limiter stress: 4 audits x 100 simultaneous requests, daily limit 150, ceiling 60: exactly 150 granted, counters agree, refusals wrote nothing', async () => {
  process.env.GEMINI_RPD = '150';
  for (let round = 0; round < 3; round += 1) {
    await shim.flush();
    const audits = ['s1', 's2', 's3', 's4'];
    const results = await Promise.all(audits.flatMap((id) => Array.from({ length: 100 }, () => acquireGeminiSlot(id, 60))));
    const granted = results.filter((r) => r.ok).length;
    assert.equal(granted, 150, `round ${round}`);
    assert.equal(await geminiRequestsToday(), 150);
    assert.equal(await sumOfAuditCounters(), 150);
    for (const id of audits) assert.ok((await geminiRequestsForAudit(id)) <= 60, 'no audit above its ceiling');
    assert.ok(results.every((r) => r.ok || r.kind === 'daily' || r.kind === 'ceiling'));
  }
});

// ---------- 8. interruption ----------

test('8a/8c. an audit whose saved state was lost mid-way still reports the true count; the unrecorded requests show as "interrupted"', async () => {
  const id = await begin();
  // Run the first stages, then simulate a function that was killed before it saved its progress:
  // the saved request count and ledger go back to empty while the Redis counter keeps the truth.
  for (let i = 0; i < 4; i += 1) await advanceJob(id);
  const sentSoFar = state.generateCalls;
  assert.ok(sentSoFar > 0);
  const job = await loadJob(id);
  assert.ok(job);
  const stale = { ...job.meta, geminiRequests: 0, geminiLedger: undefined };
  await shim.raw('HSET', `si:job:${id}`, 'meta', JSON.stringify(stale));
  assert.equal(await geminiRequestsForAudit(id), sentSoFar, 'Redis still has the truth');

  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(await geminiRequestsForAudit(id), state.generateCalls, 'I1 after the interruption');
  const report = (await loadReport(id)) as Report;
  assert.equal(report.methodology.geminiRequests, state.generateCalls, 'the report states the real count');
  const outcomes = report.methodology.geminiRequestOutcomes ?? {};
  assert.equal(outcomes.interrupted, sentSoFar, 'requests with no recorded outcome are shown as interrupted');
  assert.equal(Object.values(outcomes).reduce((sum, n) => sum + (n ?? 0), 0), state.generateCalls);
});

test('8d. a function killed between counting and sending over-counts by one and never under-counts', async () => {
  const slot = await acquireGeminiSlot('killed', 0); // counted; the fetch never happens
  assert.equal(slot.ok, true);
  assert.equal(await geminiRequestsForAudit('killed'), 1);
  assert.equal(state.generateCalls, 0);
  assert.ok((await geminiRequestsForAudit('killed')) >= state.generateCalls);
});

// ---------- 9. Redis cost regression ----------

test('9. one Redis command per approval (grant or refusal), and a clean audit stays inside its command budget', async () => {
  shim.sent.length = 0;
  await acquireGeminiSlot('cost', 0);
  assert.equal(shim.sent.length, 1, 'a grant is one EVAL');
  assert.equal(shim.sent[0][0], 'EVAL');
  shim.sent.length = 0;
  await shim.raw('SET', 'si:gemini:cooldown', String(Date.now() + 30_000), 'EX', '30');
  await acquireGeminiSlot('cost', 0);
  assert.equal(shim.sent.length, 1, 'a refusal is one EVAL, with no undo commands');
  await shim.raw('DEL', 'si:gemini:cooldown');

  await shim.flush();
  shim.sent.length = 0;
  const id = await begin();
  await runToEnd(id);
  const gateCommands = shim.sent.filter(isGeminiSlotScript).length;
  assert.equal(gateCommands, 16, 'one approval per request, no more');
  // Commands the app sends (the script's own inner calls are billed on top: at most 7 more per grant).
  assert.ok(shim.sent.length <= 220, `a clean audit sent ${shim.sent.length} commands`);
  console.log = realLog;
  realLog(`      [info] commands sent by the app for one clean audit: ${shim.sent.length}`);
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

// ---------- 10. report format 9 ----------

test('10. a new report is saved under format 9 and cached under format 9; nothing is written under format 8', async () => {
  const id = await begin();
  await runToEnd(id);
  assert.equal(await shim.raw('EXISTS', `si:report:v9:${id}`), 1);
  assert.equal(((await shim.raw('KEYS', 'si:cache:v9:*')) as string[]).length, 1);
  assert.equal(((await shim.raw('KEYS', 'si:report:v8:*')) as string[]).length, 0);
  assert.equal(((await shim.raw('KEYS', 'si:cache:v8:*')) as string[]).length, 0);
});

// ---------- 11. the audit store (Redis/Upstash) fails: fail closed ----------

/** Advance until the audit reaches the first Gemini request: the stage that asks the store for permission. */
async function advanceToFirstGeminiStage(id: string): Promise<void> {
  const snapshot = await advanceJob(id); // "Preparing the audit" needs no Gemini request for a built-in category
  assert.ok(snapshot);
  assert.equal(state.generateCalls, 0);
}

async function expectStorageFailure(id: string, reason: 'quota' | 'unavailable'): Promise<StorageSignal> {
  let caught: unknown;
  try {
    await advanceJob(id);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof StorageSignal, `expected a StorageSignal, got ${String(caught)}`);
  assert.ok(!(caught instanceof WaitSignal) && !(caught instanceof PauseSignal), 'not a rate-limit wait or a daily pause');
  assert.equal(caught.reason, reason);
  return caught;
}

async function assertNothingConsumed(id: string, keysBefore: Record<string, string | null>): Promise<void> {
  assert.equal(state.generateCalls, 0, 'no Gemini HTTP request was sent');
  assert.deepEqual(await geminiKeys(), keysBefore, 'no counter was changed and no cooldown or provider-daily marker was set');
  assert.equal(await geminiRequestsForAudit(id), 0);
  assert.equal(await geminiRequestsToday(), 0);
  assert.equal(await isGeminiDailyExhausted(), false, 'not recorded as a provider-daily limit');
  assert.equal(await shim.raw('GET', 'si:gemini:cooldown'), null, 'no Gemini cooldown was set');
  const meta = await loadMeta(id);
  assert.equal(meta.status, 'running', 'the audit is not failed or paused');
  assert.deepEqual(meta.attempts, {}, 'no step attempt and no stage error was recorded');
  assert.deepEqual(meta.warnings, [], 'no warning about Gemini was added');
  assert.equal(meta.geminiRequests, 0);
  assert.equal(meta.geminiLedger, undefined);
  const events = logged.join('\n');
  assert.ok(events.includes('gemini_slot_storage_error'), 'reported as a storage problem');
  for (const wrong of ['"event":"gemini_error"', 'gemini_setup_problem', '"event":"stage_error"']) {
    assert.ok(!events.includes(wrong), `not reported as ${wrong}`);
  }
}

test('11a. the script call fails with the store\'s free-tier limit message: no request sent, nothing consumed, reported as a storage problem (quota)', async () => {
  const id = await begin();
  await advanceToFirstGeminiStage(id);
  const before = await geminiKeys();
  shim.intercept = (args) => (isGeminiSlotScript(args) ? { error: QUOTA_ERROR, status: 400 } : null);

  const signal = await expectStorageFailure(id, 'quota');
  assert.equal(signal.message, USER_MESSAGES.storageQuota);
  assert.ok(shim.sent.some(isGeminiSlotScript) && shim.executed.every((c) => !isGeminiSlotScript(c)), 'the script was asked for and refused by the store');
  await assertNothingConsumed(id, before);

  // The route answers 503, labelled as storage, and not as any Gemini limit.
  const response = await advanceRoute(new Request('https://shelf-index.test/api/audits/x/advance', { method: 'POST' }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string; kind: string; reason: string };
  assert.equal(body.kind, 'storage');
  assert.equal(body.reason, 'quota');
  assert.equal(body.error, USER_MESSAGES.storageQuota);
  assert.notEqual(body.error, USER_MESSAGES.geminiDaily);
  assert.ok(logged.join('\n').includes('advance_storage_error'));
  await assertNothingConsumed(id, before);
});

test('11b. unexplained store failures (an HTTP 500, a dropped connection, and the daily-limit wording) fail closed the same way', async () => {
  const cases: { name: string; action: () => ReturnType<NonNullable<Shim['intercept']>>; reason: 'quota' | 'unavailable' }[] = [
    { name: 'HTTP 500', action: () => ({ error: 'ERR internal error', status: 500 }), reason: 'unavailable' },
    { name: 'HTTP 429 from the store', action: () => ({ error: 'ERR rate limited', status: 429 }), reason: 'unavailable' },
    { name: 'dropped connection', action: () => 'drop', reason: 'unavailable' },
    { name: "the store's own daily limit wording", action: () => ({ error: 'ERR max daily request limit exceeded. Limit: 10000, Usage: 10000', status: 400 }), reason: 'quota' },
  ];
  for (const c of cases) {
    await shim.flush();
    logged = [];
    shim.intercept = null;
    const id = await begin();
    await advanceToFirstGeminiStage(id);
    const before = await geminiKeys();
    shim.intercept = (args) => (isGeminiSlotScript(args) ? c.action() : null);
    await expectStorageFailure(id, c.reason);
    await assertNothingConsumed(id, before);
  }
});

test('11c. the store refuses every command (the whole database is over its free limit): the route answers 503, nothing is sent, nothing is counted', async () => {
  const id = await begin();
  await advanceToFirstGeminiStage(id);
  const before = await geminiKeys();
  shim.intercept = () => ({ error: QUOTA_ERROR, status: 400 });

  const response = await advanceRoute(new Request('https://shelf-index.test/api/audits/x/advance', { method: 'POST' }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, 'The audit store is not reachable right now.', 'the existing storage message of the route');
  assert.notEqual(body.error, USER_MESSAGES.geminiDaily);

  shim.intercept = null;
  assert.equal(state.generateCalls, 0);
  assert.deepEqual(await geminiKeys(), before);
  assert.equal(await shim.raw('GET', 'si:gemini:cooldown'), null);
});

test('11d. a reply that is not the documented shape is never treated as permission', async () => {
  const replies: unknown[] = ['OK', null, 7, [], [1], [1, 'ok'], [1, 'nope', 3, 4], [1, 'ok', 'x', 4], [0, 'surprise', 1, 0], { not: 'an array' }];
  const id = await begin();
  await advanceToFirstGeminiStage(id);
  const before = await geminiKeys();
  for (const reply of replies) {
    logged = [];
    shim.intercept = (args) => (isGeminiSlotScript(args) ? { result: reply } : null);
    await expectStorageFailure(id, 'unavailable');
    await assertNothingConsumed(id, before);
  }
});

test('11e. a store failure is never mistaken for a Gemini 429, a provider-daily limit or an audit ceiling', async () => {
  const id = await begin();
  await advanceToFirstGeminiStage(id);
  shim.intercept = (args) => (isGeminiSlotScript(args) ? { error: 'ERR max daily request limit exceeded. 429 quota per day exceeded', status: 429 } : null);
  const signal = await expectStorageFailure(id, 'quota');
  assert.equal(signal.name, 'StorageSignal');
  assert.equal(await isGeminiDailyExhausted(), false);
  assert.equal(await shim.raw('GET', 'si:gemini:cooldown'), null);
  const meta = await loadMeta(id);
  assert.equal(meta.status, 'running');
  assert.equal(meta.pausedReason, undefined);
  assert.equal('geminiCeilingReached' in meta, false);
  assert.ok(!meta.warnings.some((w) => /limit|quota|Gemini/i.test(w)));
  assert.equal(state.generateCalls, 0);
});

test('11f. three store failures in a row, then Redis recovers: the audit was never failed, the next advance sends exactly one request, and every counter reads 1', async () => {
  const id = await begin();
  await advanceToFirstGeminiStage(id);
  const before = await geminiKeys();
  shim.intercept = (args) => (isGeminiSlotScript(args) ? { error: QUOTA_ERROR, status: 400 } : null);
  for (let i = 0; i < 3; i += 1) {
    await expectStorageFailure(id, 'quota');
    await assertNothingConsumed(id, before);
  }

  // Redis becomes available again.
  shim.intercept = null;
  await advanceJob(id);
  assert.equal(state.generateCalls, 1, 'exactly one request, for the one step that was waiting');
  assert.equal(await geminiRequestsForAudit(id), 1);
  assert.equal(await geminiRequestsToday(), 1);
  const minuteKeys = (await shim.raw('KEYS', 'si:gemini:min:*')) as string[];
  let minute = 0;
  for (const key of minuteKeys) minute += Number((await shim.raw('GET', key)) ?? 0);
  assert.equal(minute, 1);
  const meta = await loadMeta(id);
  assert.deepEqual(meta.attempts, {});
  assert.equal(meta.status, 'running');

  // And the audit simply carries on to a normal finish, counted exactly.
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  assert.equal(await geminiRequestsForAudit(id), 16);
  assert.equal(await geminiRequestsToday(), 16);
});

test('11g. the store fails in the middle of a stage that has already sent requests: those are kept and counted, the failing one is not sent, and the audit finishes after recovery', async () => {
  const id = await begin();
  let approvals = 0;
  // The first four approvals succeed (profile, then three shopper questions); every approval after that fails.
  shim.intercept = (args) => {
    if (!isGeminiSlotScript(args)) return null;
    approvals += 1;
    return approvals > 4 ? { error: QUOTA_ERROR, status: 400 } : null;
  };
  let caught: unknown;
  for (let i = 0; i < 10 && !caught; i += 1) {
    try {
      await advanceJob(id);
    } catch (err) {
      caught = err;
    }
  }
  assert.ok(caught instanceof StorageSignal);
  assert.equal(state.generateCalls, 4, 'exactly the four approved requests were sent; the fifth was not');
  assert.equal(await geminiRequestsForAudit(id), 4);
  assert.equal(await geminiRequestsToday(), 4);
  const meta = await loadMeta(id);
  assert.equal(meta.status, 'running');
  assert.equal(meta.geminiLedger?.started, 4, 'what the call had already recorded was kept');
  assert.equal(meta.geminiLedger?.outcomes.ok, 4);
  assert.ok(!Object.keys(meta.attempts).some((key) => key.startsWith('ask:')), 'no attempt was charged for the request that was never sent');
  const job = await loadJob(id);
  assert.equal(job?.data.answers?.length, 3, 'the three answers already received were saved');

  shim.intercept = null;
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  assert.equal(await geminiRequestsForAudit(id), 16);
  const report = (await loadReport(id)) as Report;
  assert.equal(report.methodology.geminiRequests, 16);
  assert.deepEqual(report.methodology.geminiRequestOutcomes, { ok: 16 });
});

/** Run advances until one throws; the first four store approvals succeed, so the failure lands inside the shopper-question stage. */
async function advanceUntilStoreFails(id: string): Promise<unknown> {
  for (let i = 0; i < 10; i += 1) {
    try {
      await advanceJob(id);
    } catch (err) {
      return err;
    }
  }
  return undefined;
}

test('11h. if saving the already-recorded progress ALSO fails, the original StorageSignal still propagates: no stage failure, no Gemini error, no misleading audit state', async () => {
  const id = await begin();
  let approvals = 0;
  let armed = false;
  let metaSaveRefused = 0;
  shim.intercept = (args) => {
    if (isGeminiSlotScript(args)) {
      approvals += 1;
      if (approvals > 4) {
        armed = true;
        return { error: QUOTA_ERROR, status: 400 };
      }
      return null;
    }
    // After the approval failed, the store also refuses to save the audit's progress (the "meta" field of the job).
    if (armed && args[0] === 'HSET' && args[2] === 'meta') {
      metaSaveRefused += 1;
      return { error: 'ERR internal error', status: 500 };
    }
    return null;
  };

  const caught = await advanceUntilStoreFails(id);
  assert.ok(caught instanceof StorageSignal, `the original StorageSignal propagates, got ${String(caught)}`);
  assert.ok(!(caught instanceof Error) || caught.name === 'StorageSignal', 'not replaced by a Redis error');
  assert.equal(caught.reason, 'quota');
  assert.ok(metaSaveRefused >= 1, 'the best-effort save was really attempted and refused');

  assert.equal(state.generateCalls, 4, 'the fifth request was never sent');
  assert.equal(await geminiRequestsForAudit(id), 4, 'the Redis counter still has the truth');
  const meta = await loadMeta(id);
  assert.equal(meta.status, 'running', 'not failed, not paused');
  assert.equal(meta.error, undefined);
  assert.equal(meta.pausedReason, undefined);
  assert.deepEqual(meta.warnings, []);
  assert.ok(!Object.keys(meta.attempts).some((key) => key.startsWith('ask:') || key.startsWith('stage:')), 'no attempt or stage error was recorded');
  const events = logged.join('\n');
  assert.ok(events.includes('gemini_slot_storage_error'));
  for (const wrong of ['"event":"stage_error"', '"event":"gemini_error"', 'gemini_setup_problem', '"event":"audit_failed"']) {
    assert.ok(!events.includes(wrong), `not reported as ${wrong}`);
  }

  // Redis recovers. The lost record only costs detail: the true count is still reported, the gap shows as "interrupted".
  shim.intercept = null;
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  const report = (await loadReport(id)) as Report;
  assert.equal(report.methodology.geminiRequests, 16);
  const outcomes = report.methodology.geminiRequestOutcomes ?? {};
  assert.equal(Object.values(outcomes).reduce((sum, n) => sum + (n ?? 0), 0), 16);
  assert.ok((outcomes.interrupted ?? 0) > 0, 'requests whose record was lost show as interrupted');
});

test('11i. if the store stops answering altogether right after the failed approval (so the lock release fails too), the original StorageSignal still propagates and the audit carries on after recovery', async () => {
  const id = await begin();
  let approvals = 0;
  let down = false;
  shim.intercept = (args) => {
    if (down) return { error: 'ERR internal error', status: 500 };
    if (isGeminiSlotScript(args)) {
      approvals += 1;
      if (approvals > 4) {
        down = true;
        return { error: QUOTA_ERROR, status: 400 };
      }
    }
    return null;
  };

  const caught = await advanceUntilStoreFails(id);
  assert.ok(caught instanceof StorageSignal, `the original StorageSignal propagates, got ${String(caught)}`);
  assert.equal(caught.reason, 'quota');
  assert.equal(state.generateCalls, 4);
  const events = logged.join('\n');
  assert.ok(events.includes('lock_release_failed'), 'the failed lock release was logged, and did not replace the error');
  for (const wrong of ['"event":"stage_error"', '"event":"gemini_error"', 'gemini_setup_problem', '"event":"audit_failed"']) {
    assert.ok(!events.includes(wrong), `not reported as ${wrong}`);
  }

  // Redis recovers. The audit's lock could not be released, so it is held until it expires on its own (100 seconds in production).
  shim.intercept = null;
  assert.equal(await geminiRequestsForAudit(id), 4);
  const busy = await advanceJob(id);
  assert.equal(busy?.busy, true, 'the lock is still held');
  await shim.raw('PEXPIRE', `si:lock:${id}`, '1'); // stands in for the 100-second expiry
  await new Promise((resolve) => setTimeout(resolve, 20));

  const meta = await loadMeta(id);
  assert.equal(meta.status, 'running');
  assert.deepEqual(Object.keys(meta.attempts).filter((key) => key.startsWith('ask:') || key.startsWith('stage:')), []);
  const { last } = await runToEnd(id);
  assert.equal(last.status, 'complete');
  assert.equal(state.generateCalls, 16);
  assert.equal(await geminiRequestsForAudit(id), 16);
  assert.equal(((await loadReport(id)) as Report).methodology.geminiRequests, 16);
});
