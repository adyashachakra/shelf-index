// Brand-name matching. Pure functions, no network. Used to find a brand inside Gemini's
// answers and inside retrieved text, tolerating "The", accents, punctuation and "&" vs "and".
import type { MatchedContext } from '../types';

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

/**
 * Words that can follow a short brand name in ordinary writing ("COS and H&M", "COS UK", "COS A/W 2026", "COS IE store").
 * Matched in lower case. A follower is only ever looked at when it is two or three capital letters (see lookalikeAt), so
 * every entry is two or three letters. "de" and "id" are deliberately NOT on the list (see README, known limitations).
 */
export const PLAIN_FOLLOWERS: ReadonlySet<string> = new Set([
  'and', 'the', 'for', 'are', 'not', 'but', 'all', 'new', 'our', 'you', 'has', 'had', 'was', 'its', 'out', 'off', 'one', 'two', 'can',
  'get', 'buy', 'vs', 'is', 'at', 'in', 'on', 'to', 'of', 'by', 'or', 'an', 'as', 'it', 'no', 'my', 'we', 'so', 'do', 'if', 'up', 'us',
  'uk', 'usa', 'eu', 'ca', 'au', 'nz', 'fr', 'am', 'pm', 'tv',
  // season and collection codes
  'aw', 'ss', 'fw', 'pf', 'cr',
  // country and region codes
  'es', 'jp', 'ie', 'ch', 'dk', 'se', 'nl', 'sg', 'hk', 'be', 'pt', 'pl', 'mx', 'br', 'ae', 'za', 'kr', 'cn',
  // retail section words, size and product codes
  'men', 'hq', 'xs', 'xl', 'xxl', 'spf', 'uv',
]);
const NAME_PARTICLES = new Set(['de', 'di', 'da', 'del', 'van', 'von', 'der', 'la', 'le', 'el', 'al']);
/**
 * Field labels on a structured profile page ("# COS ID: IrthV3LEdVhE Website: www.cos.com", the shape of a company
 * profile in a search index, for any brand). A follower is read as such a label, not as part of a different name, only
 * when ALL hold: it is one of these words; the name it follows is the first thing in the field (leading whitespace and
 * a "#" heading marker allowed); and a colon follows it with one code-like value (letters and at least one digit, no
 * spaces, e.g. "IrthV3LEdVhE"). "COS ID" anywhere else, or "Nike ID: design your own…", is still a look-alike.
 */
const FIELD_LABELS: ReadonlySet<string> = new Set(['id']);

// ---------- Folding with a position map ----------

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Remove accents the way the matcher always has (NFKD, then drop combining marks), but one code point at a time, keeping
 * for every character of the result the position in the original text it came from. Folding a code point on its own gives
 * the same result as folding the whole string (marks are removed either way), so no decision of the matcher changes.
 */
export function foldWithMap(text: string): { folded: string; starts: number[] } {
  let folded = '';
  const starts: number[] = [];
  let index = 0;
  for (const char of text) {
    const out = char.normalize('NFKD').replace(COMBINING_MARKS, '');
    for (let k = 0; k < out.length; k += 1) starts.push(index);
    folded += out;
    index += char.length;
  }
  return { folded, starts };
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(COMBINING_MARKS, '');
}

/** The written form of a short name in raw text: the name with optional dots or apostrophes between its letters. */
function shortNamePattern(brand: string): RegExp {
  const chars = [...normalizeName(brand)].map(escapeForPattern);
  return new RegExp(`(?<![\\p{L}\\p{N}])${chars.join("[.'’]?")}(?![\\p{L}\\p{N}])`, 'giu');
}

// ---------- Look-alikes and where they are ----------

export type BrandFieldName = 'title' | 'snippet' | 'description' | 'page text' | 'comment';
/** One piece of text an item is made of. Each is checked on its own, so the end of one never joins the start of the next. */
export interface BrandField {
  name: BrandFieldName;
  text: string;
}
export type LookalikeRule = MatchedContext['rule'];

