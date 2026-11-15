// Calendar helpers for quota keys. The "day" for limits follows QUOTA_TIMEZONE
// (default Pacific time, which is when Gemini's and YouTube's daily quotas reset).

function parts(timeZone: string, now: Date): { year: number; month: number; day: number } {
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    formatted = now.toISOString().slice(0, 10); // unknown time zone: fall back to UTC
  }
  const [year, month, day] = formatted.split('-').map((p) => Number.parseInt(p, 10));
  return { year, month, day };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** e.g. "2026-11-14" */
export function dayKey(timeZone: string, now: Date = new Date()): string {
  const p = parts(timeZone, now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** e.g. "2026-11" */
export function monthKey(timeZone: string, now: Date = new Date()): string {
  const p = parts(timeZone, now);
  return `${p.year}-${pad(p.month)}`;
}

/** Days remaining in the current month, counting today. */
export function daysLeftInMonth(timeZone: string, now: Date = new Date()): number {
  const p = parts(timeZone, now);
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return Math.max(1, daysInMonth - p.day + 1);
}
