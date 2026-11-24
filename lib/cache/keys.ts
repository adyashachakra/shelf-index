import 'server-only';
import { config } from '../config';

// Every Redis key the app writes is built here.
//
// Preview and Production use ONE Upstash database. Two kinds of keys live in it:
//
//  1. Audit state, which belongs to one deployment environment: saved reports, the brand-and-category cache
//     pointers, audits in progress, their locks, the per-brand in-flight lock, the cached custom-category questions,
//     Tavily credit reservations and their sweep list, and the daily and per-visitor audit slots. These are SCOPED:
//     when SI_KEY_NAMESPACE is set (on Preview), they carry the namespace ("si:preview:job:<id>"), so a Preview test
//     audit can never be served to, resumed by, locked against or counted against Production, or the other way round.
//     When it is unset (Production), they are exactly the names the app has always used ("si:job:<id>").
//
//  2. Provider quota, which belongs to the API keys: the Gemini day, minute, cooldown, exhausted and per-audit
//     request counters, and the Tavily month counter and exhausted flag. These are SHARED and never namespaced.
//     Preview and Production use the same Gemini and Tavily keys, so they really do share Google's daily and
//     per-minute allowance and Tavily's monthly credits. Splitting these counters would let each environment
//     believe it had the whole allowance to itself, and together they could overrun it.

/** A namespace is lower-case letters, digits and hyphens, starting with a letter, at most 24 characters. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Words a namespace may not be: the first part of a key the app already uses, so a namespaced key could never be
 * mistaken for (or collide with) an existing one, for example "si:gemini:…" or "si:report:…".
 */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  'report',
  'cache',
  'job',
  'lock',
  'inflight',
  'questions',
  'resv',
  'resv-active',
  'day',
  'visitor',
  'gemini',
  'tavily',
]);

/** SI_KEY_NAMESPACE is set but is not a usable namespace. Nothing is read or written while this is the case. */
export class KeyNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyNamespaceError';
  }
}

/**
 * Why the configured namespace cannot be used, or null when it is unset or valid. Never includes the raw value.
 *
 * A namespace is for Preview (and local development) only. On a Vercel Production deployment (VERCEL_ENV=production)
 * ANY non-empty value is rejected, even a well-formed one: applying it would silently move Production onto a new,
 * empty set of keys, so it would stop finding its cached reports, running audits and daily slots. Outside Vercel
 * (VERCEL_ENV unset) nothing changes.
 */
export function keyNamespaceProblem(): string | null {
  const raw = config.keyNamespace();
  if (raw === null) return null;
  if (config.vercelEnvironment() === 'production') {
    return 'SI_KEY_NAMESPACE is set on the Production environment. It must be left unset there; remove it from the Production environment variables.';
  }
  if (!NAMESPACE_PATTERN.test(raw)) {
    return 'SI_KEY_NAMESPACE must be 1 to 24 lower-case letters, digits or hyphens, starting with a letter (for example "preview").';
  }
  if (RESERVED_NAMESPACES.has(raw)) return 'SI_KEY_NAMESPACE must not be a word the app already uses in its key names (for example "report" or "gemini").';
  return null;
}

/**
 * The namespace for audit-state keys: "" when SI_KEY_NAMESPACE is unset (today's key names), the value when it is
 * valid. An invalid non-empty value THROWS: it never falls back to the shared, unnamespaced keys, because a
 * mistyped Preview setting would otherwise silently put Preview back into Production's data.
 */
export function keyNamespace(): string {
  const problem = keyNamespaceProblem();
  if (problem) throw new KeyNamespaceError(problem);
  return config.keyNamespace() ?? '';
}

function scoped(rest: string): string {
  const namespace = keyNamespace();
  return namespace === '' ? `si:${rest}` : `si:${namespace}:${rest}`;
}

/** Audit-state keys: namespaced on Preview, today's exact names when SI_KEY_NAMESPACE is unset. */
export const envKeys = {
  report: (version: number, id: string): string => scoped(`report:v${version}:${id}`),
  cachePointer: (version: number, cacheKey: string): string => scoped(`cache:v${version}:${cacheKey}`),
  job: (id: string): string => scoped(`job:${id}`),
  lock: (id: string): string => scoped(`lock:${id}`),
  inflight: (cacheKey: string): string => scoped(`inflight:${cacheKey}`),
  questions: (bankVersion: string | number, categoryKey: string): string => scoped(`questions:${bankVersion}:${categoryKey}`),
  reservation: (jobId: string): string => scoped(`resv:${jobId}`),
  reservationsActive: (): string => scoped('resv-active'),
  auditDay: (day: string): string => scoped(`day:${day}`),
  visitor: (day: string, visitorHash: string): string => scoped(`visitor:${day}:${visitorHash}`),
};

/** Provider-quota keys: the same in every environment, on purpose (see the top of this file). */
export const sharedKeys = {
  geminiCooldown: (): string => 'si:gemini:cooldown',
  geminiDay: (day: string): string => `si:gemini:day:${day}`,
  geminiExhausted: (day: string): string => `si:gemini:exhausted:${day}`,
  geminiMinute: (minute: number): string => `si:gemini:min:${minute}`,
  geminiAudit: (auditId: string): string => `si:gemini:audit:${auditId}`,
  tavilyMonth: (month: string): string => `si:tavily:${month}`,
  tavilyExhausted: (month: string): string => `si:tavily:exhausted:${month}`,
};

/**
 * The key a report had before namespaces existed, used ONLY to open an old report by its id from a namespaced
 * environment (see loadReport). Never used for cache pointers, audits, locks, slots or reservations, and never
 * written to.
 */
export function legacyReportKey(version: number, id: string): string {
  return `si:report:v${version}:${id}`;
}
