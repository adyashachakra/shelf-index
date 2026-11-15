// Quota tests. These run the project's real Lua scripts against a REAL Redis server
// (through a small local stand-in for Upstash's REST layer). Nothing here is simulated
// except the HTTP wrapper around Redis.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { getNumber } from '../lib/clients/redis';
import {
  recordOverage,
  reservationState,
  reserveAudit,
  settleReservation,
  spendCredits,
  sweepStaleReservations,
  unspendCredits,
  type ReservationKeys,
} from '../lib/quota/reservations';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;

before(async () => {
  shim = await startShim(6399, 1);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
});
after(async () => {
  await shim.close();
});
beforeEach(async () => {
  await shim.flush();
  process.env.DAILY_SCAN_LIMIT = '2';
  process.env.PER_VISITOR_DAILY_LIMIT = '1';
  process.env.TAVILY_MONTHLY_CREDIT_CEILING = '800';
});

function keysOf(outcome: Awaited<ReturnType<typeof reserveAudit>>): ReservationKeys {
  assert.ok(outcome.ok, 'expected the reservation to succeed');
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.keys;
}

test('reserve claims the daily slot, the visitor slot and the credits together', async () => {
  const outcome = await reserveAudit('job1', 'visitorA');
  const keys = keysOf(outcome);
  assert.equal(outcome.ok && outcome.tier, 'full');
  assert.equal(outcome.ok && outcome.credits, 9);
  assert.equal(await getNumber(keys.day), 1);
  assert.equal(await getNumber(keys.visitor), 1);
  assert.equal(await getNumber(keys.month), 9);
  assert.deepEqual(await reservationState('job1'), { reserved: 9, spent: 0, state: 'active' });
});

test('a refused reservation writes nothing at all', async () => {
  const first = keysOf(await reserveAudit('job1', 'visitorA'));
  // same visitor again: refused on the visitor limit
  const second = await reserveAudit('job2', 'visitorA');
  assert.deepEqual(second, { ok: false, reason: 'visitor' });
  assert.equal(await getNumber(first.day), 1, 'the daily counter must not move');
  assert.equal(await getNumber(first.month), 9, 'the monthly counter must not move');
  assert.equal(await reservationState('job2'), null);

  keysOf(await reserveAudit('job3', 'visitorB'));
  const fourth = await reserveAudit('job4', 'visitorC');
  assert.deepEqual(fourth, { ok: false, reason: 'daily' });
  assert.equal(await getNumber(first.day), 2);
  assert.equal(await getNumber(first.month), 18);
  assert.equal(await reservationState('job4'), null);
});

test('simultaneous visitors cannot exceed the daily limit', async () => {
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveAudit(`race${i}`, `visitor${i}`)));
  const winners = attempts.filter((a) => a.ok);
  assert.equal(winners.length, 2, 'exactly the daily limit may succeed');
  assert.ok(attempts.filter((a) => !a.ok).every((a) => !a.ok && a.reason === 'daily'));
  const keys = keysOf(winners[0]);
  assert.equal(await getNumber(keys.day), 2);
  assert.equal(await getNumber(keys.month), 18);
});

test('simultaneous visitors cannot exceed the monthly credit ceiling', async () => {
  process.env.DAILY_SCAN_LIMIT = '100';
  process.env.TAVILY_MONTHLY_CREDIT_CEILING = '20';
  const attempts = await Promise.all(Array.from({ length: 15 }, (_, i) => reserveAudit(`m${i}`, `v${i}`)));
  const winners = attempts.filter((a) => a.ok);
  const reserved = winners.reduce((sum, a) => sum + (a.ok ? a.credits : 0), 0);
  assert.ok(winners.length > 0);
  assert.ok(reserved <= 20, `reserved ${reserved} credits against a ceiling of 20`);
  const keys = keysOf(winners[0]);
  assert.equal(await getNumber(keys.month), reserved);
  assert.ok(attempts.some((a) => !a.ok && a.reason === 'monthly'));
});

test('near the ceiling a smaller research depth is chosen before refusing', async () => {
  process.env.DAILY_SCAN_LIMIT = '100';
  process.env.TAVILY_MONTHLY_CREDIT_CEILING = '4';
  const outcome = await reserveAudit('small', 'v1');
  assert.equal(outcome.ok && outcome.tier, 'minimal');
  assert.equal(outcome.ok && outcome.credits, 3);
  assert.deepEqual(await reserveAudit('none', 'v2'), { ok: false, reason: 'monthly' });
});

test('spending can never exceed the reservation, and unused credits are returned exactly once', async () => {
  const keys = keysOf(await reserveAudit('job1', 'visitorA'));
  for (let i = 0; i < 9; i += 1) assert.equal(await spendCredits('job1', 1), true);
  assert.equal(await spendCredits('job1', 1), false, 'the tenth credit must be refused');
  await unspendCredits('job1', 4);
  assert.deepEqual(await reservationState('job1'), { reserved: 9, spent: 5, state: 'active' });

  const settled = await settleReservation('job1', keys, false);
  assert.deepEqual(settled, { settled: true, creditsReturned: 4, slotsReturned: false });
  assert.equal(await getNumber(keys.month), 5, 'the month now holds only what was actually spent');
  assert.equal(await getNumber(keys.day), 1, 'the daily slot stays used');

  const again = await settleReservation('job1', keys, false);
  assert.deepEqual(again, { settled: false, creditsReturned: 0, slotsReturned: false });
  assert.equal(await getNumber(keys.month), 5, 'settling twice must not return credits twice');
  assert.equal(await spendCredits('job1', 1), false, 'a settled reservation cannot be spent from');
});

test('a failed audit that spent nothing gives back its slots; one that spent keeps them', async () => {
  const unspent = keysOf(await reserveAudit('job1', 'visitorA'));
  assert.deepEqual(await settleReservation('job1', unspent, true), { settled: true, creditsReturned: 9, slotsReturned: true });
  assert.equal(await getNumber(unspent.day), 0);
  assert.equal(await getNumber(unspent.visitor), 0);
  assert.equal(await getNumber(unspent.month), 0);

  const spent = keysOf(await reserveAudit('job2', 'visitorA'));
  await spendCredits('job2', 2);
  assert.deepEqual(await settleReservation('job2', spent, true), { settled: true, creditsReturned: 7, slotsReturned: false });
  assert.equal(await getNumber(spent.day), 1);
  assert.equal(await getNumber(spent.month), 2);
});

test('an overcharge by the provider is recorded immediately', async () => {
  const keys = keysOf(await reserveAudit('job1', 'visitorA'));
  for (let i = 0; i < 9; i += 1) await spendCredits('job1', 1);
  await recordOverage('job1', keys.month, 2);
  assert.deepEqual(await reservationState('job1'), { reserved: 11, spent: 11, state: 'active' });
  assert.equal(await getNumber(keys.month), 11, 'reality wins: the month reflects what was charged');
});

test('abandoned reservations are swept and their unused credits returned', async () => {
  const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
  const keys = keysOf(await reserveAudit('stale', 'visitorA', old));
  await spendCredits('stale', 3);
  keysOf(await reserveAudit('fresh', 'visitorB'));
  const swept = await sweepStaleReservations();
  assert.equal(swept, 1);
  // Before the sweep the month held 9 (stale, of which 3 spent) + 9 (fresh) = 18.
  // The sweep returns the stale audit's 6 unused credits: 3 spent + 9 still reserved = 12.
  assert.equal(await getNumber(keys.month), 12);
  assert.equal((await reservationState('stale'))?.state, 'settled');
  assert.equal((await reservationState('fresh'))?.state, 'active');
});
