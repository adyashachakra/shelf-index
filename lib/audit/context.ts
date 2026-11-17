import 'server-only';
import { cmd, getString } from '../clients/redis';
import { GeminiError, generateJson, type GenerateOptions, type GenerateResult } from '../clients/gemini';
import { TavilyError, tavilySearch, type TavilyResult, type TavilySearchParams } from '../clients/tavily';
import { config, USER_MESSAGES } from '../config';
import { saveSection } from '../cache/jobs';
import { logEvent } from '../log';
import { monthKey } from '../quota/dates';
import { acquireGeminiSlot, markGeminiDailyExhausted, noteGeminiCooldown } from '../quota/gemini-limiter';
import { recordOverage, spendCredits, unspendCredits } from '../quota/reservations';
import type { SearchLogEntry } from '../types';
import type { JobData, JobMeta, SectionName, StageId } from './job';

// Signals a stage can raise to hand control back to the browser.

/** "Not yet": ask the browser to call again after a short wait (rate limits, transient errors). */
export class WaitSignal extends Error {
  seconds: number;
  reason: string;
  constructor(seconds: number, reason: string) {
    super(reason);
    this.name = 'WaitSignal';
    this.seconds = seconds;
    this.reason = reason;
  }
}

/** Gemini's free daily quota is used up: the audit keeps its progress and resumes after the reset. */
export class PauseSignal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PauseSignal';
  }
}

/** The audit cannot continue. The message is shown to the visitor. */
export class StopSignal extends Error {
  code: 'setup' | 'monthly' | 'no_answers' | 'error' | 'identity';
  constructor(code: 'setup' | 'monthly' | 'no_answers' | 'error' | 'identity', message: string) {
    super(message);
    this.name = 'StopSignal';
    this.code = code;
  }
}

export const MAX_STEP_ATTEMPTS = 3;

function tavilyExhaustedKey(now: Date = new Date()): string {
  return `si:tavily:exhausted:${monthKey(config.quotaTimezone(), now)}`;
}
export async function markTavilyExhausted(): Promise<void> {
  await cmd('SET', tavilyExhaustedKey(), '1', 'EX', 35 * 24 * 60 * 60);
}
export async function isTavilyExhausted(): Promise<boolean> {
  return (await getString(tavilyExhaustedKey())) !== null;
}

export interface SearchOutcome {
  results: TavilyResult[];
  /** The methodology log entry for this search; stages fill in how many results they kept. */
  entry: SearchLogEntry;
}

export interface StageContext {
  meta: JobMeta;
  data: JobData;
  timeLeft(): number;
  /** Persist one finished step. */
  save<K extends SectionName>(section: K, value: JobData[K] | null): Promise<void>;
  note(stage: StageId, text: string): void;
  warn(text: string): void;
  /**
   * One Gemini request with pacing and error handling. Returns null when the step failed
   * MAX_STEP_ATTEMPTS times (the caller then degrades gracefully). Throws WaitSignal,
   * PauseSignal or StopSignal for rate limits, daily quota and setup problems.
   */
  gemini<T>(options: GenerateOptions<T>, stepKey: string): Promise<GenerateResult<T> | null>;
  /**
   * One Tavily search, paid for from this audit's reservation. Returns null when the search is
   * unavailable or the audit's credit allowance is used (the caller continues without it).
   */
  search(purpose: string, scope: string, params: TavilySearchParams): Promise<SearchOutcome | null>;
}

export function createContext(meta: JobMeta, data: JobData, deadline: number): StageContext {
  return {
    meta,
    data,
    timeLeft: () => deadline - Date.now(),

    async save(section, value) {
      (data as Record<string, unknown>)[section] = value;
      await saveSection(meta.id, section, value);
    },

    note(stage, text) {
      meta.notes[stage] = text;
    },

    warn(text) {
      if (!meta.warnings.includes(text)) meta.warnings.push(text);
    },

    async gemini(options, stepKey) {
      const attempts = meta.attempts[stepKey] ?? 0;
      if (attempts >= MAX_STEP_ATTEMPTS) return null;

      const slot = await acquireGeminiSlot();
      if (!slot.ok) {
        if (slot.kind === 'daily') throw new PauseSignal(USER_MESSAGES.geminiDaily);
        throw new WaitSignal(slot.seconds, slot.reason);
      }
      meta.geminiRequests += 1;

      try {
        return await generateJson(options);
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        switch (err.kind) {
          case 'rate_limit': {
            const seconds = Math.min(90, Math.ceil(err.retryAfterSeconds ?? 20));
            await noteGeminiCooldown(seconds);
            throw new WaitSignal(seconds, 'Gemini asked us to slow down');
          }
          case 'daily_quota':
            await markGeminiDailyExhausted();
            throw new PauseSignal(USER_MESSAGES.geminiDaily);
          case 'auth':
          case 'model_not_found':
          case 'bad_request':
            logEvent('gemini_setup_problem', { kind: err.kind, step: stepKey });
            throw new StopSignal('setup', `${USER_MESSAGES.setup} (Gemini: ${err.message}.)`);
          case 'blocked':
            meta.attempts[stepKey] = MAX_STEP_ATTEMPTS;
            return null;
          default: {
            // unavailable, timeout, network, invalid_output: retry on the next call, up to the limit
            meta.attempts[stepKey] = attempts + 1;
            if (attempts + 1 >= MAX_STEP_ATTEMPTS) return null;
            throw new WaitSignal(err.kind === 'unavailable' ? 8 : 2, 'Retrying a Gemini request');
          }
        }
      }
    },

    async search(purpose, scope, params) {
      const entry: SearchLogEntry = { purpose, query: params.query, scope, results: 0, kept: 0, credits: 0, ok: false };
      const reserved = await spendCredits(meta.id, 1);
      if (!reserved) {
        entry.note = "Skipped: this audit's credit allowance was already used.";
        meta.searches.push(entry);
        return null;
      }
      try {
        const { results, creditsCharged } = await tavilySearch(params);
        const charged = creditsCharged !== null && creditsCharged > 0 ? creditsCharged : 1;
        if (charged > 1) await recordOverage(meta.id, meta.keys.month, charged - 1);
        meta.creditsSpent += charged;
        entry.results = results.length;
        entry.credits = charged;
        entry.ok = true;
        meta.searches.push(entry);
        return { results, entry };
      } catch (err) {
        if (!(err instanceof TavilyError)) throw err;
        if (err.notCharged) {
          await unspendCredits(meta.id, 1);
        } else {
          meta.creditsSpent += 1;
          entry.credits = 1;
        }
        entry.note = err.message;
        meta.searches.push(entry);
        if (err.kind === 'quota') {
          await markTavilyExhausted();
          throw new StopSignal('monthly', USER_MESSAGES.monthlyLimit);
        }
        if (err.kind === 'auth') throw new StopSignal('setup', `${USER_MESSAGES.setup} (Tavily: ${err.message}.)`);
        return null;
      }
    },
  };
}
