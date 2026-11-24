import 'server-only';
import { cmd, evalScript, getNumber, hgetall } from '../clients/redis';
import { config, RESERVATION_MAX_AGE_MS, TIER_CREDITS, TIER_ORDER } from '../config';
import { logEvent, safeErrorMessage } from '../log';
import { envKeys, sharedKeys } from '../cache/keys';
import type { Tier } from '../types';
import { dayKey, daysLeftInMonth, monthKey } from './dates';
import {
  OVERAGE_SCRIPT,
  RESERVE_SCRIPT,
  SETTLE_SCRIPT,
  SPEND_SCRIPT,
  UNSPEND_SCRIPT,
} from './scripts';

// The reservation, the sweep list and the daily and per-visitor audit slots are environment-scoped; the Tavily
// month counter is shared, because Preview and Production spend the same Tavily account (lib/cache/keys.ts).
const activeSet = (): string => envKeys.reservationsActive();
const DAY_TTL_SECONDS = 3 * 24 * 60 * 60;
const MONTH_TTL_SECONDS = 70 * 24 * 60 * 60;
const RESERVATION_TTL_SECONDS = 45 * 24 * 60 * 60;

export interface ReservationKeys {
  day: string;
  visitor: string;
  month: string;
  resv: string;
}

export function reservationKey(jobId: string): string {
  return envKeys.reservation(jobId);
}

export function currentQuotaKeys(visitorHash: string, jobId: string, now: Date = new Date()): ReservationKeys {
  const tz = config.quotaTimezone();
  const day = dayKey(tz, now);
  return {
    day: envKeys.auditDay(day),
    visitor: envKeys.visitor(day, visitorHash),
    month: sharedKeys.tavilyMonth(monthKey(tz, now)),
    resv: reservationKey(jobId),
  };
}

/**
 * Credit-aware depth selection. Spreads what is left of the monthly budget over the audits
 * that could still run this month, and only offers the depths that fit that pace.
 */
export function allowedTiers(creditsUsed: number, now: Date = new Date()): Tier[] {
  const ceiling = config.tavilyMonthlyCeiling();
  const remaining = Math.max(0, ceiling - creditsUsed);
  const auditsLeft = Math.max(1, daysLeftInMonth(config.quotaTimezone(), now) * Math.max(1, config.dailyScanLimit()));
  const perAudit = Math.floor(remaining / auditsLeft);
  const tiers = TIER_ORDER.filter((tier) => TIER_CREDITS[tier] <= perAudit);
  // Near the end of the budget the pace can drop below the smallest depth; the atomic
  // script still refuses anything that would cross the ceiling.
  return tiers.length > 0 ? tiers : ['minimal'];
}

export type ReserveOutcome =
  | { ok: true; tier: Tier; credits: number; keys: ReservationKeys }
  | { ok: false; reason: 'daily' | 'visitor' | 'monthly' | 'duplicate' };

/** Atomically claim a daily slot, a visitor slot and the audit's Tavily credits. */
export async function reserveAudit(jobId: string, visitorHash: string, now: Date = new Date()): Promise<ReserveOutcome> {
  const keys = currentQuotaKeys(visitorHash, jobId, now);
  const used = await getNumber(keys.month);
  const tiers = allowedTiers(used, now);
  const result = await evalScript<[number, string, number, number]>(
    RESERVE_SCRIPT,
    [keys.day, keys.visitor, keys.month, keys.resv, activeSet()],
    [
      config.dailyScanLimit(),
      config.perVisitorDailyLimit(),
      config.tavilyMonthlyCeiling(),
      DAY_TTL_SECONDS,
      MONTH_TTL_SECONDS,
      RESERVATION_TTL_SECONDS,
      now.getTime(),
      jobId,
      ...tiers.map((tier) => TIER_CREDITS[tier]),
    ],
  );
  if (Number(result[0]) === 1) {
    const tier = tiers[Number(result[2])] ?? 'minimal';
    return { ok: true, tier, credits: Number(result[3]), keys };
  }
  const reason = String(result[1]);
  if (reason === 'daily' || reason === 'visitor' || reason === 'monthly' || reason === 'duplicate') {
    return { ok: false, reason };
  }
  return { ok: false, reason: 'monthly' };
}

