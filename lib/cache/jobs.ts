import 'server-only';
import { cmd, del, getString, hgetall, hset, setIfAbsent } from '../clients/redis';
import { INFLIGHT_TTL_SECONDS, JOB_TTL_SECONDS } from '../config';
import type { JobData, JobMeta, SectionName } from '../audit/job';

// Audit state lives in one Redis hash per audit: a small "meta" field plus one field per
// finished step. Steps are written once, so a retry or refresh never repeats paid work.

const SECTIONS: SectionName[] = [
  'questions',
  'answers',
  'profile',
  'identity',
  'audience',
  'youtube',
  'labels',
  'site',
  'siteAnalysis',
  'signature',
  'claims',
  'competitors',
  'synthesis',
];

function jobKey(id: string): string {
  return `si:job:${id}`;
}
function lockKey(id: string): string {
  return `si:lock:${id}`;
}
function inflightKey(cacheKey: string): string {
  return `si:inflight:${cacheKey}`;
}

export function newAuditId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createJob(meta: JobMeta): Promise<void> {
  await hset(jobKey(meta.id), { meta: JSON.stringify(meta) }, JOB_TTL_SECONDS);
}

export async function loadJob(id: string): Promise<{ meta: JobMeta; data: JobData } | null> {
  const fields = await hgetall(jobKey(id));
  if (!fields.meta) return null;
  let meta: JobMeta;
  try {
    meta = JSON.parse(fields.meta) as JobMeta;
  } catch {
    return null;
  }
  const data: Record<string, unknown> = {};
  for (const section of SECTIONS) {
    const raw = fields[section];
    if (raw === undefined) continue;
    try {
      data[section] = JSON.parse(raw);
    } catch {
      /* an unreadable section is treated as not done */
    }
  }
  return { meta, data: data as JobData };
}

export async function saveMeta(meta: JobMeta): Promise<void> {
  await hset(jobKey(meta.id), { meta: JSON.stringify(meta) }, JOB_TTL_SECONDS);
}

export async function saveSection(id: string, section: SectionName, value: unknown): Promise<void> {
  await hset(jobKey(id), { [section]: JSON.stringify(value) });
}

/** Only one request may advance an audit at a time. Returns a token, or null if it is already being advanced. */
export async function acquireJobLock(id: string): Promise<string | null> {
  const token = newAuditId();
  const acquired = await setIfAbsent(lockKey(id), token, 100);
  return acquired ? token : null;
}

export async function releaseJobLock(id: string, token: string): Promise<void> {
  const current = await getString(lockKey(id));
  if (current === token) await del(lockKey(id));
}

/**
 * Duplicate prevention: one audit per brand + category at a time.
 * Returns the id that owns the slot (ours if we claimed it, otherwise the audit already running).
 */
export async function claimInflight(cacheKey: string, id: string): Promise<string> {
  const claimed = await setIfAbsent(inflightKey(cacheKey), id, INFLIGHT_TTL_SECONDS);
  if (claimed) return id;
  return (await getString(inflightKey(cacheKey))) ?? id;
}

export async function getInflight(cacheKey: string): Promise<string | null> {
  return getString(inflightKey(cacheKey));
}

export async function releaseInflight(cacheKey: string, id: string): Promise<void> {
  const current = await getString(inflightKey(cacheKey));
  if (current === id) await del(inflightKey(cacheKey));
}

export async function forceReleaseInflight(cacheKey: string): Promise<void> {
  await cmd('DEL', inflightKey(cacheKey));
}