/** A look-alike occurrence: its name as listed, and where it is, in the original text and in the accent-free copy. */
export interface Hit {
  text: string;
  from: number;
  to: number;
  foldedFrom: number;
  foldedTo: number;
  rule: LookalikeRule;
}
export type Trigger = Hit & { field: BrandFieldName; index: number };

/** Positions are in the accent-free copy; `scanShortName` maps them back to the original. */
interface FoldedHit {
  name: string;
  from: number;
  to: number;
  rule: LookalikeRule;
}

/**
 * Does the writing right around this occurrence turn it into a different name?
 * "cos-IQ", "COS RX" and "Cos De Baha" are other names that begin with "cos". Returns the longer name as written and
 * where it is, or null when the occurrence stands as the brand's own name.
 *
 * A short capitalised word after the name counts only when it is two or three capital letters, is not on the
 * plain-followers list ("UK", "A/W" is one letter and so never examined, "SS", "IE"…), and is not the brand's own name
 * written again ("Image © COS" and then "COS designer…").
 */
function lookalikeAt(text: string, start: number, end: number): FoldedHit | null {
  const after = text.slice(end);
  // "pre-cos": written onto the end of another word
  const prefix = text.slice(0, start).match(/[\p{L}\p{N}]+[-_]$/u);
  if (prefix) return { name: text.slice(Math.max(0, start - 8), end).trim(), from: start - prefix[0].length, to: end, rule: 'prefix' };
  // "cos-IQ": written onto the start of another word
  const joined = after.match(/^[-_][\p{L}\p{N}]+/u);
  if (joined) return { name: text.slice(start, end + joined[0].length), from: start, to: end + joined[0].length, rule: 'joined' };
  const words = after.match(/^(\s+)(\p{L}[\p{L}\p{N}]*)(?:\s+(\p{L}[\p{L}\p{N}]*))?/u);
  if (!words) return null;
  const next = words[2];
  const lower = next.toLowerCase();
  if (NAME_PARTICLES.has(lower) && words[3]) {
    return { name: `${text.slice(start, end)} ${next} ${words[3]}`, from: start, to: end + words[0].length, rule: 'particle' };
  }
  const written = text.slice(start, end);
  if (FIELD_LABELS.has(lower) && isProfileFieldLabel(text.slice(0, start), text.slice(end + words[1].length + next.length))) return null;
  const shortAllCaps = next.length >= 2 && next.length <= 3 && next === next.toUpperCase() && !PLAIN_FOLLOWERS.has(lower);
  if (shortAllCaps && /\p{Lu}/u.test(next) && normalizeName(next) !== normalizeName(written)) {
    return { name: `${written} ${next}`, from: start, to: end + words[1].length + next.length, rule: 'follower' };
  }
  return null;
}

