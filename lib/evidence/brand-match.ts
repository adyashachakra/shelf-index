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

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "cetaphil" -> "Cetaphil", "la roche-posay" -> "La Roche-Posay", "h&m" -> "H&M",
 * "l'oreal" -> "L'Oreal" (but "paula's choice" -> "Paula's Choice"). A first tidy-up only:
 * the finished report uses the spelling the sources use most (see mostCommonCasing).
 */
export function titleCaseBrand(input: string): string {
  return input
    .replace(/(^|[\s\-&./+])(\p{Ll})/gu, (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`)
    .replace(/(^|[\s\-])(\p{L})'(\p{Ll})/gu, (_match, lead: string, first: string, letter: string) => `${lead}${first.toUpperCase()}'${letter.toUpperCase()}`);
}

/**
 * Is the capitalisation the visitor typed worth keeping as it is? Mixed case ("CeraVe") and
 * short all-capital names ("H&M", "RoC") are deliberate. All lower case, or a long name in
 * capitals, is just how it was typed.
 */
export function casingLooksDeliberate(typed: string): boolean {
  const hasLower = /\p{Ll}/u.test(typed);
  const hasUpper = /\p{Lu}/u.test(typed);
  if (hasLower && hasUpper) return true;
  if (hasUpper && !hasLower) return typed.replace(/[^\p{L}]/gu, '').length <= 4;
  return false;
}

/**
 * The way a brand's name is most often written in a set of texts (Gemini's answers, the brand's
 * own page titles, source titles). Returns null when the texts write it out fewer than twice, so
 * the caller keeps its own version. Only capitalisation can differ from the name given, and a
 * brand that writes itself in lower case ("e.l.f.") keeps its lower case.
 */
export function mostCommonCasing(name: string, texts: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForPattern(trimmed).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const variant = match[0].replace(/\s+/g, ' ');
      counts.set(variant, (counts.get(variant) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 1; // needs at least two sightings to count as the usual spelling
  for (const [variant, count] of counts) {
    if (count > bestCount) {
      best = variant;
      bestCount = count;
    }
  }
  return best;
}
