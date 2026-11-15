import 'server-only';
import { isTimeoutError } from '../log';

// Minimal Upstash Redis client over its REST API (plain HTTPS, no SDK).
// Docs: https://upstash.com/docs/redis/features/restapi

export class RedisError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RedisError';
    this.status = status;
  }
}

type Arg = string | number;

function credentials(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) return null;
  return { url, token };
}

export function redisConfigured(): boolean {
  return credentials() !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const creds = credentials();
  if (!creds) throw new RedisError('Redis is not configured');
  let res: Response;
  try {
    res = await fetch(creds.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
  } catch (err) {
    throw new RedisError(isTimeoutError(err) ? 'Redis request timed out' : 'Redis request failed');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RedisError(`Redis returned an unreadable response (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const detail = isRecord(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new RedisError(`Redis error: ${detail}`, res.status);
  }
  return json;
}

function unwrap(entry: unknown): unknown {
  if (isRecord(entry)) {
    if (typeof entry.error === 'string') throw new RedisError(`Redis error: ${entry.error}`);
    return entry.result;
  }
  return entry;
}

/** Run one Redis command, e.g. cmd('GET', 'key'). */
export async function cmd<T = unknown>(...args: Arg[]): Promise<T> {
  const json = await post('', args.map(String));
  return unwrap(json) as T;
}

/** Run several commands in one HTTP request. Not atomic; use evalScript when atomicity matters. */
export async function pipeline(commands: Arg[][]): Promise<unknown[]> {
  if (commands.length === 0) return [];
  const json = await post(
    '/pipeline',
    commands.map((c) => c.map(String)),
  );
  if (!Array.isArray(json)) throw new RedisError('Redis pipeline returned an unexpected shape');
  return json.map(unwrap);
}

/** Run a Lua script. Redis executes a script as one atomic step. */
export async function evalScript<T = unknown>(script: string, keys: string[], args: Arg[]): Promise<T> {
  return cmd<T>('EVAL', script, keys.length, ...keys, ...args);
}

export async function getString(key: string): Promise<string | null> {
  const value = await cmd<string | null>('GET', key);
  return value === null || value === undefined ? null : String(value);
}

export async function getNumber(key: string): Promise<number> {
  const value = await getString(key);
  const n = value === null ? 0 : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const value = await getString(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await cmd('SET', key, JSON.stringify(value), 'EX', ttlSeconds);
}

/** SET if absent. Returns true when this call created the key. */
export async function setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const result = await cmd<string | null>('SET', key, value, 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}

export async function del(...keys: string[]): Promise<void> {
  if (keys.length > 0) await cmd('DEL', ...keys);
}

export async function hgetall(key: string): Promise<Record<string, string>> {
  const result = await cmd<unknown>('HGETALL', key);
  const out: Record<string, string> = {};
  if (Array.isArray(result)) {
    for (let i = 0; i + 1 < result.length; i += 2) out[String(result[i])] = String(result[i + 1]);
  } else if (isRecord(result)) {
    for (const [field, value] of Object.entries(result)) out[field] = String(value);
  }
  return out;
}

export async function hset(key: string, fields: Record<string, string>, ttlSeconds?: number): Promise<void> {
  const flat: string[] = [];
  for (const [field, value] of Object.entries(fields)) flat.push(field, value);
  if (flat.length === 0) return;
  if (ttlSeconds) {
    await pipeline([
      ['HSET', key, ...flat],
      ['EXPIRE', key, ttlSeconds],
    ]);
  } else {
    await cmd('HSET', key, ...flat);
  }
}