/** Take credits from an audit's reservation before a search. False means the search must not run. */
export async function spendCredits(jobId: string, credits: number): Promise<boolean> {
  const result = await evalScript<[number, string, number]>(SPEND_SCRIPT, [reservationKey(jobId)], [credits]);
  return Number(result[0]) === 1;
}

/** Return credits for a search that was rejected before the provider charged for it. */
export async function unspendCredits(jobId: string, credits: number): Promise<void> {
  await evalScript<number>(UNSPEND_SCRIPT, [reservationKey(jobId)], [credits]);
}

/** Record that the provider charged more than planned for a search. */
export async function recordOverage(jobId: string, monthCounterKey: string, extra: number): Promise<void> {
  if (extra <= 0) return;
  await evalScript<number>(OVERAGE_SCRIPT, [reservationKey(jobId), monthCounterKey], [extra]);
}

export interface SettleResult {
  settled: boolean;
  creditsReturned: number;
  slotsReturned: boolean;
}

/** Close a reservation once. Safe to call more than once. */
export async function settleReservation(
  jobId: string,
  keys: ReservationKeys,
  refundSlotsIfUnspent: boolean,
): Promise<SettleResult> {
  const result = await evalScript<[number, number, number]>(
    SETTLE_SCRIPT,
    [keys.resv, keys.month, keys.day, keys.visitor, activeSet()],
    [refundSlotsIfUnspent ? '1' : '0', jobId],
  );
  return {
    settled: Number(result[0]) === 1,
    creditsReturned: Number(result[1]),
    slotsReturned: Number(result[2]) === 1,
  };
}

export async function reservationState(jobId: string): Promise<{ reserved: number; spent: number; state: string } | null> {
  const fields = await hgetall(reservationKey(jobId));
  if (!fields.state) return null;
  return {
    reserved: Number.parseInt(fields.reserved ?? '0', 10) || 0,
    spent: Number.parseInt(fields.spent ?? '0', 10) || 0,
    state: fields.state,
  };
}

/**
 * Settle reservations left behind by audits that were abandoned (tab closed, never resumed).
 * Their unused credits go back to the month. Runs opportunistically before new audits start.
 */
export async function sweepStaleReservations(now: Date = new Date()): Promise<number> {
  let swept = 0;
  try {
    const cutoff = now.getTime() - RESERVATION_MAX_AGE_MS;
    const stale = await cmd<string[]>('ZRANGEBYSCORE', activeSet(), '-inf', cutoff, 'LIMIT', 0, 10);
    for (const jobId of stale ?? []) {
      const fields = await hgetall(reservationKey(jobId));
      if (!fields.k_month || !fields.k_day || !fields.k_visitor) {
        await cmd('ZREM', activeSet(), jobId);
        continue;
      }
      await settleReservation(
        jobId,
        { resv: reservationKey(jobId), month: fields.k_month, day: fields.k_day, visitor: fields.k_visitor },
        false,
      );
      swept += 1;
    }
  } catch (err) {
    logEvent('reservation_sweep_failed', { error: safeErrorMessage(err) });
  }
  return swept;
}

export interface QuotaSnapshot {
  scansToday: number;
  scanLimit: number;
  creditsThisMonth: number;
  creditCeiling: number;
}

export async function quotaSnapshot(now: Date = new Date()): Promise<QuotaSnapshot> {
  const tz = config.quotaTimezone();
  const [scansToday, creditsThisMonth] = await Promise.all([
    getNumber(envKeys.auditDay(dayKey(tz, now))),
    getNumber(sharedKeys.tavilyMonth(monthKey(tz, now))),
  ]);
  return {
    scansToday,
    scanLimit: config.dailyScanLimit(),
    creditsThisMonth,
    creditCeiling: config.tavilyMonthlyCeiling(),
  };
}
