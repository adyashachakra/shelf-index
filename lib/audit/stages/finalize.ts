import 'server-only';
import { releaseInflight } from '../../cache/jobs';
import { saveReport } from '../../cache/reports';
import { logEvent } from '../../log';
import { geminiRequestsForAudit } from '../../quota/gemini-limiter';
import { settleReservation } from '../../quota/reservations';
import { buildReport } from '../../report/build';
import type { StageContext } from '../context';

/**
 * Stage 11: calculate the scores, assemble the report, cache it for 7 days, and close the
 * audit's credit reservation so any credits it did not use go back to the monthly budget.
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
  await saveReport(report, meta.cacheKey);
  const settled = await settleReservation(meta.id, meta.keys, false);
  await releaseInflight(meta.cacheKey, meta.id);
  ctx.note('finalize', 'Report ready');
  logEvent('audit_complete', {
    tier: meta.tier,
    creditsSpent: meta.creditsSpent,
    creditsReturned: settled.creditsReturned,
    geminiRequests: meta.geminiRequests,
    warnings: meta.warnings.length,
  });
  return 'done';
}
