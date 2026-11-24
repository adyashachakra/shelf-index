// Release hardening H2: Preview's audit state is kept apart from Production's in the one shared Redis database,
// while the Gemini and Tavily quota counters stay shared.
//
// Both environments are simulated against the SAME local Redis (a throwaway redis-server behind the Upstash REST
// shim): "Production" is SI_KEY_NAMESPACE unset, "Preview" is SI_KEY_NAMESPACE=preview. Gemini, Tavily and YouTube are
// simulated (tests/helpers/mock-apis.ts). Nothing here contacts a real service. The brand "Glowwell" is invented.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { GET as status } from '../app/api/audits/[id]/route';
import { POST as advance } from '../app/api/audits/[id]/advance/route';
import { GET as health } from '../app/api/health/route';
import { advanceJob, getSnapshot, startAudit } from '../lib/audit/pipeline';
import { envKeys, KeyNamespaceError, keyNamespace, keyNamespaceProblem, legacyReportKey, sharedKeys } from '../lib/cache/keys';
import { findCachedReportId, loadReport, saveReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { READABLE_REPORT_VERSIONS, REPORT_FORMAT_VERSION, USER_MESSAGES } from '../lib/config';
import { dayKey, monthKey } from '../lib/quota/dates';
import { reservationState, sweepStaleReservations } from '../lib/quota/reservations';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const realLog = console.log;
let visitor = 0;
const TZ = 'America/Los_Angeles';
const CACHE_KEY = 'skincare:glowwell';

before(async () => {
  shim = await startShim(6399, 13);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3';
  process.env.PER_VISITOR_DAILY_LIMIT = '50';
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  delete process.env.TAVILY_MONTHLY_CREDIT_CEILING;
  state = newMockState();
  restoreFetch = installMockFetch(state, shim.url);
  console.log = () => undefined;
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  delete process.env.SI_KEY_NAMESPACE;
  delete process.env.VERCEL_ENV;
  await shim.close();
});
beforeEach(async () => {
  await shim.flush();
  resetGeminiFeatureMemory();
  Object.assign(state, newMockState());
  delete process.env.SI_KEY_NAMESPACE;
  delete process.env.VERCEL_ENV;
  delete process.env.GEMINI_RPD;
  delete process.env.TAVILY_MONTHLY_CREDIT_CEILING;
});

const asProduction = (): void => {
  delete process.env.SI_KEY_NAMESPACE;
};
const asPreview = (): void => {
  process.env.SI_KEY_NAMESPACE = 'preview';
};

function input() {
  const parsed = validateAuditInput({ brand: 'Glowwell', category: 'skincare' });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}
async function start(): Promise<Awaited<ReturnType<typeof startAudit>>> {
  visitor += 1;
  return startAudit(input(), `203.0.119.${visitor}`);
}
async function startNew(): Promise<string> {
  const started = await start();
  assert.equal(started.body.status, 'started', `expected a new audit, got ${JSON.stringify(started.body)}`);
  if (started.body.status !== 'started') throw new Error('not started');
  return started.body.id;
}
async function runToEnd(id: string): Promise<JobSnapshot> {
  for (let calls = 1; calls <= 200; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    if (['complete', 'failed', 'identity_failed'].includes(snapshot.status)) return snapshot;
  }
  throw new Error('the audit did not finish');
}
async function allKeys(): Promise<string[]> {
  return ((await shim.raw('KEYS', '*')) as string[]).sort();
}
const today = (): string => dayKey(TZ, new Date());
const thisMonth = (): string => monthKey(TZ, new Date());

// ---------------------------------------------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------------------------------------------

test('H2-1: with SI_KEY_NAMESPACE unset, every key has exactly the name it has always had (Production unchanged)', () => {
  asProduction();
  assert.equal(keyNamespace(), '');
  assert.deepEqual(
    [
      envKeys.report(10, 'abc'),
      envKeys.report(7, 'abc'),
      envKeys.cachePointer(10, 'fashion:cos'),
      envKeys.job('abc'),
      envKeys.lock('abc'),
      envKeys.inflight('fashion:cos'),
      envKeys.questions(3, 'garden tools'),
      envKeys.reservation('abc'),
      envKeys.reservationsActive(),
      envKeys.auditDay('2026-11-24'),
      envKeys.visitor('2026-11-24', 'h4sh'),
    ],
    [
      'si:report:v10:abc',
      'si:report:v7:abc',
      'si:cache:v10:fashion:cos',
      'si:job:abc',
      'si:lock:abc',
      'si:inflight:fashion:cos',
      'si:questions:3:garden tools',
      'si:resv:abc',
      'si:resv-active',
      'si:day:2026-11-24',
      'si:visitor:2026-11-24:h4sh',
    ],
  );
  for (const value of ['', '   ']) {
    process.env.SI_KEY_NAMESPACE = value;
    assert.equal(keyNamespace(), '', `an empty value (${JSON.stringify(value)}) counts as unset`);
    assert.equal(envKeys.job('abc'), 'si:job:abc');
  }
});

test('H2-2: the Gemini and Tavily quota keys are the same in every environment', () => {
  const shared = (): string[] => [
    sharedKeys.geminiCooldown(),
    sharedKeys.geminiDay('2026-11-24'),
    sharedKeys.geminiExhausted('2026-11-24'),
    sharedKeys.geminiMinute(29_000_000),
    sharedKeys.geminiAudit('abc'),
    sharedKeys.tavilyMonth('2026-11'),
    sharedKeys.tavilyExhausted('2026-11'),
  ];
  const expected = ['si:gemini:cooldown', 'si:gemini:day:2026-11-24', 'si:gemini:exhausted:2026-11-24', 'si:gemini:min:29000000', 'si:gemini:audit:abc', 'si:tavily:2026-11', 'si:tavily:exhausted:2026-11'];
  asProduction();
  assert.deepEqual(shared(), expected);
  asPreview();
  assert.deepEqual(shared(), expected);
});

test('H2-3: with SI_KEY_NAMESPACE=preview, every audit-state key is namespaced', () => {
  process.env.SI_KEY_NAMESPACE = '  preview ';
  assert.equal(keyNamespace(), 'preview', 'surrounding spaces are ignored');
  for (const key of [
    envKeys.report(10, 'abc'),
    envKeys.cachePointer(10, 'fashion:cos'),
    envKeys.job('abc'),
    envKeys.lock('abc'),
    envKeys.inflight('fashion:cos'),
    envKeys.questions(3, 'garden tools'),
    envKeys.reservation('abc'),
    envKeys.reservationsActive(),
    envKeys.auditDay('2026-11-24'),
    envKeys.visitor('2026-11-24', 'h4sh'),
  ]) {
    assert.ok(key.startsWith('si:preview:'), key);
  }
  assert.equal(envKeys.job('abc'), 'si:preview:job:abc');
  assert.equal(legacyReportKey(9, 'abc'), 'si:report:v9:abc', 'the legacy report key is never namespaced');
});

// ---------------------------------------------------------------------------------------------------------------
// Invalid configuration
// ---------------------------------------------------------------------------------------------------------------

const INVALID = ['Preview', 'pre view', 'pre_view', 'pre:view', '1preview', '-preview', 'x'.repeat(25), 'preview!', 'gemini', 'tavily', 'report', 'cache', 'job', 'resv-active', 'day', 'visitor'];

const PRODUCTION_MESSAGE =
  'SI_KEY_NAMESPACE is set on the Production environment. It must be left unset there; remove it from the Production environment variables.';
const FIXED_MESSAGES = new Set([
  PRODUCTION_MESSAGE,
  'SI_KEY_NAMESPACE must be 1 to 24 lower-case letters, digits or hyphens, starting with a letter (for example "preview").',
  'SI_KEY_NAMESPACE must not be a word the app already uses in its key names (for example "report" or "gemini").',
]);

test('H2-4: an invalid non-empty namespace is a configuration error: no key is built, nothing falls back to the shared names', () => {
  for (const value of INVALID) {
    process.env.SI_KEY_NAMESPACE = value;
    const problem = keyNamespaceProblem();
    assert.ok(problem, value);
    assert.ok(FIXED_MESSAGES.has(problem), 'the error is fixed text: it never includes the configured value');
    assert.throws(() => keyNamespace(), KeyNamespaceError, value);
    assert.throws(() => envKeys.job('abc'), KeyNamespaceError, value);
    assert.throws(() => envKeys.cachePointer(10, CACHE_KEY), KeyNamespaceError, value);
  }
  for (const value of ['preview', 'pr', 'preview-2', 'staging', 'p'.repeat(24)]) {
    process.env.SI_KEY_NAMESPACE = value;
    assert.equal(keyNamespaceProblem(), null, value);
  }
});

test('H2-5: with an invalid namespace, starting, advancing and opening an audit all fail with the configuration message and write nothing', async () => {
  // Production data that must stay out of reach of a misconfigured Preview.
  asProduction();
  const prodId = await startNew();
  const before = await allKeys();

  process.env.SI_KEY_NAMESPACE = 'Pre view';
  const started = await start();
  assert.equal(started.httpStatus, 503);
  assert.deepEqual(started.body, { status: 'error', code: 'setup', message: USER_MESSAGES.keyNamespace });
  await assert.rejects(() => advanceJob(prodId), KeyNamespaceError);
  await assert.rejects(() => loadReport(prodId), KeyNamespaceError);
  await assert.rejects(() => findCachedReportId(CACHE_KEY), KeyNamespaceError);

  const ctx = { params: Promise.resolve({ id: prodId }) };
  const advanced = await advance(new Request('http://x/api/audits/a/advance', { method: 'POST' }), ctx);
  assert.equal(advanced.status, 503);
  assert.equal(((await advanced.json()) as { error: string }).error, USER_MESSAGES.keyNamespace);
  const statusResponse = await status(new Request('http://x/api/audits/a'), ctx);
  assert.equal(statusResponse.status, 503);
  assert.equal(((await statusResponse.json()) as { error: string }).error, USER_MESSAGES.keyNamespace);

  assert.deepEqual(await allKeys(), before, 'nothing was written or deleted');
  asProduction();
  assert.equal((await getSnapshot(prodId))?.status, 'running', 'the Production audit is untouched');
});

// ---------------------------------------------------------------------------------------------------------------
// Two environments, one Redis
// ---------------------------------------------------------------------------------------------------------------

test('H2-6: Production and Preview audit the same brand in one Redis: no cache, job, lock, in-flight, slot or reservation crossover; provider counters shared', async () => {
  asProduction();
  const prodId = await startNew();
  assert.equal((await runToEnd(prodId)).status, 'complete');
  const prodGemini = Number(await shim.raw('GET', sharedKeys.geminiDay(today())));
  const prodCredits = Number(await shim.raw('GET', sharedKeys.tavilyMonth(thisMonth())));
  assert.ok(prodGemini > 0 && prodCredits > 0);
  const afterProd = await allKeys();
  assert.ok(afterProd.every((key) => !key.startsWith('si:preview:')), 'Production writes no namespaced key');

  // Preview is not served Production's cached report: it starts its own audit.
  asPreview();
  assert.equal(await findCachedReportId(CACHE_KEY), null);
  const previewId = await startNew();
  assert.notEqual(previewId, prodId);
  assert.equal((await runToEnd(previewId)).status, 'complete');

  // Every key Preview created is namespaced, or is one of the shared provider counters.
  const created = (await allKeys()).filter((key) => !afterProd.includes(key));
  assert.ok(created.length > 0);
  for (const key of created) {
    assert.ok(key.startsWith('si:preview:') || key.startsWith('si:gemini:') || key.startsWith('si:tavily:'), `unexpected key written by Preview: ${key}`);
  }
  assert.ok(created.includes(`si:preview:report:v${REPORT_FORMAT_VERSION}:${previewId}`));
  assert.ok(created.includes(`si:preview:cache:v${REPORT_FORMAT_VERSION}:${CACHE_KEY}`));
  assert.ok(created.includes(`si:preview:job:${previewId}`));
  assert.ok(created.includes(`si:preview:resv:${previewId}`));
  assert.ok(created.includes(`si:preview:day:${today()}`));

  // Each environment sees only its own cache, audits and daily slots.
  assert.equal(await findCachedReportId(CACHE_KEY), previewId);
  assert.equal(await getSnapshot(prodId), null, 'Preview cannot see or advance the Production audit');
  assert.equal(await advanceJob(prodId), null);
  assert.equal(await shim.raw('GET', `si:preview:day:${today()}`), '1');
  asProduction();
  assert.equal(await findCachedReportId(CACHE_KEY), prodId);
  assert.equal(await getSnapshot(previewId), null, 'Production cannot see or advance the Preview audit');
  assert.equal(await loadReport(previewId), null, 'Production never reads a Preview report');
  assert.equal(await shim.raw('GET', `si:day:${today()}`), '1', 'Preview did not use a Production audit slot');
  assert.equal(await shim.raw('GET', `si:cache:v${REPORT_FORMAT_VERSION}:${CACHE_KEY}`), prodId, 'the Production pointer is unchanged');
  assert.equal((await reservationState(prodId))?.state, 'settled');
  asPreview();
  assert.equal((await reservationState(previewId))?.state, 'settled');

  // The provider counters are shared: both audits added to the same Gemini day and Tavily month.
  assert.ok(Number(await shim.raw('GET', sharedKeys.geminiDay(today()))) > prodGemini);
  assert.ok(Number(await shim.raw('GET', sharedKeys.tavilyMonth(thisMonth()))) > prodCredits);
});

test('H2-7: an audit running in one environment is never handed to the other (in-flight lock), in either direction', async () => {
  asProduction();
  const prodId = await startNew(); // left running
  asPreview();
  const previewId = await startNew();
  assert.notEqual(previewId, prodId, 'Preview started its own audit instead of joining Production\'s');
  asProduction();
  const again = await start();
  assert.deepEqual(again.body, { status: 'in_progress', id: prodId }, 'Production still joins its own running audit, not Preview\'s');
  asPreview();
  const previewAgain = await start();
  assert.deepEqual(previewAgain.body, { status: 'in_progress', id: previewId });
  assert.equal(await shim.raw('GET', `si:inflight:${CACHE_KEY}`), prodId);
  assert.equal(await shim.raw('GET', `si:preview:inflight:${CACHE_KEY}`), previewId);
});

test('H2-8: the shared Tavily ceiling is still enforced across both environments', async () => {
  // One minimal audit's worth of credits for the whole month: Production takes it, so Preview is refused.
  process.env.TAVILY_MONTHLY_CREDIT_CEILING = '3';
  asProduction();
  await startNew();
  asPreview();
  const refused = await start();
  assert.equal(refused.body.status, 'error');
  assert.equal((refused.body as { code: string }).code, 'monthly_limit');
});

test('H2-9: the shared Gemini daily allowance is still enforced across both environments', async () => {
  asProduction();
  const prodId = await startNew();
  await runToEnd(prodId);
  const used = Number(await shim.raw('GET', sharedKeys.geminiDay(today())));
  // The day's allowance leaves less room than one more audit needs, counting Production's requests.
  process.env.GEMINI_RPD = String(used + 5);
  asPreview();
  const refused = await start();
  assert.equal(refused.body.status, 'error', 'Preview sees the requests Production already sent today');
});

test('H2-10: the stale-reservation sweep only touches its own environment', async () => {
  asProduction();
  const prodId = await startNew();
  asPreview();
  const previewId = await startNew();
  const later = new Date(Date.now() + 30 * 60 * 60 * 1000); // past the 26-hour stale limit

  asPreview();
  assert.equal(await sweepStaleReservations(later), 1, 'Preview swept one reservation: its own');
  assert.notEqual((await reservationState(previewId))?.state, 'active');
  asProduction();
  assert.equal((await reservationState(prodId))?.state, 'active', 'Production\'s reservation was not swept by Preview');
  assert.equal(await sweepStaleReservations(later), 1);
  assert.notEqual((await reservationState(prodId))?.state, 'active');
});

// ---------------------------------------------------------------------------------------------------------------
// Old Preview report links (read-only fallback) and report formats
// ---------------------------------------------------------------------------------------------------------------

test('H2-11: on Preview, an old report saved under its unnamespaced key still opens by id; nothing else falls back', async () => {
  const id = 'c81c30c57cc8f2465550c4b8';
  const old = JSON.stringify({ id, version: 9, brand: 'Glowwell' });
  await shim.raw('SET', `si:report:v9:${id}`, old);
  await shim.raw('SET', `si:cache:v${REPORT_FORMAT_VERSION}:${CACHE_KEY}`, id);
  await shim.raw('SET', `si:report:v${REPORT_FORMAT_VERSION}:${id}`, old);
  await shim.raw('HSET', `si:job:${id}`, 'meta', JSON.stringify({ id, status: 'running' }));
  const before = await allKeys();

  asPreview();
  assert.equal((await loadReport(id))?.id, id, 'the old link opens');
  assert.equal(await findCachedReportId(CACHE_KEY), null, 'an unnamespaced cache pointer is never used');
  assert.equal(await getSnapshot(id), null, 'an unnamespaced audit is never read');
  const response = await status(new Request('http://x/api/audits/a'), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { report: Report }).report.id, id);
  assert.deepEqual(await allKeys(), before, 'the fallback only reads');

  // A Preview report saved under its own namespace wins over an unnamespaced one with the same id.
  await shim.raw('SET', `si:preview:report:v${REPORT_FORMAT_VERSION}:${id}`, JSON.stringify({ id, version: 10, brand: 'Newer' }));
  assert.equal((await loadReport(id))?.version, 10);
});

