import 'server-only';
import { cmd, getString, pipeline } from '../clients/redis';
import { config, GEMINI_RPM_HEADROOM } from '../config';
import { dayKey } from './dates';

// Gemini pacing. The per-minute and per-day limits come from GEMINI_RPM and GEMINI_RPD, which the
// site owner copies from their own AI Studio rate-limit page. No limit is assumed in code:
// when they are not set, requests go out one at a time and the app only obeys the wait
// times that Gemini itself returns (the cooldown below).

const COOLDOWN_KEY = 'si:gemini:cooldown';

function dailyCounterKey(now: Date): string {
  return `si:gemini:day:${dayKey(config.quotaTimezone(), now)}`;
}
function exhaustedKey(now: Date): string {
  return `si:gemini:exhausted:${dayKey(config.quotaTimezone(), now)}`;
}

export type SlotResult =
  | { ok: true }
  | { ok: false; kind: 'wait'; seconds: number; reason: string }
  | { ok: false; kind: 'daily' };

/** Ask for permission to send one Gemini request now. Counts the request when granted. */
export async function acquireGeminiSlot(now: Date = new Date()): Promise<SlotResult> {
  const nowMs = now.getTime();
  const cooldownUntil = Number.parseInt((await getString(COOLDOWN_KEY)) ?? '0', 10) || 0;
  if (cooldownUntil > nowMs) {
    return {
      ok: false,
      kind: 'wait',
      seconds: Math.min(90, Math.ceil((cooldownUntil - nowMs) / 1000) + 1),
      reason: 'Gemini asked us to slow down',
    };
  }
  if ((await getString(exhaustedKey(now))) !== null) return { ok: false, kind: 'daily' };

  const rpm = config.geminiRpm();
  const rpd = config.geminiRpd();
  const minute = Math.floor(nowMs / 60_000);
  const currentKey = `si:gemini:min:${minute}`;
  const previousKey = `si:gemini:min:${minute - 1}`;
  const dayCounter = dailyCounterKey(now);

  const results = await pipeline([
    ['INCR', currentKey],
    ['EXPIRE', currentKey, 180],
    ['GET', previousKey],
    ['INCR', dayCounter],
    ['EXPIRE', dayCounter, 3 * 24 * 60 * 60],
  ]);
  const current = Number(results[0]) || 0;
  const previous = Number.parseInt(String(results[2] ?? '0'), 10) || 0;
  const today = Number(results[3]) || 0;

  if (rpd !== null && today > rpd) {
    await pipeline([
      ['DECR', currentKey],
      ['DECR', dayCounter],
    ]);
    return { ok: false, kind: 'daily' };
  }

  if (rpm !== null) {
    const allowed = Math.max(1, Math.floor(rpm * GEMINI_RPM_HEADROOM));
    const elapsedFraction = (nowMs % 60_000) / 60_000;
    // Sliding-window estimate: the previous minute still counts in proportion to how recent it is.
    const estimated = previous * (1 - elapsedFraction) + current;
    if (estimated > allowed) {
      await pipeline([
        ['DECR', currentKey],
        ['DECR', dayCounter],
      ]);
      const untilNextMinute = Math.ceil(60 - elapsedFraction * 60);
      const seconds = current > allowed ? untilNextMinute + 1 : Math.min(untilNextMinute + 1, 8);
      return { ok: false, kind: 'wait', seconds, reason: 'Pacing requests to stay inside the Gemini free tier' };
    }
  }
  return { ok: true };
}

/** Gemini returned a per-minute rate limit: make every part of the app wait. */
export async function noteGeminiCooldown(seconds: number, now: Date = new Date()): Promise<void> {
  const clamped = Math.max(2, Math.min(120, Math.ceil(seconds)));
  await cmd('SET', COOLDOWN_KEY, now.getTime() + clamped * 1000, 'EX', clamped + 5);
}

/** Gemini returned a per-day quota error: stop sending requests until the day rolls over. */
export async function markGeminiDailyExhausted(now: Date = new Date()): Promise<void> {
  await cmd('SET', exhaustedKey(now), '1', 'EX', 26 * 60 * 60);
}

export async function isGeminiDailyExhausted(now: Date = new Date()): Promise<boolean> {
  return (await getString(exhaustedKey(now))) !== null;
}

export async function geminiRequestsToday(now: Date = new Date()): Promise<number> {
  const value = await getString(dailyCounterKey(now));
  return value === null ? 0 : Number.parseInt(value, 10) || 0;
}

/** Is there room in the configured daily allowance for one more full audit? */
export async function hasDailyRoomForAudit(requestsNeeded: number, now: Date = new Date()): Promise<boolean> {
  if (await isGeminiDailyExhausted(now)) return false;
  const rpd = config.geminiRpd();
  if (rpd === null) return true;
  return (await geminiRequestsToday(now)) + requestsNeeded <= rpd;
}
