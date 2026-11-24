import 'server-only';
import { cmd, getJson, getString, pipeline } from '../clients/redis';
import { config, READABLE_REPORT_VERSIONS, REPORT_FORMAT_VERSION } from '../config';
import type { Report } from '../types';
import { envKeys, keyNamespace, legacyReportKey } from './keys';

// Finished reports are kept for CACHE_DAYS (default 7) under their id, with a pointer from the
// normalized brand + category so a repeat request is served from the cache at zero API cost.
// Both keys are environment-scoped (lib/cache/keys.ts).

function reportKey(id: string, version: number = REPORT_FORMAT_VERSION): string {
  return envKeys.report(version, id);
}
function pointerKey(cacheKey: string): string {
  return envKeys.cachePointer(REPORT_FORMAT_VERSION, cacheKey);
}

/**
 * Save a finished report under its id. By default the brand + category pointer is written too, so a repeat
 * request is served from the cache. With `{ cache: false }` only the report itself is saved (same expiry, so
 * the visitor can still open the link) and NO pointer is written: a later audit of the same brand and category
 * is not served this report and can run again. Used for audits that stopped at their Gemini request limit.
 */
export async function saveReport(report: Report, cacheKey: string, options: { cache?: boolean } = {}): Promise<void> {
  const ttl = config.cacheDays() * 24 * 60 * 60;
  const commands: (string | number)[][] = [['SET', reportKey(report.id), JSON.stringify(report), 'EX', ttl]];
  if (options.cache !== false) commands.push(['SET', pointerKey(cacheKey), report.id, 'EX', ttl]);
  await pipeline(commands);
}

/**
 * The newest saved format first; an older readable format is used only when the id is not found there.
 *
 * In a namespaced environment (Preview), a report saved before the namespace was set, under its old unnamespaced
 * key, can still be OPENED by its id, so earlier report links keep working. This fallback is read-only and only for
 * a report body looked up by its own random id: cache pointers, audits, locks, slots and reservations never fall
 * back, so no brand cache, running audit or limit crosses between environments. Production (no namespace) has no
 * fallback: its keys already are the old names, and it never reads a namespaced key.
 */
export async function loadReport(id: string): Promise<Report | null> {
  for (const version of READABLE_REPORT_VERSIONS) {
    const report = await getJson<Report>(reportKey(id, version));
    if (report) return report;
  }
  if (keyNamespace() !== '') {
    for (const version of READABLE_REPORT_VERSIONS) {
      const report = await getJson<Report>(legacyReportKey(version, id));
      if (report) return report;
    }
  }
  return null;
}

/** Id of a cached report for this brand + category, if one exists and is still stored. */
export async function findCachedReportId(cacheKey: string): Promise<string | null> {
  const id = await getString(pointerKey(cacheKey));
  if (!id) return null;
  // Only a report in the current format is offered to a new audit, so repeat audits use the current rules.
  const exists = await cmd<number>('EXISTS', reportKey(id));
  return Number(exists) === 1 ? id : null;
}
