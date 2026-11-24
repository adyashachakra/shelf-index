import 'server-only';
import { keyNamespaceProblem } from '../cache/keys';
import {
  acquireJobLock,
  claimInflight,
  createJob,
  forceReleaseInflight,
  getInflight,
  loadJob,
  newAuditId,
  releaseInflight,
  releaseJobLock,
  saveMeta,
} from '../cache/jobs';
import { findCachedReportId } from '../cache/reports';
import { config, GEMINI_REQUESTS_PER_AUDIT, missingRequiredEnv, STAGE_BUDGET_MS, USER_MESSAGES } from '../config';
import { brandKey } from '../evidence/brand-match';
import { identityStopMessage } from '../evidence/identity';
import { logEvent, safeErrorMessage } from '../log';
import { dayKey } from '../quota/dates';
import { hasDailyRoomForAudit, isGeminiDailyExhausted } from '../quota/gemini-limiter';
import { reserveAudit, settleReservation, sweepStaleReservations } from '../quota/reservations';
import type { JobSnapshot, StartErrorCode, StartResponse } from '../types';
import type { AuditInput } from '../validation/input';
import { createContext, isTavilyExhausted, PauseSignal, StopSignal, StorageSignal, WaitSignal, type StageContext } from './context';
import { snapshotOf, STAGE_ORDER, type JobMeta, type StageId } from './job';
import { runAskGemini } from './stages/ask-gemini';
import { runAudienceSearch } from './stages/audience-search';
import { runBrandProfile } from './stages/brand-profile';
import { runClaimCheck } from './stages/claim-check';
import { runCompetitors } from './stages/competitors';
import { runFinalize } from './stages/finalize';
import { runPerception } from './stages/perception';
import { runQuestions } from './stages/questions';
import { runSynthesis } from './stages/synthesis';
import { runWebsite } from './stages/website';
import { runYouTube } from './stages/youtube';

const RUNNERS: Record<StageId, (ctx: StageContext) => Promise<'done' | 'continue'>> = {
  questions: runQuestions,
  ask: runAskGemini,
  profile: runBrandProfile,
  audience: runAudienceSearch,
  youtube: runYouTube,
  perception: runPerception,
  website: runWebsite,
  claims: runClaimCheck,
  competitors: runCompetitors,
  synthesis: runSynthesis,
  finalize: runFinalize,
};

const MAX_STAGE_ERRORS = 3;

