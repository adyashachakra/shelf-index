// Text and URL helpers for turning raw search results into evidence items.

/** Social platforms this project never reads content from, directly or through search. */
export const SOCIAL_DOMAINS = [
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'pinterest.com',
  'linkedin.com',
  'threads.net',
  'snapchat.com',
];

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** "https://www.Example.com/a/b" -> "example.com" */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Turn "www.Brand.com/shop" or "https://brand.com" into "brand.com". Empty string if not a domain. */
export function cleanDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return '';
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const host = domainOf(withScheme);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

export function isSocialDomain(domain: string): boolean {
  return SOCIAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** First path segment, used to tell product pages from blog/FAQ pages. "/" -> "home" */
export function siteSection(url: string): string {
  try {
    const first = new URL(url).pathname.split('/').filter(Boolean)[0];
    return first ? first.toLowerCase().slice(0, 40) : 'home';
  } catch {
    return 'home';
  }
}

export function clean(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

/** Remove navigation menus, image tags and link-only lines from page markdown; keep readable prose. */
export function stripBoilerplate(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line === '') continue;
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(line)) continue; // image only
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // inline images
    const withoutLinks = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    const linkCount = (line.match(/\]\(/g) ?? []).length;
    const textOnly = withoutLinks.replace(/[#*_>|`-]/g, '').trim();
    if (textOnly.length < 3) continue;
    // Menu-like lines: several links and very little other text.
    if (linkCount >= 3 && textOnly.length < 90) continue;
    if (linkCount >= 1 && textOnly.length < 18 && !/[?:]$/.test(textOnly)) continue;
    kept.push(withoutLinks);
  }
  return clean(kept.join(' '));
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** Canonical form of a URL for de-duplication (no hash, no tracking parameters, no trailing slash). */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const param of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$)/i.test(param)) parsed.searchParams.delete(param);
    }
    const query = parsed.searchParams.toString();
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}
