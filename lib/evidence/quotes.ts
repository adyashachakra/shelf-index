// Quote verification. A quote the model attributes to a source is only shown if we can
// find it in the text we actually retrieved from that source.

import { mentionsBrand } from './brand-match';

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when the quote appears in the text: either the whole quote (ignoring case, punctuation
 * and spacing), or, for longer quotes, any run of six consecutive words from it.
 */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote);
  const t = normalizeForMatch(text);
  if (q.length < 8 || t.length === 0) return false;
  if (t.includes(q)) return true;
  const words = q.split(' ');
  if (words.length < 8) return false;
  for (let i = 0; i + 6 <= words.length; i += 1) {
    if (t.includes(words.slice(i, i + 6).join(' '))) return true;
  }
  return false;
}

/**
 * Where a quote sits in a text, in the normalized form used for matching. Returns the start and
 * end of the matching run, or null when the quote is not there.
 */
function locate(quote: string, text: string): { normalized: string; start: number; end: number } | null {
  const q = normalizeForMatch(quote);
  const t = normalizeForMatch(text);
  if (q.length < 8 || t.length === 0) return null;
  const whole = t.indexOf(q);
  if (whole >= 0) return { normalized: t, start: whole, end: whole + q.length };
  const words = q.split(' ');
  if (words.length < 8) return null;
  for (let i = 0; i + 6 <= words.length; i += 1) {
    const run = words.slice(i, i + 6).join(' ');
    const at = t.indexOf(run);
    if (at >= 0) return { normalized: t, start: at, end: at + run.length };
  }
  return null;
}

/**
 * The passage around a quote: the quote itself plus about forty words either side.
 * Used to check that a quote is talking about the brand and not about something else on
 * the same page. Returns null when the quote is not in the text.
 */
export function passageAround(quote: string, text: string, reach = 240): string | null {
  const found = locate(quote, text);
  if (!found) return null;
  return found.normalized.slice(Math.max(0, found.start - reach), found.end + reach);
}

/**
 * Is a quote both present in a source and about the brand?
 *
 *  - "not_found": the words are not in the title or text we retrieved.
 *  - "not_about_brand": the words are there, but neither the title nor the passage around them
 *    names the brand. A sentence that could be about any brand proves nothing about this one.
 *  - "ok": found, and on the brand's own site, or under a title that names the brand, or in a
 *    passage that names it.
 */
export function quoteIsAboutBrand(input: {
  quote: string;
  title: string;
  text: string;
  brand: string;
  ownSite: boolean;
}): 'ok' | 'not_found' | 'not_about_brand' {
  const passage = passageAround(input.quote, `${input.title}. ${input.text}`);
  if (passage === null) return 'not_found';
  if (input.ownSite || mentionsBrand(input.title, input.brand) || mentionsBrand(passage, input.brand)) return 'ok';
  return 'not_about_brand';
}
