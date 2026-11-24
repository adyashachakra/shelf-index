import { getSnapshot } from '@/lib/audit/pipeline';
import { KeyNamespaceError } from '@/lib/cache/keys';
import { loadReport } from '@/lib/cache/reports';
import { USER_MESSAGES } from '@/lib/config';
import { logEvent, safeErrorMessage } from '@/lib/log';
import { isValidAuditId } from '@/lib/validation/input';

// GET /api/audits/{id} : the finished report as JSON, or the audit's current progress.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!isValidAuditId(id)) return Response.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  try {
    const report = await loadReport(id);
    if (report) return Response.json({ status: 'complete', report }, { headers: NO_STORE });
    const snapshot = await getSnapshot(id);
    if (!snapshot) return Response.json({ error: 'This audit was not found or has expired.' }, { status: 404, headers: NO_STORE });
    return Response.json(snapshot, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof KeyNamespaceError) {
      logEvent('status_blocked_setup', { missing: 'SI_KEY_NAMESPACE (invalid)' });
      return Response.json({ error: USER_MESSAGES.keyNamespace }, { status: 503, headers: NO_STORE });
    }
    logEvent('status_error', { error: safeErrorMessage(err) });
    return Response.json({ error: 'The audit store is not reachable right now.' }, { status: 503, headers: NO_STORE });
  }
}
