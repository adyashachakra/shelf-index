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
 * A short single-word name ("COS", "RoC", "e.l.f.") is also the start of many other names ("COS RX",
 * "Cos De Baha"). For these the rules below are stricter: a longer name counts as the same brand only
 * when what follows is plainly generic ("COS Clothing"), never another word that makes a different name.
 */
export function isShortAmbiguousName(brand: string): boolean {
  const n = normalizeName(brand);
  return n !== '' && !n.includes(' ') && n.length <= 4;
}

/** Words that may follow a brand's name without making it a different name. */
const GENERIC_NAME_WORDS = new Set([
  'beauty', 'skincare', 'skin', 'cosmetics', 'clothing', 'clothes', 'fashion', 'apparel', 'store', 'stores', 'shop', 'official',
  'brand', 'paris', 'london', 'usa', 'uk', 'us', 'eu', 'global', 'online', 'co', 'company', 'inc', 'ltd', 'llc',
]);

/**
 * Do two names refer to the same brand?
 * Equal after normalising, equal with spaces removed, or one is the leading words of the other
 * ("Fenty" and "Fenty Beauty by Rihanna", "CeraVe" and "CeraVe Moisturizing Cream"). For a short
 * ambiguous name the extra words must be generic ("COS" is not "COS RX" or "Cos De Baha").
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
  if (!startsWithTokens(longer, shorter)) return false;
  if (shorter.length === 1 && shorter[0].length <= 4) {
    return longer.slice(1).every((word) => GENERIC_NAME_WORDS.has(word));
  }
  return true;
}

/** Words that can follow a short brand name in ordinary writing ("COS and H&M", "COS UK"). */
const PLAIN_FOLLOWERS = new Set([
  'and', 'the', 'for', 'are', 'not', 'but', 'all', 'new', 'our', 'you', 'has', 'had', 'was', 'its', 'out', 'off', 'one', 'two', 'can',
  'get', 'buy', 'vs', 'is', 'at', 'in', 'on', 'to', 'of', 'by', 'or', 'an', 'as', 'it', 'no', 'my', 'we', 'so', 'do', 'if', 'up', 'us',
  'uk', 'usa', 'eu', 'ca', 'au', 'nz', 'fr', 'am', 'pm', 'tv',
]);
const NAME_PARTICLES = new Set(['de', 'di', 'da', 'del', 'van', 'von', 'der', 'la', 'le', 'el', 'al']);

