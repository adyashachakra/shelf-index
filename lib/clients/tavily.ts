import 'server-only';
import { config } from '../config';
import { isTimeoutError, logEvent } from '../log';

// Tavily Search client (plain HTTPS). Always "basic" depth = 1 credit per search.
// auto_parameters stays off because it can upgrade a search to the 2-credit depth.

const ENDPOINT = 'https://api.tavily.com/search';

export type TavilyErrorKind =
  | 'quota' // plan or key limit reached (HTTP 432/433)
  | 'rate_limit'
  | 'auth'
  | 'bad_request'
  | 'unavailable'
  | 'timeout'
  | 'network';

export class TavilyError extends Error {
  kind: TavilyErrorKind;
  /** True when the request was rejected before any credit could have been charged. */
  notCharged: boolean;
  constructor(kind: TavilyErrorKind, message: string, notCharged: boolean) {
    super(message);
    this.name = 'TavilyError';
    this.kind = kind;
    this.notCharged = notCharged;
  }
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  rawContent: string | null;
  score: number;
}

export interface TavilySearchResult {
  results: TavilyResult[];
  /** Credits Tavily reports for this request, when it reports them. */
  creditsCharged: number | null;
}

export interface TavilySearchParams {
  query: string;
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  rawContent?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(body: Record<string, unknown>, apiKey: string): Promise<{ res: Response; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (err) {
    // A timeout may or may not have been charged: treat it as charged.
    if (isTimeoutError(err)) throw new TavilyError('timeout', 'Tavily search timed out', false);
    throw new TavilyError('network', 'Could not reach Tavily', false);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

export async function tavilySearch(params: TavilySearchParams): Promise<TavilySearchResult> {
  const apiKey = config.tavilyApiKey();
  if (!apiKey) throw new TavilyError('auth', 'TAVILY_API_KEY is not set', true);

  const base: Record<string, unknown> = {
    query: params.query.slice(0, 380),
    search_depth: 'basic',
    max_results: Math.max(1, Math.min(20, params.maxResults)),
    include_answer: false,
    include_raw_content: params.rawContent ? 'markdown' : false,
  };
  if (params.includeDomains && params.includeDomains.length > 0) base.include_domains = params.includeDomains;
  if (params.excludeDomains && params.excludeDomains.length > 0) base.exclude_domains = params.excludeDomains;

  const full = { ...base, topic: 'general', chunks_per_source: 3, include_images: false, include_usage: true, auto_parameters: false };

  const started = Date.now();
  let { res, json } = await request(full, apiKey);
  if (res.status === 400 || res.status === 422) {
    // An optional field was not accepted: retry once with only the core fields. Rejected requests are not charged.
    ({ res, json } = await request(base, apiKey));
  }

  if (!res.ok) {
    let error: TavilyError;
    if (res.status === 432 || res.status === 433) error = new TavilyError('quota', "Tavily's free credit limit has been reached", true);
    else if (res.status === 429) error = new TavilyError('rate_limit', 'Tavily rate limit reached', true);
    else if (res.status === 401 || res.status === 403) error = new TavilyError('auth', 'The Tavily API key was rejected', true);
    else if (res.status === 400 || res.status === 422) error = new TavilyError('bad_request', 'Tavily rejected the search request', true);
    else error = new TavilyError('unavailable', `Tavily returned HTTP ${res.status}`, false);
    logEvent('tavily_error', { kind: error.kind, status: res.status, ms: Date.now() - started });
    throw error;
  }

  const rawResults = isRecord(json) && Array.isArray(json.results) ? json.results : [];
  const results: TavilyResult[] = [];
  for (const entry of rawResults) {
    if (!isRecord(entry) || typeof entry.url !== 'string') continue;
    results.push({
      title: typeof entry.title === 'string' ? entry.title : '',
      url: entry.url,
      content: typeof entry.content === 'string' ? entry.content : '',
      rawContent: typeof entry.raw_content === 'string' ? entry.raw_content : null,
      score: typeof entry.score === 'number' ? entry.score : 0,
    });
  }
  let creditsCharged: number | null = null;
  if (isRecord(json) && isRecord(json.usage) && typeof json.usage.credits === 'number') {
    creditsCharged = json.usage.credits;
  }
  logEvent('tavily_ok', { results: results.length, credits: creditsCharged ?? -1, ms: Date.now() - started });
  return { results, creditsCharged };
}
