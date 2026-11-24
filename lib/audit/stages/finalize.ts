import 'server-only';
import { releaseInflight } from '../../cache/jobs';
import { saveReport } from '../../cache/reports';
import { logEvent } from '../../log';
import { geminiRequestsForAudit } from '../../quota/gemini-limiter';
import { settleReservation } from '../../quota/reservations';
import { buildReport } from '../../report/build';
import type { Report } from '../../types';
import type { JobMeta } from '../job';
import type { StageContext } from '../context';

/**
 * Gemini steps that may fail without keeping the report out of the brand cache. Each feeds only supplementary content
 * (never one of the three scores, the identity check or visibility's product-range exclusions), and each leaves a
 * visible note in the report when it fails. Any step NOT listed here blocks caching when it fails, so a step added
 * later is treated as essential until someone decides otherwise.
 */
export const SUPPORTING_GEMINI_STEPS: ReadonlySet<string> = new Set([
  'competitors', // competitor sentiment column only
  'synthesis', // written comparison points in "The disconnect"; the scores and the gap are computed in code
  'fixes', // the fix list
  'claims', // checking Gemini's statements against sources
  'signature', // one "between the lines" check
  'questions', // question writing for a custom category; template questions are used instead
]);

/**
 * Why this audit's report must not become the reusable cached result for its brand and category, or an empty list
 * when it may. A degraded report is still saved under its own id (its link keeps working for the usual time); it is
 * only kept out of the brand cache, so the next request for the brand runs a fresh audit instead of being served it.
 *  - the audit stopped at its Gemini request limit;
 *  - a Gemini step that is not in SUPPORTING_GEMINI_STEPS gave no usable answer after its retries (in practice
 *    profile, perception or site_analysis, or any step added later);
 *  - a shopper question failing on its own does not count (visibility is still measured from the others, and its
 *    confidence says how many were counted) unless so many failed that visibility could not be measured at all.
 */
export function cacheBlockers(meta: Pick<JobMeta, 'geminiCeilingReached' | 'geminiStepsFailed'>, report: Pick<Report, 'visibility'>): string[] {
  const blockers: string[] = [];
  if (meta.geminiCeilingReached) blockers.push('gemini_ceiling');
  const failed = meta.geminiStepsFailed ?? [];
  for (const step of failed) {
    if (step.startsWith('ask:') || SUPPORTING_GEMINI_STEPS.has(step)) continue;
    blockers.push(`gemini_step:${step}`);
  }
  if (failed.some((step) => step.startsWith('ask:')) && report.visibility.metric.status !== 'scored') blockers.push('gemini_questions');
  return blockers;
}

/**
 * Stage 11: calculate the scores, assemble the report, cache it for 7 days (unless it is a degraded result: see
 * cacheBlockers), and close the audit's credit reservation so any credits it did not use go back to the
 * monthly budget.
 */
export async function runFinalize(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta, data } = ctx;
  // The Redis audit counter is the durable count of requests sent; the saved value can lag after an interruption.
  try {
    meta.geminiRequests = Math.max(meta.geminiRequests, await geminiRequestsForAudit(meta.id));
  } catch {
    logEvent('gemini_count_reconcile_failed', {});
  }
  const report = buildReport(meta, data);
  // A partial result (the Gemini request limit, or an essential Gemini step that failed) is saved under its own id, so the
  // visitor can open it, but NOT as the cached result for the brand, so a later audit of it runs again. Writing no
  // pointer also means it can never replace a pointer to an earlier complete report.
  const blockers = cacheBlockers(meta, report);
  await saveReport(report, meta.cacheKey, { cache: blockers.length === 0 });
  const settled = await settleReservation(meta.id, meta.keys, false);
  await releaseInflight(meta.cacheKey, meta.id);
  ctx.note('finalize', 'Report ready');
  logEvent('audit_complete', {
    tier: meta.tier,
    creditsSpent: meta.creditsSpent,
    creditsReturned: settled.creditsReturned,
    geminiRequests: meta.geminiRequests,
    geminiCeilingReached: meta.geminiCeilingReached === true,
    cached: blockers.length === 0,
    notCachedBecause: blockers.join(',').slice(0, 200),
    warnings: meta.warnings.length,
  });
  return 'done';
}
