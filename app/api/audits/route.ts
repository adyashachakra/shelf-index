import { startAudit } from '@/lib/audit/pipeline';
import { USER_MESSAGES } from '@/lib/config';
import { logEvent, safeErrorMessage } from '@/lib/log';
import { allowRequest } from '@/lib/throttle';
import type { StartResponse } from '@/lib/types';
import { validateAuditInput } from '@/lib/validation/input';

// POST /api/audits : start an audit (or return a cached report / a running audit for the same brand).

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function json(status: number, body: StartResponse): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return (request.headers.get('x-real-ip') ?? 'unknown').slice(0, 64);
}

export async function POST(request: Request): Promise<Response> {
  // Speed bump before anything touches storage: 6 attempts a minute per connection, 60 in total.
  const ip = clientIp(request);
  if (!allowRequest(`start:${ip}`, 6, 60_000) || !allowRequest('start:all', 60, 60_000)) {
    return json(429, { status: 'error', code: 'too_many_requests', message: USER_MESSAGES.tooManyRequests });
  }
  const length = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(length) && length > 2000) {
    return json(400, { status: 'error', code: 'invalid', message: 'That request is too large.' });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { status: 'error', code: 'invalid', message: 'Enter a brand name and choose a category.' });
  }
  const input = validateAuditInput(body);
  if (!input.ok) return json(400, { status: 'error', code: 'invalid', message: input.message });

  try {
    const result = await startAudit(input.value, ip);
    return json(result.httpStatus, result.body);
  } catch (err) {
    logEvent('start_error', { error: safeErrorMessage(err) });
    return json(503, { status: 'error', code: 'storage', message: USER_MESSAGES.storage });
  }
}
