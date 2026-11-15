import 'server-only';
import type { Tier } from './types';

// Every tunable number lives here. Values are read from environment variables at call time,
// so nothing below ever contains a secret.

function readInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function intOr(name: string, fallback: number, min: number, max: number): number {
  const n = readInt(name);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function positiveOrNull(name: string): number | null {
  const n = readInt(name);
  return n !== null && n > 0 ? n : null;
}

/** Tavily credits an audit may spend at each research depth. */
export const TIER_CREDITS: Record<Tier, number> = { full: 9, reduced: 5, minimal: 3 };
export const TIER_ORDER: Tier[] = ['full', 'reduced', 'minimal'];

export const QUESTIONS_PER_AUDIT = 8;
/** Used only to check there is room in the Gemini daily allowance before starting. */
export const GEMINI_REQUESTS_PER_AUDIT = 18;
/** How long one "advance" request may work before handing back to the browser. */
export const STAGE_BUDGET_MS = 42_000;
export const GEMINI_TIMEOUT_MS = 38_000;
export const JOB_TTL_SECONDS = 26 * 60 * 60;
export const RESERVATION_MAX_AGE_MS = 26 * 60 * 60 * 1000;
export const INFLIGHT_TTL_SECONDS = 26 * 60 * 60;
/**
 * Bump this whenever the shape of a saved report, or a rule that changes its verdicts, changes.
 * New reports are saved under this version, and a repeat audit never reuses a report saved under an
 * older one (so an audit repeated after a rule change runs again under the new rules).
 */
export const REPORT_FORMAT_VERSION = 5;
/**
 * Saved-report versions that can still be OPENED, newest first. Versions 3 to 5 only differ by
 * optional fields and by the rules that produced the verdicts, and the report pages treat every
 * newer field as optional, so older links keep working until they expire. Version 2 (the first
 * V1.1 preview) has the same overall shape and is opened as it was saved: nothing missing is filled
 * in. Version 1 (V1.0) has a different shape and cannot be rendered by these pages: V1.0 reports
 * stay on the original deployment.
 */
export const READABLE_REPORT_VERSIONS: readonly number[] = [5, 4, 3, 2];
/** Share of the configured per-minute limit the app allows itself to use. */
export const GEMINI_RPM_HEADROOM = 0.8;

export const config = {
  geminiApiKey: () => (process.env.GEMINI_API_KEY ?? '').trim(),
  // Flash-Lite is the default because, on the Gemini API free tier, the larger Flash models
  // allow too few requests a day to finish one audit. Check your own limits in AI Studio.
  geminiModel: () => (process.env.GEMINI_MODEL ?? '').trim() || 'gemini-3.5-flash-lite',
  /** Requests per minute from the owner's AI Studio page. null = not set (one-at-a-time mode). */
  geminiRpm: () => positiveOrNull('GEMINI_RPM'),
  /** Requests per day from the owner's AI Studio page. null = not set. */
  geminiRpd: () => positiveOrNull('GEMINI_RPD'),
  tavilyApiKey: () => (process.env.TAVILY_API_KEY ?? '').trim(),
  youtubeApiKey: () => (process.env.YOUTUBE_API_KEY ?? '').trim(),
  dailyScanLimit: () => intOr('DAILY_SCAN_LIMIT', 2, 0, 500),
  perVisitorDailyLimit: () => intOr('PER_VISITOR_DAILY_LIMIT', 1, 1, 50),
  tavilyMonthlyCeiling: () => intOr('TAVILY_MONTHLY_CREDIT_CEILING', 800, 0, 100_000),
  cacheDays: () => intOr('CACHE_DAYS', 7, 1, 30),
  quotaTimezone: () => (process.env.QUOTA_TIMEZONE ?? '').trim() || 'America/Los_Angeles',
};

export function missingRequiredEnv(): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey()) missing.push('GEMINI_API_KEY');
  if (!config.tavilyApiKey()) missing.push('TAVILY_API_KEY');
  const hasRedis =
    Boolean((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim()) &&
    Boolean((process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim());
  if (!hasRedis) missing.push('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN');
  return missing;
}

export const USER_MESSAGES = {
  dailyLimit: 'Daily free scans used up. Please try again tomorrow.',
  visitorLimit:
    'You have used your free audit for today. Please try again tomorrow. Saved reports and the example report are still available.',
  monthlyLimit:
    "This month's free research budget is used up. New audits reopen on the 1st. Saved reports and the example report still work.",
  geminiDaily:
    "Gemini's free daily quota is used up. New audits reopen after it resets (midnight Pacific time).",
  setup: 'This site is not fully set up yet. The owner needs to finish adding its configuration.',
  storage: 'The audit store is not reachable right now. Please try again in a minute.',
  tooManyRequests: 'Too many attempts in a short time. Please wait a minute and try again.',
};