test('H2-12: report formats 2 to 10 open in both environments (Preview through the read-only fallback too)', async () => {
  // Formats 2 to 9 are the saved fixtures in tests/fixtures. There is NO independently captured format 10 fixture:
  // the format 10 report here is DERIVED from the format 9 fixture (same content, new id, version set to 10). That is
  // enough for this test, which checks where a report is stored and that it comes back byte for byte, because format
  // 10 has the same shape as format 9; it is not evidence of what a real format 10 audit produces.
  const saved: Record<number, string> = {};
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9]) saved[version] = readFileSync(new URL(`./fixtures/report-format-${version}.json`, import.meta.url), 'utf8');
  saved[10] = JSON.stringify({ ...JSON.parse(saved[9]), id: 'a10a10a10a10a10a10a10a10', version: 10 });
  const idOf = (version: number): string => (JSON.parse(saved[version]) as Report).id;
  assert.deepEqual([...READABLE_REPORT_VERSIONS], [10, 9, 8, 7, 6, 5, 4, 3, 2]);

  // Saved by Production (unnamespaced): Production opens them as saved; Preview opens them through the fallback.
  for (const version of Object.keys(saved).map(Number)) await shim.raw('SET', `si:report:v${version}:${idOf(version)}`, saved[version]);
  for (const env of [asProduction, asPreview]) {
    env();
    for (const version of Object.keys(saved).map(Number)) {
      const loaded = await loadReport(idOf(version));
      assert.equal(JSON.stringify(loaded), saved[version], `format ${version}`);
    }
  }
  // Saved by Preview under its namespace: Preview opens it; Production never does.
  await shim.flush();
  asPreview();
  const report = { ...(JSON.parse(saved[10]) as Report), id: 'b10b10b10b10b10b10b10b10' };
  await saveReport(report, CACHE_KEY);
  assert.equal((await loadReport(report.id))?.id, report.id);
  asProduction();
  assert.equal(await loadReport(report.id), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The health check
// ---------------------------------------------------------------------------------------------------------------

async function healthBody(): Promise<Record<string, unknown>> {
  // The health answer is reused for a minute; move the clock past that so each call is a fresh check.
  const realNow = Date.now;
  const shifted = realNow() + 10 * 60 * 1000 * (++healthCalls);
  Date.now = () => shifted;
  try {
    return (await (await health()).json()) as Record<string, unknown>;
  } finally {
    Date.now = realNow;
  }
}
let healthCalls = 0;
const notesOf = (body: Record<string, unknown>): string[] => body.notes as string[];

test('H2-13: the health check warns when a Preview has no namespace, and reports an invalid one without echoing it', async () => {
  process.env.VERCEL_ENV = 'preview';
  asProduction();
  let body = await healthBody();
  assert.ok(notesOf(body).some((note) => note.startsWith('WARNING: this is a Preview deployment but SI_KEY_NAMESPACE is not set')));
  assert.deepEqual((body.keyNamespace as { value: string }).value, 'none');

  asPreview();
  body = await healthBody();
  assert.ok(!notesOf(body).some((note) => note.startsWith('WARNING')));
  assert.equal((body.keyNamespace as { value: string; ok: boolean }).value, 'preview');
  assert.equal((body.keyNamespace as { ok: boolean }).ok, true);

  process.env.VERCEL_ENV = 'production';
  asProduction();
  body = await healthBody();
  assert.ok(!notesOf(body).some((note) => note.startsWith('WARNING')), 'Production without a namespace is correct');

  process.env.SI_KEY_NAMESPACE = 'Secret Value';
  body = await healthBody();
  assert.equal(body.ok, false);
  assert.deepEqual(body.keyNamespace, { ok: false, value: 'invalid', detail: keyNamespaceProblem() });
  assert.ok(!JSON.stringify(body).includes('Secret Value'), 'the configured value is never echoed');
});

// ---------------------------------------------------------------------------------------------------------------
// Production safeguard: a namespace is never applied on a Vercel Production deployment
// ---------------------------------------------------------------------------------------------------------------

test('H2-14: VERCEL_ENV=production with any non-empty SI_KEY_NAMESPACE is rejected, even a well-formed one; other environments are unchanged', () => {
  process.env.VERCEL_ENV = 'production';
  for (const value of ['preview', 'staging', 'p', 'Pre view']) {
    process.env.SI_KEY_NAMESPACE = value;
    assert.equal(keyNamespaceProblem(), PRODUCTION_MESSAGE, value);
    assert.throws(() => keyNamespace(), KeyNamespaceError);
    assert.throws(() => envKeys.report(REPORT_FORMAT_VERSION, 'abc'), KeyNamespaceError);
    assert.throws(() => envKeys.cachePointer(REPORT_FORMAT_VERSION, CACHE_KEY), KeyNamespaceError);
  }
  // Production with the variable unset (or blank) is the normal case: today's key names.
  for (const value of [undefined, '', '  ']) {
    if (value === undefined) delete process.env.SI_KEY_NAMESPACE;
    else process.env.SI_KEY_NAMESPACE = value;
    assert.equal(keyNamespaceProblem(), null);
    assert.equal(envKeys.job('abc'), 'si:job:abc');
  }
  // Preview, Development and local runs (VERCEL_ENV unset) accept a valid namespace as before.
  process.env.SI_KEY_NAMESPACE = 'preview';
  for (const environment of ['preview', 'development', undefined]) {
    if (environment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = environment;
    assert.equal(keyNamespaceProblem(), null, String(environment));
    assert.equal(envKeys.job('abc'), 'si:preview:job:abc');
  }
});

test('H2-15: a misconfigured Production deployment cannot read or write namespaced (or any) audit state, and says why', async () => {
  // Audit state that exists in both namespaces: a misconfigured Production must reach neither.
  asPreview();
  const previewId = await startNew();
  asProduction();
  const prodId = await startNew();
  const report = { ...(JSON.parse(readFileSync(new URL('./fixtures/report-format-9.json', import.meta.url), 'utf8')) as Report), version: 10 } as Report;
  await shim.raw('SET', `si:preview:report:v${REPORT_FORMAT_VERSION}:${report.id}`, JSON.stringify(report));
  await shim.raw('SET', `si:preview:cache:v${REPORT_FORMAT_VERSION}:${CACHE_KEY}`, report.id);
  const before = await allKeys();

  process.env.VERCEL_ENV = 'production';
  process.env.SI_KEY_NAMESPACE = 'preview';
  const started = await start();
  assert.equal(started.httpStatus, 503);
  assert.deepEqual(started.body, { status: 'error', code: 'setup', message: USER_MESSAGES.keyNamespace });
  for (const attempt of [
    () => loadReport(report.id),
    () => loadReport(previewId),
    () => findCachedReportId(CACHE_KEY),
    () => getSnapshot(previewId),
    () => getSnapshot(prodId),
    () => advanceJob(previewId),
    () => advanceJob(prodId),
    () => saveReport({ ...report, id: 'c0ffeec0ffeec0ffeec0ffee' }, CACHE_KEY),
  ]) {
    await assert.rejects(attempt, KeyNamespaceError);
  }
  // The stale-reservation sweep is best effort by design (it logs and carries on), so it does not throw: it sweeps
  // nothing, and the key comparison below shows it touched nothing in either namespace.
  assert.equal(await sweepStaleReservations(new Date(Date.now() + 30 * 60 * 60 * 1000)), 0);
  for (const id of [previewId, prodId, report.id]) {
    const ctx = { params: Promise.resolve({ id }) };
    const statusResponse = await status(new Request('http://x/api/audits/a'), ctx);
    assert.equal(statusResponse.status, 503);
    assert.equal(((await statusResponse.json()) as { error: string }).error, USER_MESSAGES.keyNamespace);
    const advanced = await advance(new Request('http://x/api/audits/a/advance', { method: 'POST' }), ctx);
    assert.equal(advanced.status, 503);
    assert.equal(((await advanced.json()) as { error: string }).error, USER_MESSAGES.keyNamespace);
  }
  assert.deepEqual(await allKeys(), before, 'nothing was read into, written to or deleted from either namespace');
  assert.ok(!USER_MESSAGES.keyNamespace.includes('preview'), 'the visitor message does not include the configured value');
});

test('H2-16: the health check reports a namespace set on Production as a failed configuration, without echoing it', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.SI_KEY_NAMESPACE = 'preview';
  const body = await healthBody();
  assert.equal(body.ok, false);
  assert.deepEqual(body.keyNamespace, { ok: false, value: 'invalid', detail: PRODUCTION_MESSAGE });
  assert.ok(notesOf(body).some((note) => note.startsWith(PRODUCTION_MESSAGE)));
  assert.equal(body.quota, null, 'the quota counters are not read while the configuration is rejected');
  const text = JSON.stringify(body);
  assert.ok(!/"preview"|: ?"preview|value":"preview/.test(text), 'the configured value is not echoed');
  assert.ok(!text.includes('si:preview'), 'no namespaced key name appears');
});