const FIELD_START = /^\s*(?:#+[ \t]*)?$/;
const CODE_VALUE = /^[ \t]*:[ \t]*(?=[\p{L}\p{N}]*\p{N})(?=[\p{L}\p{N}]*\p{L})[\p{L}\p{N}]+(?=\s|$)/u;

/** See FIELD_LABELS: the name opens the field, and the label is followed by a colon and a code-like value. */
function isProfileFieldLabel(before: string, afterLabel: string): boolean {
  return FIELD_START.test(before) && CODE_VALUE.test(afterLabel);
}

/** For a short ambiguous name: the occurrences that stand alone, and the longer names they turned out to be part of. */
export function scanShortName(text: string, brand: string): { standalone: number; lookalikes: string[]; hits: Hit[] } {
  const { folded, starts } = foldWithMap(text);
  const out = { standalone: 0, lookalikes: [] as string[], hits: [] as Hit[] };
  for (const match of folded.matchAll(shortNamePattern(brand))) {
    const start = match.index ?? 0;
    const found = lookalikeAt(folded, start, start + match[0].length);
    if (found === null) out.standalone += 1;
    else if (!out.lookalikes.includes(found.name)) {
      out.lookalikes.push(found.name);
      out.hits.push(toHit(text, starts, found));
    }
  }
  return out;
}

function toHit(original: string, starts: number[], found: FoldedHit): Hit {
  const from = starts[found.from] ?? original.length;
  const to = found.to < starts.length ? starts[found.to] : original.length;
  return { text: found.name, from, to, foldedFrom: found.from, foldedTo: found.to, rule: found.rule };
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

// ---------- Names written run together with the brand's letters ("COSRX") ----------

/**
 * Ordinary words that begin with a short brand's letters. Written in capitals inside a title ("THE COST OF...")
 * they must not be read as another business. The list is short on purpose and covers the words a short name
 * is most likely to meet; a word missing from it can only cause a page to be left out as "mixed", never a score change.
 */
const ORDINARY_WORDS = new Set([
  'cost', 'costs', 'cosy', 'cosh', 'costa', 'cosmo', 'cosmos', 'cosmic', 'cosine', 'cosec',
  'rocks', 'rocky', 'rocket',
]);

/** Endings that make a plural or another form of the same word, never another name. */
const WORD_ENDINGS = new Set(['s', 'es', 'ed', 'er', 'ers', 'ing', 'ly']);

/**
 * For a short ambiguous name only (a single word of four letters or fewer): the words in the text that are the
 * brand's letters with one to three capital letters or digits written straight on ("COSRX", "CosRX", "COSX").
 * A word that continues in lower case ("Cost", "Cosmetics"), an ordinary word on the short list above, a plural
 * or other ending, and the plain place and shop words that may follow a name ("COSUS", "COSSHOP") are not such names.
 * Longer brand names are never examined here.
 */
export function runTogetherLookalikes(text: string, brand: string): string[] {
  return runTogetherHits(text, brand).map((hit) => hit.text);
}

/** The same words as `runTogetherLookalikes`, with where each one is. */
function runTogetherHits(text: string, brand: string): Hit[] {
  if (!isShortAmbiguousName(brand)) return [];
  const letters = normalizeName(brand).replace(/ /g, '');
  const { folded, starts } = foldWithMap(text);
  const found: Hit[] = [];
  for (const match of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (word.length <= letters.length || word.length > letters.length + 3) continue;
    if (word.slice(0, letters.length).toLowerCase() !== letters) continue;
    const extra = word.slice(letters.length);
    if (!/^[\p{Lu}\p{N}]/u.test(extra)) continue; // the next letter is lower case: an ordinary word, not a fused name
    const lower = word.toLowerCase();
    const extraLower = extra.toLowerCase();
    if (ORDINARY_WORDS.has(lower) || WORD_ENDINGS.has(extraLower) || AFFIXES_ANY_NAME.has(extraLower) || GENERIC_NAME_WORDS.has(extraLower)) continue;
    if (!found.some((hit) => hit.text === word)) {
      const at = match.index ?? 0;
      found.push(toHit(text, starts, { name: word, from: at, to: at + word.length, rule: 'run-together' }));
    }
  }
  return found;
}

export type Attribution = 'clear' | 'mixed' | 'other' | 'none';

export interface AttributionResult {
  state: Attribution;
  lookalikes: string[];
  /** The first look-alike listed, with the field it was in: the occurrence that decided the verdict. */
  trigger?: Trigger;
}

/**
 * Whose is this text, judged field by field? For a short ambiguous name each field is examined on its own (the last
 * word of a title is never read together with the first word of a snippet), and the results are combined:
 *  - clear: names the brand and no look-alike;
 *  - mixed: names the brand AND a look-alike ("COS to COSRX", "COS vs Cos De Baha"), so what it says cannot be
 *    attributed to the brand and it is unverified (a brand in one field and a look-alike in another is still mixed);
 *  - other: names only a look-alike;
 *  - none: names neither.
 * Look-alikes are listed in field order, then in the order each field finds them (spaced and joined forms first, then
 * run-together forms). For longer names the look-alike rules are not applied: "clear" when a field names the brand.
 */
export function brandAttributionOfFields(fields: BrandField[], brand: string): AttributionResult {
  if (!isShortAmbiguousName(brand)) return { state: fields.some((field) => mentionsBrandLoosely(field.text, brand)) ? 'clear' : 'none', lookalikes: [] };
  let standalone = 0;
  const lookalikes: string[] = [];
  let trigger: Trigger | undefined;
  fields.forEach((field, index) => {
    const scan = scanShortName(field.text, brand);
    standalone += scan.standalone;
    for (const hit of [...scan.hits, ...runTogetherHits(field.text, brand)]) {
      if (lookalikes.includes(hit.text)) continue;
      lookalikes.push(hit.text);
      trigger ??= { ...hit, field: field.name, index };
    }
  });
  const state: Attribution = standalone > 0 ? (lookalikes.length > 0 ? 'mixed' : 'clear') : lookalikes.length > 0 ? 'other' : 'none';
  return trigger ? { state, lookalikes, trigger } : { state, lookalikes };
}

/** One text, as `brandAttributionOfFields` with a single field. */
export function brandAttribution(text: string, brand: string): AttributionResult {
  return brandAttributionOfFields([{ name: 'snippet', text }], brand);
}

/** Does any field name the brand as whole words? For a short ambiguous name, an occurrence inside another name does not count. */
export function mentionsBrandInFields(fields: BrandField[], brand: string): boolean {
  return fields.some((field) => mentionsBrand(field.text, brand));
}

// ---------- The text around the occurrence that fired ----------

const CONTEXT_LIMIT = 160;
const MARK_LIMIT = 80;
const collapse = (value: string): string => value.replace(/\s+/g, ' ');

/**
 * The short stretch of text around a look-alike, for the report to show why an item was set aside. It is cut from the
 * ORIGINAL text, so capitals and accents are as written, and `markFrom`/`markTo` index the returned text exactly. If
 * the span cannot be mapped back onto the original (not expected), the accent-free copy is used with its own span.
 * At most 160 characters, cut only between words, with "…" on a side that was cut (the dots count).
 */
export function matchedContext(original: string, hit: Hit, field: BrandFieldName): MatchedContext {
  const foldedText = fold(original);
  let source = original;
  let from = hit.from;
  let to = hit.to;
  const mapsBack = from >= 0 && to > from && to <= original.length && fold(original.slice(from, to)) === foldedText.slice(hit.foldedFrom, hit.foldedTo);
  if (!mapsBack) {
    source = foldedText;
    from = hit.foldedFrom;
    to = hit.foldedTo;
  }
  let left = collapse(source.slice(0, from)).replace(/^ /, '');
  let mark = collapse(source.slice(from, to));
  let right = collapse(source.slice(to)).replace(/ $/, '');
  if (mark.length > MARK_LIMIT) mark = mark.slice(0, MARK_LIMIT);
  if (left.length + mark.length + right.length > CONTEXT_LIMIT) {
    const room = CONTEXT_LIMIT - mark.length;
    let leftRoom = Math.floor(room / 2);
    let rightRoom = room - leftRoom;
    if (left.length < leftRoom) {
      rightRoom += leftRoom - left.length;
      leftRoom = left.length;
    } else if (right.length < rightRoom) {
      leftRoom += rightRoom - right.length;
      rightRoom = right.length;
    }
    if (left.length > leftRoom) {
      let kept = left.slice(left.length - Math.max(0, leftRoom - 1));
      if (left[left.length - kept.length - 1] !== ' ' && !kept.startsWith(' ')) {
        const space = kept.indexOf(' ');
        kept = space === -1 ? '' : kept.slice(space);
      }
      left = `…${kept.replace(/^ /, '')}`;
    }
    if (right.length > rightRoom) {
      let kept = right.slice(0, Math.max(0, rightRoom - 1));
      if (right[kept.length] !== ' ' && !kept.endsWith(' ')) {
        const space = kept.lastIndexOf(' ');
        kept = space === -1 ? '' : kept.slice(0, space);
      }
      right = `${kept.replace(/ $/, '')}…`;
    }
  }
  return { text: `${left}${mark}${right}`, markFrom: left.length, markTo: left.length + mark.length, field, rule: hit.rule };
}

/** The context for the first look-alike that decided an item's verdict, or null when there is none. */
export function triggerContext(fields: BrandField[], brand: string): MatchedContext | null {
  const trigger = brandAttributionOfFields(fields, brand).trigger;
  return trigger ? matchedContext(fields[trigger.index].text, trigger, trigger.field) : null;
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
