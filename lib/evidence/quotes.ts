// Quote verification. A quote the model attributes to a source is only shown if we can
// find it in the text we actually retrieved from that source.

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
