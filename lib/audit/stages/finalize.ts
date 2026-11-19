import 'server-only';
import { releaseInflight } from '../../cache/jobs';
import { saveReport } from '../../cache/reports';
import { logEvent } from '../../log';
import { geminiRequestsForAudit } from '../../quota/gemini-limiter';
import { settleReservation } from '../../quota/reservations';
import { buildReport } from '../../report/build';
import type { StageContext } from '../context';

/**
 * Stage 11: calculate the scores, assemble the report, cache it for 7 days (unless the audit stopped at its
 * Gemini request limit), and close the audit's credit reservation so any credits it did not use go back to the
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
  // An audit that stopped at its Gemini request limit is a partial result: it is saved under its own id (so the
  // visitor can open it) but NOT as the cached result for the brand, so a later audit of it runs again.
  await saveReport(report, meta.cacheKey, { cache: meta.geminiCeilingReached !== true });
  const settled = await settleReservation(meta.id, meta.keys, false);
  await releaseInflight(meta.cacheKey, meta.id);
  ctx.note('finalize', 'Report ready');
  logEvent('audit_complete', {
    tier: meta.tier,
    creditsSpent: meta.creditsSpent,
    creditsReturned: settled.creditsReturned,
    geminiRequests: meta.geminiRequests,
    geminiCeilingReached: meta.geminiCeilingReached === true,
    warnings: meta.warnings.length,
  });
  return 'done';
}
