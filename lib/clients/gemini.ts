import 'server-only';
import { config, GEMINI_TIMEOUT_MS } from '../config';
import { isTimeoutError, logEvent } from '../log';

// Gemini Developer API client (plain HTTPS, generateContent endpoint, no SDK).
// The request never includes Search grounding or any other paid tool.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiErrorKind =
  | 'rate_limit' // per-minute limit: wait and retry
  | 'daily_quota' // per-day free quota used up
  | 'unavailable' // 5xx or overloaded
  | 'timeout'
  | 'network'
  | 'auth' // key missing, invalid or not allowed
  | 'model_not_found'
  | 'bad_request'
  | 'blocked' // safety or recitation block
  | 'invalid_output'; // answer was not the JSON we asked for

export class GeminiError extends Error {
  kind: GeminiErrorKind;
  retryAfterSeconds?: number;
  status?: number;
  constructor(kind: GeminiErrorKind, message: string, retryAfterSeconds?: number, status?: number) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

export type JsonSchema = Record<string, unknown>;

// The API has accepted several spellings for "reply in JSON with this schema" over time.
// We start with the current one and step down only if the API rejects a field (HTTP 400),
// remembering what worked. The last step asks for JSON in the prompt alone.
interface Features {
  thinking: boolean;
  format: number;
}
const LAST_FORMAT = 4;
const featureMemory = new Map<string, Features>();

function featuresFor(model: string): Features {
  let f = featureMemory.get(model);
  if (!f) {
    f = { thinking: true, format: 0 };
    featureMemory.set(model, f);
  }
  return f;
}

/** Test helper: forget what was learned about the API's accepted fields. */
export function resetGeminiFeatureMemory(): void {
  featureMemory.clear();
}

function toOpenApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase();
    } else if (key === 'properties' && value !== null && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) props[name] = toOpenApiSchema(sub);
      out[key] = props;
    } else if (key === 'items') {
      out[key] = toOpenApiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildBody(system: string, user: string, schema: JsonSchema, f: Features): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (f.thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  if (f.format === 0) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = schema;
  } else if (f.format === 1) {
    generationConfig.responseFormat = { text: { mimeType: 'APPLICATION_JSON', schema } };
  } else if (f.format === 2) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toOpenApiSchema(schema);
  } else if (f.format === 3) {
    generationConfig.responseMimeType = 'application/json';
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
  };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function downgrade(f: Features, message: string): boolean {
  const m = message.toLowerCase();
  const aboutThinking = m.includes('thinking');
  const aboutFormat = /(response_?json_?schema|response_?format|response_?schema|response_?mime|mime_?type|schema)/.test(m);
  if (aboutThinking && f.thinking) {
    f.thinking = false;
    return true;
  }
  if (aboutFormat && f.format < LAST_FORMAT) {
    f.format += 1;
    return true;
  }
  if (f.thinking) {
    f.thinking = false;
    return true;
  }
  if (f.format < LAST_FORMAT) {
    f.format += 1;
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorInfo(json: unknown): { message: string; status: string; raw: string } {
  if (isRecord(json) && isRecord(json.error)) {
    const e = json.error;
    return {
      message: typeof e.message === 'string' ? e.message : '',
      status: typeof e.status === 'string' ? e.status : '',
      raw: JSON.stringify(e).slice(0, 4000),
    };
  }
  return { message: '', status: '', raw: '' };
}

function retryAfterSeconds(json: unknown, res: Response, message: string): number | undefined {
  if (isRecord(json) && isRecord(json.error) && Array.isArray(json.error.details)) {
    for (const detail of json.error.details) {
      if (isRecord(detail) && typeof detail.retryDelay === 'string') {
        const n = Number.parseFloat(detail.retryDelay);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  const inMessage = /retry in ([\d.]+)\s*s/i.exec(message);
  if (inMessage) {
    const n = Number.parseFloat(inMessage[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const header = Number.parseFloat(res.headers.get('retry-after') ?? '');
  return Number.isFinite(header) && header > 0 ? header : undefined;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* try the next form */
  }
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    /* try the next form */
  }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new GeminiError('invalid_output', 'Gemini returned text that is not valid JSON');
}

function readText(json: unknown): string {
  if (!isRecord(json)) throw new GeminiError('invalid_output', 'Gemini returned an empty response');
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = candidates[0];
  if (!isRecord(first)) {
    const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : null;
    if (feedback && typeof feedback.blockReason === 'string') {
      throw new GeminiError('blocked', `Gemini declined the prompt (${feedback.blockReason})`);
    }
    throw new GeminiError('invalid_output', 'Gemini returned no answer');
  }
  const finish = typeof first.finishReason === 'string' ? first.finishReason : '';
  if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finish)) {
    throw new GeminiError('blocked', `Gemini stopped the answer (${finish})`);
  }
  const content = isRecord(first.content) ? first.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('');
  if (text.trim() === '') {
    throw new GeminiError('invalid_output', finish ? `Gemini returned no text (${finish})` : 'Gemini returned no text');
  }
  return text;
}

/** What happened to one outbound request. Every request that is sent ends in exactly one of these. */
export type RequestOutcome =
  | 'ok'
  | 'unusable' // answered, but the text was empty or not the JSON we asked for
  | 'blocked' // safety or recitation block
  | 'http_400'
  | 'http_429'
  | 'http_5xx'
  | 'http_other'
  | 'timeout'
  | 'network';

/**
 * The only way a request leaves this module. `beforeRequest` runs immediately before EVERY outbound
 * request (the first try and every retry, including format-downgrade retries after an HTTP 400) and
 * throws to refuse it; a refused request is never sent. `afterRequest` reports what happened.
 */
export interface RequestGate {
  beforeRequest(): Promise<void>;
  afterRequest(outcome: RequestOutcome): void;
}

export interface GenerateOptions<T> {
  /** Short name for logs, e.g. "ask_question". */
  label: string;
  system: string;
  user: string;
  schema: JsonSchema;
  /** Validates and normalises the parsed JSON. Throw to reject it. */
  parse: (value: unknown) => T;
  timeoutMs?: number;
  /** Required: counts and may refuse each outbound request. */
  gate: RequestGate;
}

/** A request description before it is handed to the gate (what prompts build). */
export type GenerateRequest<T> = Omit<GenerateOptions<T>, 'gate'>;

export interface GenerateResult<T> {
  data: T;
  model: string;
}

export async function generateJson<T>(options: GenerateOptions<T>): Promise<GenerateResult<T>> {
  const apiKey = config.geminiApiKey();
  if (!apiKey) throw new GeminiError('auth', 'GEMINI_API_KEY is not set');
  const model = config.geminiModel();
  const f = featuresFor(model);
  const started = Date.now();

  for (let attempt = 0; attempt < 7; attempt += 1) {
    // Outside the try/catch below: a refusal (wait, pause, storage failure) must pass through untouched.
    await options.gate.beforeRequest();
    let res: Response;
    try {
      res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(options.system, options.user, options.schema, f)),
        signal: AbortSignal.timeout(options.timeoutMs ?? GEMINI_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      const kind: GeminiErrorKind = isTimeoutError(err) ? 'timeout' : 'network';
      options.gate.afterRequest(kind);
      logEvent('gemini_error', { label: options.label, kind, ms: Date.now() - started });
      throw new GeminiError(kind, kind === 'timeout' ? 'Gemini took too long to answer' : 'Could not reach Gemini');
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (res.ok) {
      let text: string;
      try {
        text = readText(json);
      } catch (err) {
        options.gate.afterRequest(err instanceof GeminiError && err.kind === 'blocked' ? 'blocked' : 'unusable');
        throw err;
      }
      let data: T;
      try {
        data = options.parse(extractJson(text));
      } catch (err) {
        options.gate.afterRequest('unusable');
        if (err instanceof GeminiError) throw err;
        logEvent('gemini_error', { label: options.label, kind: 'invalid_output', ms: Date.now() - started });
        throw new GeminiError('invalid_output', 'Gemini answered in an unexpected shape');
      }
      options.gate.afterRequest('ok');
      logEvent('gemini_ok', { label: options.label, model, ms: Date.now() - started, format: f.format });
      const reported = isRecord(json) && typeof json.modelVersion === 'string' ? json.modelVersion : model;
      return { data, model: reported };
    }

    const info = errorInfo(json);
    const lower = `${info.message} ${info.status}`.toLowerCase();

    if (res.status === 400) {
      options.gate.afterRequest('http_400');
      if (lower.includes('api key')) throw new GeminiError('auth', 'The Gemini API key was rejected', undefined, 400);
      if (lower.includes('location')) {
        throw new GeminiError('auth', 'The Gemini API is not available from this server location', undefined, 400);
      }
      if (downgrade(f, info.message)) continue;
      logEvent('gemini_error', { label: options.label, kind: 'bad_request', status: 400 });
      throw new GeminiError('bad_request', 'Gemini rejected the request format', undefined, 400);
    }

    options.gate.afterRequest(res.status === 429 ? 'http_429' : res.status >= 500 ? 'http_5xx' : 'http_other');
    let error: GeminiError;
    if (res.status === 429) {
      const raw = info.raw.toLowerCase();
      const daily = raw.includes('perday') || raw.includes('per day') || raw.includes('per_day') || raw.includes('daily');
      error = daily
        ? new GeminiError('daily_quota', "Gemini's free daily quota is used up", undefined, 429)
        : new GeminiError('rate_limit', 'Gemini rate limit reached', retryAfterSeconds(json, res, info.message) ?? 20, 429);
    } else if (res.status === 401 || res.status === 403) {
      error = new GeminiError('auth', 'The Gemini API key was rejected or lacks access to this model', undefined, res.status);
    } else if (res.status === 404) {
      error = new GeminiError('model_not_found', `Gemini model "${model}" was not found for this key`, undefined, 404);
    } else if (res.status >= 500) {
      error = new GeminiError('unavailable', 'Gemini is temporarily unavailable', 10, res.status);
    } else {
      error = new GeminiError('bad_request', `Gemini returned HTTP ${res.status}`, undefined, res.status);
    }
    logEvent('gemini_error', { label: options.label, kind: error.kind, status: res.status, ms: Date.now() - started });
    throw error;
  }
  throw new GeminiError('bad_request', 'Gemini rejected every request format this app knows');
}

/** Free metadata call used by the health check: does this key have access to the configured model? */
export async function checkGeminiModel(): Promise<{ ok: boolean; detail: string }> {
  const apiKey = config.geminiApiKey();
  const model = config.geminiModel();
  if (!apiKey) return { ok: false, detail: 'GEMINI_API_KEY is not set' };
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (res.ok) return { ok: true, detail: `${model} is available to this key` };
    if (res.status === 404) return { ok: false, detail: `Model "${model}" was not found. Set GEMINI_MODEL to a model listed in AI Studio.` };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, detail: 'The Gemini API key was rejected' };
    }
    return { ok: false, detail: `Gemini returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: isTimeoutError(err) ? 'Gemini did not respond in time' : 'Could not reach Gemini' };
  }
}