function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** The written form of a short name in raw text: the name with optional dots or apostrophes between its letters. */
function shortNamePattern(brand: string): RegExp {
  const chars = [...normalizeName(brand)].map(escapeForPattern);
  return new RegExp(`(?<![\\p{L}\\p{N}])${chars.join("[.'’]?")}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Does the writing right around this occurrence turn it into a different name?
 * "cos-IQ", "COS RX" and "Cos De Baha" are other names that begin with "cos". Returns the
 * longer name as written, or null when the occurrence stands as the brand's own name.
 */
function lookalikeAt(text: string, start: number, end: number): string | null {
  const after = text.slice(end);
  // "pre-cos": written onto the end of another word
  if (/[\p{L}\p{N}][-_]$/u.test(text.slice(Math.max(0, start - 2), start))) return text.slice(Math.max(0, start - 8), end).trim();
  // "cos-IQ": written onto the start of another word
  const joined = after.match(/^[-_][\p{L}\p{N}]+/u);
  if (joined) return text.slice(start, end + joined[0].length);
  const words = after.match(/^\s+(\p{L}[\p{L}\p{N}]*)(?:\s+(\p{L}[\p{L}\p{N}]*))?/u);
  if (!words) return null;
  const next = words[1];
  const lower = next.toLowerCase();
  if (NAME_PARTICLES.has(lower) && words[2]) return `${text.slice(start, end)} ${next} ${words[2]}`;
  const shortAllCaps = next.length <= 3 && next === next.toUpperCase() && !PLAIN_FOLLOWERS.has(lower);
  if (shortAllCaps && /\p{Lu}/u.test(next)) return `${text.slice(start, end)} ${next}`;
  return null;
}

/** For a short ambiguous name: the occurrences that stand alone, and the longer names they turned out to be part of. */
export function scanShortName(text: string, brand: string): { standalone: number; lookalikes: string[] } {
  const folded = fold(text);
  const out = { standalone: 0, lookalikes: [] as string[] };
  for (const match of folded.matchAll(shortNamePattern(brand))) {
    const start = match.index ?? 0;
    const longer = lookalikeAt(folded, start, start + match[0].length);
    if (longer === null) out.standalone += 1;
    else if (!out.lookalikes.includes(longer)) out.lookalikes.push(longer);
  }
  return out;
}

/** The older, looser test: the name as whole words after normalising. Kept to tell "no mention" from "a similar name". */
export function mentionsBrandLoosely(text: string, brand: string): boolean {
  const nb = normalizeName(brand);
  if (nb === '') return false;
  const haystack = ` ${normalizeName(text)} `;
  if (haystack.includes(` ${nb} `)) return true;
  // "Drunk Elephant" written as "DrunkElephant" or "drunkelephant.com"
  const joined = nb.replace(/ /g, '');
  if (nb.includes(' ') && joined.length >= 6 && haystack.includes(joined)) return true;
  return false;
}

/**
 * Does this text name the brand as whole words? For a short ambiguous name ("COS") an occurrence that
 * is really part of another name ("COS RX", "cos-IQ", "Cos De Baha") does not count.
 */
export function mentionsBrand(text: string, brand: string): boolean {
  if (isShortAmbiguousName(brand)) return scanShortName(text, brand).standalone > 0;
  return mentionsBrandLoosely(text, brand);
}

// ---------- Web domains ----------

const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** The name part of a web address that its owner registered: "shop.cos.com" -> "cos", "cos.co.uk" -> "cos". */
export function registeredName(domain: string): string {
  const host = domain
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  const parts = host.split('.').filter((part) => part !== '');
  if (parts.length < 2) return '';
  let index = parts.length - 2;
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL_LABELS.has(parts[parts.length - 2])) index = parts.length - 3;
  return parts[index];
}

// Plain words a brand's own address may add to its name: "shopcos.com", "cos-us.com", "cosstores.com".
const AFFIXES_ANY_NAME = new Set(['shop', 'shops', 'store', 'stores', 'official', 'online', 'us', 'usa', 'uk', 'eu', 'global', 'the', 'get', 'buy', 'wear', 'shopping']);
const AFFIXES_LONGER_NAMES = new Set([...AFFIXES_ANY_NAME, 'hello', 'my', 'try', 'hq', 'home', 'brand', 'co', 'beauty', 'skin', 'skincare', 'cosmetics', 'labs', 'lab', 'clothing', 'apparel', 'fashion']);

/** The ways the name can be written without spaces: "H&M" -> "handm" and "hm". */
function joinedForms(brand: string): string[] {
  const normalized = normalizeName(brand);
  const forms = new Set([normalized.replace(/ /g, ''), normalized.split(' ').filter((word) => word !== 'and').join('')]);
  return [...forms].filter((form) => form.length >= 2);
}

/**
 * Does this web address belong to the brand? Strict: the registered name must BE the brand's name,
 * optionally with one plain word added in front or behind ("shop", "us", "stores"). A name that merely
 * contains the brand's name does not count: "cosgramusa.com", "cosrx.com" and "cos-iq.com" are not
 * COS, and "sephora.com" is not "Glossier". Short names are matched exactly, never loosely.
 */
export function domainBelongsToBrand(domain: string, brand: string): boolean {
  const name = registeredName(domain).replace(/[^a-z0-9]/g, '');
  if (name === '') return false;
  const affixes = isShortAmbiguousName(brand) ? AFFIXES_ANY_NAME : AFFIXES_LONGER_NAMES;
  for (const form of joinedForms(brand)) {
    if (name === form) return true;
    if (form.length < 3) continue;
    for (const lead of ['', ...affixes]) {
      for (const tail of ['', ...affixes]) {
        if (lead === '' && tail === '') continue;
        if (name === `${lead}${form}${tail}`) return true;
      }
    }
  }
  return false;
}

/** Kept under its old name: every use of it now gets the strict rule above. */
export const domainMatchesBrand = domainBelongsToBrand;

/** Does the address merely resemble the brand's name (contain it)? Used only to explain what was set aside. */
export function domainResemblesBrand(domain: string, brand: string): boolean {
  const name = registeredName(domain).replace(/[^a-z0-9]/g, '');
  return joinedForms(brand).some((form) => form.length >= 3 && name.includes(form)) && !domainBelongsToBrand(domain, brand);
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
