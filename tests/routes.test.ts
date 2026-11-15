// The HTTP layer: the real route handlers, called directly as functions.
// Redis is REAL (local). Gemini, Tavily and YouTube are SIMULATED. Next.js itself is not involved:
// these handlers only use the web-standard Request and Response objects.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { POST as advance } from '../app/api/audits/[id]/advance/route';
import { GET as status } from '../app/api/audits/[id]/route';
import { POST as start } from '../app/api/audits/route';
import { GET as health } from '../app/api/health/route';
import { allowRequest, resetThrottle } from '../lib/throttle';
import type { JobSnapshot, StartResponse } from '../lib/types';
import { installMockFetch, newMockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let restoreFetch: () => void;
const realLog = console.log;

before(async () => {
  shim = await startShim(6399, 3);
  await shim.flush();
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '2';
  process.env.PER_VISITOR_DAILY_LIMIT = '1';
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  restoreFetch = installMockFetch(newMockState(), shim.url);
  console.log = () => undefined;
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  await shim.close();
});

function startRequest(body: unknown, ip: string): Request {
  return new Request('https://shelf-index.test/api/audits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const anyRequest = () => new Request('https://shelf-index.test/');

test('the throttle allows a burst, then refuses, then recovers', () => {
  resetThrottle();
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i += 1) assert.equal(allowRequest('a', 6, 60_000, t0 + i), true);
  assert.equal(allowRequest('a', 6, 60_000, t0 + 10), false);
  assert.equal(allowRequest('b', 6, 60_000, t0 + 10), true, 'another caller is not affected');
  assert.equal(allowRequest('a', 6, 60_000, t0 + 60_001), true, 'allowed again once the window has passed');
});

test('starting an audit: bad input is refused before anything is stored', async () => {
  resetThrottle();
  const cases: unknown[] = ['not json', {}, { brand: 'x', category: 'skincare' }, { brand: 'Glowwell', category: 'nonsense' }, { brand: 'https://evil.example', category: 'skincare' }];
  for (const body of cases) {
    const response = await start(startRequest(body, '203.0.113.1'));
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as StartResponse;
    assert.equal(parsed.status, 'error');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(await shim.raw('KEYS', '*'), [], 'refused input must not write to storage');
});

test('a burst of start attempts from one connection is slowed down', async () => {
  resetThrottle();
  let last: Response | null = null;
  for (let i = 0; i < 7; i += 1) last = await start(startRequest({}, '203.0.113.2'));
  assert.equal(last?.status, 429);
  assert.equal(((await last?.json()) as { code: string }).code, 'too_many_requests');
});

test('start, advance and status work together over HTTP', async () => {
  resetThrottle();
  const started = await start(startRequest({ brand: 'Glowwell', category: 'skincare' }, '203.0.113.3'));
  assert.equal(started.status, 200);
  const body = (await started.json()) as StartResponse;
  assert.equal(body.status, 'started');
  if (body.status !== 'started') return;

  const first = await advance(anyRequest(), idContext(body.id));
  assert.equal(first.status, 200);
  const snapshot = (await first.json()) as JobSnapshot;
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.brand, 'Glowwell');
  assert.equal(snapshot.stages.length, 11);
  assert.equal(snapshot.stages[0].state, 'done');
  assert.equal(snapshot.stages[1].state, 'active');
  assert.ok(!JSON.stringify(snapshot).includes('si:'), 'internal storage keys are not sent to the browser');

  const read = await status(anyRequest(), idContext(body.id));
  assert.equal(((await read.json()) as JobSnapshot).status, 'running');

  // The same visitor asks for another brand: refused by the per-visitor limit, with HTTP 429.
  const again = await start(startRequest({ brand: 'Another Brand', category: 'skincare' }, '203.0.113.3'));
  assert.equal(again.status, 429);
  assert.equal(((await again.json()) as { code: string }).code, 'visitor_limit');
});

test('unknown or malformed audit ids give a 404, never an error page', async () => {
  for (const id of ['abcdefghijklmnop1234', '../../etc/passwd', 'x']) {
    assert.equal((await advance(anyRequest(), idContext(id))).status, 404);
    assert.equal((await status(anyRequest(), idContext(id))).status, 404);
  }
});

test('the setup self-check reports pass/fail and never a secret', async () => {
  const response = await health();
  const text = await response.text();
  const body = JSON.parse(text) as { ok: boolean; environment: Record<string, string>; atomicScripts: { ok: boolean }; geminiLimits: { mode: string } };
  assert.equal(body.ok, true);
  assert.equal(body.atomicScripts.ok, true);
  assert.equal(body.environment.GEMINI_API_KEY, 'set');
  assert.equal(body.geminiLimits.mode, 'one request at a time, reactive');
  for (const secret of [process.env.GEMINI_API_KEY, process.env.TAVILY_API_KEY, process.env.YOUTUBE_API_KEY, process.env.UPSTASH_REDIS_REST_TOKEN, process.env.UPSTASH_REDIS_REST_URL]) {
    assert.ok(secret && !text.includes(secret), 'the self-check must not echo a secret or the database address');
  }
  const second = (await (await health()).json()) as { reusedFromLastMinute?: boolean };
  assert.equal(second.reusedFromLastMinute, true, 'a second check within a minute does not call the services again');
});