/** One-way hash of the visitor's IP for the per-visitor daily limit. The raw IP is never stored. */
async function hashVisitor(ip: string): Promise<string> {
  const day = dayKey(config.quotaTimezone());
  const bytes = new TextEncoder().encode(`shelf-index|${day}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

export interface StartResult {
  httpStatus: number;
  body: StartResponse;
}

function startError(httpStatus: number, code: StartErrorCode, message: string): StartResult {
  return { httpStatus, body: { status: 'error', code, message } };
}

/**
 * Begin an audit, or point the visitor at an existing report or a running audit for the same
 * brand + category. All limits are claimed in one atomic step before any API is called.
 */
export async function startAudit(input: AuditInput, visitorIp: string): Promise<StartResult> {
  const missing = missingRequiredEnv();
  if (missing.length > 0) {
    logEvent('start_blocked_setup', { missing: missing.join(',') });
    return startError(503, 'setup', USER_MESSAGES.setup);
  }
  // An invalid SI_KEY_NAMESPACE must stop everything: falling back to the shared keys would put a Preview's audits
  // into Production's data. (Every key builder also refuses it, so nothing below could run anyway.)
  if (keyNamespaceProblem()) {
    logEvent('start_blocked_setup', { missing: 'SI_KEY_NAMESPACE (invalid)' });
    return startError(503, 'setup', USER_MESSAGES.keyNamespace);
  }

  const cached = await findCachedReportId(input.cacheKey);
  if (cached) return { httpStatus: 200, body: { status: 'cached', id: cached } };

  const running = await getInflight(input.cacheKey);
  if (running) {
    const existing = await loadJob(running);
    if (existing && (existing.meta.status === 'running' || existing.meta.status === 'paused')) {
      return { httpStatus: 200, body: { status: 'in_progress', id: running } };
    }
    await forceReleaseInflight(input.cacheKey);
  }

  if (await isTavilyExhausted()) return startError(429, 'monthly_limit', USER_MESSAGES.monthlyLimit);
  if (!(await hasDailyRoomForAudit(GEMINI_REQUESTS_PER_AUDIT))) {
    return startError(429, 'gemini_quota', USER_MESSAGES.geminiDaily);
  }

  await sweepStaleReservations();

  const id = newAuditId();
  const owner = await claimInflight(input.cacheKey, id);
  if (owner !== id) return { httpStatus: 200, body: { status: 'in_progress', id: owner } };

  const reservation = await reserveAudit(id, await hashVisitor(visitorIp));
  if (!reservation.ok) {
    await releaseInflight(input.cacheKey, id);
    logEvent('start_refused', { reason: reservation.reason });
    if (reservation.reason === 'daily') return startError(429, 'daily_limit', USER_MESSAGES.dailyLimit);
    if (reservation.reason === 'visitor') return startError(429, 'visitor_limit', USER_MESSAGES.visitorLimit);
    return startError(429, 'monthly_limit', USER_MESSAGES.monthlyLimit);
  }

  const now = new Date().toISOString();
  const meta: JobMeta = {
    id,
    brand: input.brand,
    brandCasing: input.brandCasing,
    brandKey: brandKey(input.brand),
    categoryId: input.categoryId,
    categoryLabel: input.categoryLabel,
    categoryNoun: input.categoryNoun,
    categoryPlural: input.categoryPlural,
    cacheKey: input.cacheKey,
    tier: reservation.tier,
    status: 'running',
    stageIndex: 0,
    notes: {},
    warnings: [],
    attempts: {},
    createdAt: now,
    updatedAt: now,
    model: config.geminiModel(),
    keys: reservation.keys,
    geminiRequests: 0,
    creditsSpent: 0,
    searches: [],
  };
  try {
    await createJob(meta);
  } catch (err) {
    await settleReservation(id, reservation.keys, true);
    await releaseInflight(input.cacheKey, id);
    logEvent('start_failed_storage', { error: safeErrorMessage(err) });
    return startError(503, 'storage', USER_MESSAGES.storage);
  }
  logEvent('audit_started', { tier: meta.tier, category: meta.categoryId });
  return { httpStatus: 200, body: { status: 'started', id } };
}

/**
 * The brand could not be identified in the selected category, so the audit ends here as a failed
 * identity check: not as a finished audit, and never to be resumed. The reservation is settled the same
 * way as for any audit that fails: unused research credits go back to the month, and the daily and
 * visitor slots go back too unless a search was already paid for (the existing quota policy; nothing
 * is edited by hand). The visitor is told exactly which happened.
 */
async function stopOnIdentity(meta: JobMeta, reason: string): Promise<void> {
  meta.status = 'identity_failed';
  let slotsReturned = false;
  try {
    const settled = await settleReservation(meta.id, meta.keys, true);
    slotsReturned = settled.slotsReturned;
    await releaseInflight(meta.cacheKey, meta.id);
  } catch (err) {
    logEvent('identity_stop_cleanup_error', { error: safeErrorMessage(err) });
  }
  meta.error = identityStopMessage(reason, slotsReturned);
  logEvent('audit_identity_failed', { stage: STAGE_ORDER[meta.stageIndex]?.id ?? 'unknown', slotsReturned, creditsSpent: meta.creditsSpent });
}

/** An audit in one of these states is over: advancing it again only reports where it ended. */
function isFinished(status: JobMeta['status']): boolean {
  return status === 'complete' || status === 'failed' || status === 'identity_failed';
}

async function failJob(meta: JobMeta, message: string): Promise<void> {
  meta.status = 'failed';
  meta.error = message;
  try {
    // If nothing was spent, the daily and visitor slots go back too. An audit that stopped at its Gemini request
    // limit did spend: it sent up to the limit in Gemini requests, so its slots are not returned (decision Q-B).
    await settleReservation(meta.id, meta.keys, meta.geminiCeilingReached !== true);
    await releaseInflight(meta.cacheKey, meta.id);
  } catch (err) {
    logEvent('fail_cleanup_error', { error: safeErrorMessage(err) });
  }
  logEvent('audit_failed', { stage: STAGE_ORDER[meta.stageIndex]?.id ?? 'unknown' });
}

/** Read-only view of an audit's progress. */
export async function getSnapshot(id: string): Promise<JobSnapshot | null> {
  const job = await loadJob(id);
  return job ? snapshotOf(job.meta) : null;
}

/**
 * Run the next stage of an audit (one stage per request, so the browser can show progress).
 * Returns null if the audit does not exist or has expired.
 */
export async function advanceJob(id: string): Promise<JobSnapshot | null> {
  const first = await loadJob(id);
  if (!first) return null;
  if (isFinished(first.meta.status)) return snapshotOf(first.meta);

  const token = await acquireJobLock(id);
  if (!token) return { ...snapshotOf(first.meta), busy: true };

  try {
    const job = await loadJob(id); // re-read inside the lock
    if (!job) return null;
    const { meta, data } = job;
    if (isFinished(meta.status)) return snapshotOf(meta);

    if (meta.status === 'paused') {
      if (await isGeminiDailyExhausted()) return { ...snapshotOf(meta), waitSeconds: 300, waitReason: meta.pausedReason };
      meta.status = 'running';
      meta.pausedReason = undefined;
    }

    const stage = STAGE_ORDER[meta.stageIndex];
    let extra: Partial<JobSnapshot> = {};
    if (!stage) {
      meta.status = 'complete';
    } else {
      const ctx = createContext(meta, data, Date.now() + STAGE_BUDGET_MS);
      try {
        const outcome = await RUNNERS[stage.id](ctx);
        if (outcome === 'done') {
          meta.stageIndex += 1;
          if (meta.stageIndex >= STAGE_ORDER.length) meta.status = 'complete';
        }
      } catch (err) {
        // The audit store could not approve a Gemini request (nothing was sent or counted). This is not a stage
        // failure: no attempt, error or warning is recorded and the audit is not failed, so it can carry on once
        // the store answers. What this call had already recorded (its earlier requests) is kept if the store
        // allows it; the Redis audit counter stays the durable count either way. The route reports a storage error.
        if (err instanceof StorageSignal) {
          meta.updatedAt = new Date().toISOString();
          try {
            await saveMeta(meta);
          } catch {
            /* the store is unavailable: nothing more can be saved */
          }
          throw err;
        }
        if (err instanceof WaitSignal) {
          extra = { waitSeconds: err.seconds, waitReason: err.reason };
        } else if (err instanceof PauseSignal) {
          meta.status = 'paused';
          meta.pausedReason = `${err.message} This audit keeps its progress: reopen this page after the reset and it will carry on.`;
          extra = { waitSeconds: 300, waitReason: meta.pausedReason };
        } else if (err instanceof StopSignal && err.code === 'identity') {
          await stopOnIdentity(meta, data.identity?.reason ?? err.message);
        } else if (err instanceof StopSignal) {
          await failJob(meta, err.message);
        } else {
          const key = `stage:${stage.id}`;
          meta.attempts[key] = (meta.attempts[key] ?? 0) + 1;
          logEvent('stage_error', { stage: stage.id, attempt: meta.attempts[key], error: safeErrorMessage(err) });
          if (meta.attempts[key] >= MAX_STAGE_ERRORS) {
            await failJob(meta, 'Something went wrong while running this audit, and retrying did not help. Nothing further was charged to the free quotas.');
          } else {
            extra = { waitSeconds: 3, waitReason: 'Retrying after a temporary error' };
          }
        }
      }
    }
    meta.updatedAt = new Date().toISOString();
    await saveMeta(meta);
    return { ...snapshotOf(meta), ...extra };
  } finally {
    // Best effort: if the store is failing, a failed release must not replace the error that is already on its
    // way out (for example a StorageSignal). The lock expires by itself after 100 seconds.
    try {
      await releaseJobLock(id, token);
    } catch {
      logEvent('lock_release_failed', {});
    }
  }
}
