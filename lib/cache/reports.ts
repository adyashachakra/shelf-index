import 'server-only';
import { cmd, getJson, getString, pipeline } from '../clients/redis';
import { config, REPORT_FORMAT_VERSION } from '../config';
import type { Report } from '../types';

// Finished reports are kept for CACHE_DAYS (default 7) under their id, with a pointer from the
// normalized brand + category so a repeat request is served from the cache at zero API cost.

function reportKey(id: string): string {
  return `si:report:v${REPORT_FORMAT_VERSION}:${id}`;
}
function pointerKey(cacheKey: string): string {
  return `si:cache:v${REPORT_FORMAT_VERSION}:${cacheKey}`;
}

export async function saveReport(report: Report, cacheKey: string): Promise<void> {
  const ttl = config.cacheDays() * 24 * 60 * 60;
  await pipeline([
    ['SET', reportKey(report.id), JSON.stringify(report), 'EX', ttl],
    ['SET', pointerKey(cacheKey), report.id, 'EX', ttl],
  ]);
}

export async function loadReport(id: string): Promise<Report | null> {
  return getJson<Report>(reportKey(id));
}

/** Id of a cached report for this brand + category, if one exists and is still stored. */
export async function findCachedReportId(cacheKey: string): Promise<string | null> {
  const id = await getString(pointerKey(cacheKey));
  if (!id) return null;
  const exists = await cmd<number>('EXISTS', reportKey(id));
  return Number(exists) === 1 ? id : null;
}
