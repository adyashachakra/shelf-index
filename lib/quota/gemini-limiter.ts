import 'server-only';
import { cmd, evalScript, getString, RedisError } from '../clients/redis';
import { config, GEMINI_RPM_HEADROOM } from '../config';
import { dayKey } from './dates';
import { GEMINI_SLOT_SCRIPT } from './scripts';

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
  | { ok: true; auditCount: number; dayCount: number }
  | { ok: false; kind: 'wait'; seconds: number; reason: string }
  | { ok: false; kind: 'daily' }
  | { ok: false; kind: 'ceiling'; auditCount: number }
  /**
   * The audit store (Redis) could not answer, so the request was NOT allowed. This is an infrastructure
   * failure, not a Gemini limit. "quota" means the store itself reported that its free request limit is
   * used up; "unavailable" is any other failure or an unreadable reply.
   */
  | { ok: false; kind: 'storage'; reason: 'quota' | 'unavailable' };

/** How long a per-audit request counter lives: the job's lifetime plus an hour. */
const AUDIT_COUNTER_TTL_SECONDS = 97_200;

export function auditCounterKey(auditId: string): string {
  return `si:gemini:audit:${auditId}`;
}

/** The store's own wording when its monthly or daily free request limit is used up (Upstash documents these). */
function storeLimitReached(err: RedisError): boolean {
  const m = err.message.toLowerCase();
  return m.includes('max requests limit exceeded') || m.includes('max daily request limit exceeded');
}

/**
 * Ask for permission to send one Gemini request now, and count it, in one atomic Redis step.
 * Every limit is checked before anything is written; a refusal writes nothing.
 * `ceiling` is the most requests one audit may send; 0 means no per-audit limit.
 * If the store cannot answer, the request is NOT allowed (fail closed) and nothing is counted.
 */
export async function acquireGeminiSlot(auditId: string, ceiling: number, now: Date = new Date()): Promise<SlotResult> {
  const nowMs = now.getTime();
  const rpm = config.geminiRpm();
  const rpd = config.geminiRpd();
  const minute = Math.floor(nowMs / 60_000);
  const allowedPerMinute = rpm !== null ? Math.max(1, Math.floor(rpm * GEMINI_RPM_HEADROOM)) : 0;

  let reply: unknown;
  try {
    reply = await evalScript(
      GEMINI_SLOT_SCRIPT,
      [
        `si:gemini:min:${minute}`,
        `si:gemini:min:${minute - 1}`,
        dailyCounterKey(now),
        auditCounterKey(auditId),
        COOLDOWN_KEY,
        exhaustedKey(now),
      ],
      [nowMs, rpd ?? 0, allowedPerMinute, ceiling, 180, 3 * 24 * 60 * 60, AUDIT_COUNTER_TTL_SECONDS],
    );
  } catch (err) {
    if (!(err instanceof RedisError)) throw err;
    return { ok: false, kind: 'storage', reason: storeLimitReached(err) ? 'quota' : 'unavailable' };
  }

  // Anything but the documented reply shape is treated as a failure, never as permission.
  if (!Array.isArray(reply) || reply.length < 3 || (reply[0] !== 0 && reply[0] !== 1) || typeof reply[1] !== 'string') {
    return { ok: false, kind: 'storage', reason: 'unavailable' };
  }
  const value = Number(reply[2]);
  if (!Number.isFinite(value)) return { ok: false, kind: 'storage', reason: 'unavailable' };

  if (reply[0] === 1) {
    const dayCount = Number(reply[3]);
    if (reply[1] !== 'ok' || !Number.isFinite(dayCount)) return { ok: false, kind: 'storage', reason: 'unavailable' };
    return { ok: true, auditCount: value, dayCount };
  }
  switch (reply[1]) {
    case 'ceiling':
      return { ok: false, kind: 'ceiling', auditCount: value };
    case 'daily':
      return { ok: false, kind: 'daily' };
    case 'cooldown':
      return {
        ok: false,
        kind: 'wait',
        seconds: Math.min(90, Math.ceil((value - nowMs) / 1000) + 1),
        reason: 'Gemini asked us to slow down',
      };
    case 'pace': {
      const elapsedFraction = (nowMs % 60_000) / 60_000;
      const untilNextMinute = Math.ceil(60 - elapsedFraction * 60);
      // `value` is this request's would-be place in the current minute.
      const seconds = value > allowedPerMinute ? untilNextMinute + 1 : Math.min(untilNextMinute + 1, 8);
      return { ok: false, kind: 'wait', seconds, reason: 'Pacing requests to stay inside the Gemini free tier' };
    }
    default:
      return { ok: false, kind: 'storage', reason: 'unavailable' };
  }
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

/** Requests this audit has sent so far, as counted by the gate. 0 when none. */
export async function geminiRequestsForAudit(auditId: string): Promise<number> {
  const value = await getString(auditCounterKey(auditId));
  return value === null ? 0 : Number.parseInt(value, 10) || 0;
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
