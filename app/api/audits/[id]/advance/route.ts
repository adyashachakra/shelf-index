import { advanceJob } from '@/lib/audit/pipeline';
import { logEvent, safeErrorMessage } from '@/lib/log';
import { isValidAuditId } from '@/lib/validation/input';

// POST /api/audits/{id}/advance : run the next stage of an audit and report progress.
// The browser calls this repeatedly; each call does one stage and saves it.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!isValidAuditId(id)) return Response.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  try {
    const snapshot = await advanceJob(id);
    if (!snapshot) {
      return Response.json({ error: 'This audit was not found or has expired.' }, { status: 404, headers: NO_STORE });
    }
    return Response.json(snapshot, { headers: NO_STORE });
  } catch (err) {
    logEvent('advance_error', { error: safeErrorMessage(err) });
    return Response.json({ error: 'The audit store is not reachable right now.' }, { status: 503, headers: NO_STORE });
  }
}
