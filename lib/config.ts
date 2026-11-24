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
/**
 * The most Gemini requests ONE audit may send. A fixed constant, deliberately not an environment variable.
 * 60 = 51 (the largest total the 3-attempts-per-step rule allows for a typed-in category: 17 calls x 3)
 *    + 5 (one full format-downgrade ladder after an HTTP 400) + 4 (rate-limit retries; a judgement, not a measurement).
 * A normal audit sends 16 requests, so this only ever bites on an audit that is failing badly.
 * The 61st request is never sent: the audit stops asking Gemini, keeps what it has, and says why in its report.
 */
export const GEMINI_AUDIT_REQUEST_CEILING = 60;
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
 *
 * 7: audits now settle which brand they are about before researching it. Without this bump the cached
 * format 6 report for COS / Skincare (a report about look-alike brands) would be handed to a repeat audit.
 *
 * 8: the report's Gemini request count is now the number of requests the app actually sent or tried to send,
 * counted in one atomic Redis step before each request (it used to count one per logical call and missed
 * format-negotiation retries). A cached format 7 report is therefore not handed to a repeat audit.
 *
 * 9: evidence-quality rules changed. A short brand name is no longer treated as a different name merely because a season or
 * country code ("COS A/W", "COS IE"), a one-letter word or the brand itself follows it; title and snippet are checked
 * separately; and "how long does it last" questions are a claim kind of their own. "Found but not counted" entries can
 * also carry the text that triggered them. A cached format 8 report is therefore not handed to a repeat audit (it stays
 * openable by its link until it expires).
 *
 * 10: a company-profile field label at the start of a field ("# COS ID: IrthV3LEdVhE") is no longer read as a
 * different name, so evidence a format 9 audit set aside can now be counted. A cached format 9 report is therefore not
 * handed to a repeat audit (it stays openable by its link until it expires). The report shape is unchanged.
 */
export const REPORT_FORMAT_VERSION = 10;
/**
 * Saved-report versions that can still be OPENED, newest first. Versions 3 to 10 only differ by
 * optional fields and by the rules that produced the verdicts, and the report pages treat every
 * newer field as optional, so older links keep working until they expire. Version 2 (the first
 * V1.1 preview) has the same overall shape and is opened as it was saved: nothing missing is filled
 * in. Version 1 (V1.0) has a different shape and cannot be rendered by these pages: V1.0 reports
 * stay on the original deployment.
 */
export const READABLE_REPORT_VERSIONS: readonly number[] = [10, 9, 8, 7, 6, 5, 4, 3, 2];
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
  /**
   * SI_KEY_NAMESPACE, trimmed, or null when unset or empty. Set it on Preview only (for example "preview") so
   * Preview's audit state lives apart from Production's in the shared database; leave it unset on Production.
   * Validated in lib/cache/keys.ts; an invalid value stops the app from reading or writing audit state.
   */
  keyNamespace: (): string | null => (process.env.SI_KEY_NAMESPACE ?? '').trim() || null,
  /** Vercel's own environment name ("production", "preview", "development"), or "" outside Vercel. */
  vercelEnvironment: () => (process.env.VERCEL_ENV ?? '').trim(),
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
  /** SI_KEY_NAMESPACE is set to an unusable value: nothing is read or written until it is fixed. */
  keyNamespace: 'This site\'s storage setting (SI_KEY_NAMESPACE) is not valid for this deployment, so audits and reports are unavailable until the owner fixes it.',
  storage: 'The audit store is not reachable right now. Please try again in a minute.',
  storageQuota:
    "The audit store's free usage limit has been reached for now, so nothing could be started or continued. No Gemini request was made. Please try again later.",
  tooManyRequests: 'Too many attempts in a short time. Please wait a minute and try again.',
  /** Shown in "What was missing from this audit" when an audit stopped at its Gemini request limit. */
  geminiCeiling: `This audit reached its limit of ${GEMINI_AUDIT_REQUEST_CEILING} Gemini requests, so it stopped asking Gemini. Steps that had not finished are listed as unavailable and are not scored as zero. This report was not saved as the cached result for this brand, so a later audit of it will run again instead of reusing it.`,
  /** The reason on a question that was not answered because the audit reached its Gemini request limit. */
  geminiCeilingQuestion: 'Not answered: this audit reached its Gemini request limit',
  /** The stop message when the limit was reached before any question had a usable answer. */
  geminiCeilingNoAnswers: 'This audit reached its Gemini request limit before any question had a usable answer, so it could not continue.',
};
