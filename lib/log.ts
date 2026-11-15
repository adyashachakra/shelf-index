import 'server-only';

// Logging rules for this project:
//  - log event names, status codes, counts and durations only
//  - never log headers, request bodies, API responses or environment values
//  - every string passes through redact() before it is written

const SECRET_ENV_NAMES = [
  'GEMINI_API_KEY',
  'TAVILY_API_KEY',
  'YOUTUBE_API_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'KV_REST_API_URL',
];

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{10,}/g, // Google API keys
  /tvly-[0-9A-Za-z_-]{6,}/g, // Tavily keys
  /Bearer\s+[0-9A-Za-z._=-]+/gi,
  /(?<=[?&]key=)[^&\s"']+/gi, // a key passed in a web address (YouTube)
  /https?:\/\/[^\s"']*upstash\.io[^\s"']*/gi,
];

export function redact(value: string): string {
  let out = value;
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

type Loggable = string | number | boolean | null | undefined;

export function logEvent(event: string, fields: Record<string, Loggable> = {}): void {
  const safe: Record<string, Loggable> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = typeof value === 'string' ? redact(value).slice(0, 240) : value;
  }
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...safe }));
}

/** A short, redacted description of an error. Never includes stack traces or URLs with keys. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message).slice(0, 240);
  return 'Unknown error';
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
