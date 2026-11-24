import { checkGeminiModel } from '@/lib/clients/gemini';
import { cmd, evalScript, redisConfigured } from '@/lib/clients/redis';
import { keyNamespaceProblem } from '@/lib/cache/keys';
import { config } from '@/lib/config';
import { safeErrorMessage } from '@/lib/log';
import { geminiRequestsToday } from '@/lib/quota/gemini-limiter';
import { quotaSnapshot } from '@/lib/quota/reservations';

// GET /api/health : a setup self-check to open after deploying.
// It reports whether each piece is configured and reachable. It never returns a key, a token,
// a URL or any other secret value, only "set" / "missing" and pass / fail.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Check {
  ok: boolean;
  detail: string;
}

// The checks below call Redis and Gemini, so the answer is reused for a minute. Without this,
// anyone refreshing this address in a loop could eat into the free allowances.
const REUSE_MS = 60_000;
let lastAnswer: { at: number; body: Record<string, unknown> } | null = null;

export async function GET(): Promise<Response> {
  if (lastAnswer && Date.now() - lastAnswer.at < REUSE_MS) {
    return Response.json({ ...lastAnswer.body, reusedFromLastMinute: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const body = await runChecks();
  lastAnswer = { at: Date.now(), body };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

async function runChecks(): Promise<Record<string, unknown>> {
  const environment = {
    GEMINI_API_KEY: config.geminiApiKey() ? 'set' : 'missing',
    TAVILY_API_KEY: config.tavilyApiKey() ? 'set' : 'missing',
    YOUTUBE_API_KEY: config.youtubeApiKey() ? 'set' : 'missing (YouTube will be skipped)',
    UPSTASH_REDIS: redisConfigured() ? 'set' : 'missing',
  };

  // Which audit-state namespace this deployment uses. The value itself is not secret (it is a short label such as
  // "preview"); an invalid value is reported without echoing it.
  const namespaceProblem = keyNamespaceProblem();
  const namespaceValue = config.keyNamespace();
  const keyNamespace: Check & { value: string } = namespaceProblem
    ? { ok: false, value: 'invalid', detail: namespaceProblem }
    : namespaceValue
      ? { ok: true, value: namespaceValue, detail: 'Audit state is kept apart from other environments; Gemini and Tavily counters are shared.' }
      : { ok: true, value: 'none', detail: 'Audit state uses the shared key names (correct for Production).' };

  let redis: Check = { ok: false, detail: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set' };
  let atomicScripts: Check = { ok: false, detail: 'Not checked' };
  let quota: Record<string, number> | null = null;
  let requestsToday: number | null = null;
  if (redisConfigured()) {
    try {
      const pong = await cmd<string>('PING');
      redis = { ok: pong === 'PONG', detail: pong === 'PONG' ? 'Reachable' : 'Unexpected reply' };
    } catch (err) {
      redis = { ok: false, detail: safeErrorMessage(err) };
    }
    if (redis.ok) {
      try {
        const result = await evalScript<number>('return tonumber(ARGV[1]) + 1', [], [41]);
        atomicScripts = Number(result) === 42 ? { ok: true, detail: 'Lua scripts run (needed for atomic limits)' } : { ok: false, detail: 'Unexpected script result' };
      } catch (err) {
        atomicScripts = { ok: false, detail: safeErrorMessage(err) };
      }
      try {
        if (namespaceProblem) throw new Error('key namespace invalid');
        const snapshot = await quotaSnapshot();
        quota = {
          newAuditsToday: snapshot.scansToday,
          dailyLimit: snapshot.scanLimit,
          tavilyCreditsReservedOrSpentThisMonth: snapshot.creditsThisMonth,
          tavilyMonthlyCeiling: snapshot.creditCeiling,
        };
        requestsToday = await geminiRequestsToday();
      } catch {
        quota = null;
      }
    }
  }

  const gemini = await checkGeminiModel();
  const rpm = config.geminiRpm();
  const rpd = config.geminiRpd();
  const notes: string[] = [];
  if (rpm === null || rpd === null) {
    notes.push(
      'GEMINI_RPM and/or GEMINI_RPD are not set. Copy them from your AI Studio rate-limit page. Until then the app sends one Gemini request at a time and only obeys the wait times Gemini returns.',
    );
  }
  if (environment.YOUTUBE_API_KEY !== 'set') notes.push('Without YOUTUBE_API_KEY, audits run without YouTube comments.');
  if (namespaceProblem) notes.push(`${namespaceProblem} Audits and reports are unavailable until it is fixed.`);
  else if (!namespaceValue && config.vercelEnvironment() === 'preview') {
    notes.push(
      'WARNING: this is a Preview deployment but SI_KEY_NAMESPACE is not set, so its audits, cached reports and daily slots are shared with Production. Set SI_KEY_NAMESPACE (for example "preview") for the Preview environment.',
    );
  }

  const ok =
    environment.GEMINI_API_KEY === 'set' && environment.TAVILY_API_KEY === 'set' && redis.ok && atomicScripts.ok && gemini.ok && keyNamespace.ok;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    environment,
    keyNamespace,
    redis,
    atomicScripts,
    gemini: { ...gemini, model: config.geminiModel() },
    geminiLimits: {
      requestsPerMinute: rpm ?? 'not set',
      requestsPerDay: rpd ?? 'not set',
      mode: rpm === null ? 'one request at a time, reactive' : 'paced to the configured limit',
      requestsSentToday: requestsToday,
    },
    quota,
    notes,
  };
}
