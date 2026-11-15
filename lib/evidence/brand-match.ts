// Brand-name matching. Pure functions, no network. Used to find a brand inside Gemini's
// answers and inside retrieved text, tolerating "The", accents, punctuation and "&" vs "and".

/** "L'Oréal Paris" -> "loreal paris", "The Ordinary" -> "ordinary", "H&M" -> "h and m" */
export function normalizeName(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return base.startsWith('the ') ? base.slice(4) : base;
}

/** Stable key for caching: "La Roche-Posay" -> "la-roche-posay" */
export function brandKey(input: string): string {
  return normalizeName(input).replace(/ /g, '-');
}

function tokens(normalized: string): string[] {
  return normalized === '' ? [] : normalized.split(' ');
}

function startsWithTokens(longer: string[], shorter: string[]): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) {
    if (longer[i] !== shorter[i]) return false;
  }
  return true;
}

/**
 * Do two names refer to the same brand?
 * Equal after normalising, equal with spaces removed, or one is the leading words of the other
 * ("Fenty" and "Fenty Beauty by Rihanna", "CeraVe" and "CeraVe Moisturizing Cream").
 */
export function sameBrand(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === '' || nb === '') return false;
  if (na === nb) return true;
  if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return true;
  const ta = tokens(na);
  const tb = tokens(nb);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (shorter.join('').length < 3) return false;
  return startsWithTokens(longer, shorter);
}

/** Does this text name the brand as whole words? */
export function mentionsBrand(text: string, brand: string): boolean {
  const nb = normalizeName(brand);
  if (nb === '') return false;
  const haystack = ` ${normalizeName(text)} `;
  if (haystack.includes(` ${nb} `)) return true;
  // "Drunk Elephant" written as "DrunkElephant" or "drunkelephant.com"
  const joined = nb.replace(/ /g, '');
  if (nb.includes(' ') && joined.length >= 6 && haystack.includes(joined)) return true;
  return false;
}

/** Does a web domain look like it belongs to the brand? ("glossier.com" for "Glossier") */
export function domainMatchesBrand(domain: string, brand: string): boolean {
  const joined = normalizeName(brand).replace(/ /g, '');
  if (joined.length < 3) return false;
  const host = domain.toLowerCase().replace(/^www\./, '');
  const name = host.split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
  return name.includes(joined);
}
