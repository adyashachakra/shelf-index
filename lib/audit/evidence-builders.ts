import 'server-only';
import type { TavilyResult } from '../clients/tavily';
import { domainBelongsToBrand, domainResemblesBrand, mentionsBrand, scanShortName, isShortAmbiguousName, mentionsBrandLoosely } from '../evidence/brand-match';
import {
  canonicalUrl,
  clean,
  clip,
  domainOf,
  isHttpUrl,
  isSocialDomain,
  siteSection,
  stripBoilerplate,
} from '../evidence/normalize';
import { detectSponsorship } from '../evidence/sponsorship';
import type { EvidenceItem, EvidenceKind, SetAsideEvidence, SitePage } from '../types';
import type { JobData } from './job';

/**
 * Why a result that used a similar name was not counted as the brand, or null when it did not use one.
 * "COS RX" and "cos-IQ" are other names that begin with "cos"; "cosgramusa.com" only contains it.
 */
export function similarNameReason(text: string, domain: string, brand: string): string | null {
  if (isShortAmbiguousName(brand)) {
    const scan = scanShortName(text, brand);
    if (scan.standalone === 0 && scan.lookalikes.length > 0) {
      return `Names "${scan.lookalikes.slice(0, 2).join('" and "')}", which is a different name from "${brand}".`;
    }
  } else if (!mentionsBrand(text, brand) && mentionsBrandLoosely(text, brand)) {
    return `The name appears only in a form that is not "${brand}".`;
  }
  if (domainResemblesBrand(domain, brand)) {
    return `The web address ${domain} resembles the name but is not an exact match, so it was not treated as the brand's site.`;
  }
  return null;
}

/**
 * Turn search results into evidence about a brand. Keeps only results that name the brand,
 * drops social platforms and the brand's own domain, and removes duplicates.
 *
 * Identity is strict: a result counts only if its text names the brand itself (not a longer or
 * similar name) and, for the brand's own domain, only if the domain's registered name IS the brand's
 * name. Results that used a similar name are not counted, and are passed to onSetAside so the report
 * can show what was left out and why.
 */
export function resultsToEvidence(options: {
  results: TavilyResult[];
  kind: EvidenceKind;
  prefix: string;
  brand: string;
  startIndex: number;
  seenUrls: Set<string>;
  competitor?: string;
  onBrandDomain?: (domain: string) => void;
  onSetAside?: (entry: SetAsideEvidence) => void;
  /** Keep pages from the brand's own domain (useful when checking facts, not when gauging opinion). */
  allowBrandDomain?: boolean;
}): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const result of options.results) {
    if (!isHttpUrl(result.url)) continue;
    const domain = domainOf(result.url);
    if (domain === '' || isSocialDomain(domain)) continue;
    const title = clean(result.title);
    const text = clip(clean(result.content), 1100);
    const named = mentionsBrand(`${title} ${text}`, options.brand);
    if (domainBelongsToBrand(domain, options.brand)) {
      // A page on the brand's own address that also names the brand is what establishes the address.
      if (named) options.onBrandDomain?.(domain);
      if (!options.allowBrandDomain) continue; // the brand's own pages are not independent evidence
    }
    if (text.length < 40) continue;
    if (!named) {
      const reason = similarNameReason(`${title} ${text}`, domain, options.brand);
      if (reason !== null) options.onSetAside?.({ title: clip(title, 120), url: result.url, domain, reason });
      continue;
    }
    const key = canonicalUrl(result.url);
    if (options.seenUrls.has(key)) continue;
    options.seenUrls.add(key);
    const signals = detectSponsorship(`${title} ${text}`);
    items.push({
      id: `${options.prefix}${options.startIndex + items.length + 1}`,
      kind: options.kind,
      url: result.url,
      domain,
      title: clip(title, 160),
      text,
      sourceUrl: result.url,
      ...(signals.length > 0 ? { sponsored: signals } : {}),
      ...(options.competitor ? { competitor: options.competitor } : {}),
    });
  }
  return items;
}

/** Turn site-restricted search results into readable pages of the brand's own site. */
export function resultsToSitePages(results: TavilyResult[], domain: string, existing: SitePage[]): SitePage[] {
  const seen = new Set(existing.map((p) => canonicalUrl(p.url)));
  const pages: SitePage[] = [...existing];
  for (const result of results) {
    if (!isHttpUrl(result.url)) continue;
    const host = domainOf(result.url);
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    const key = canonicalUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = clean(result.content);
    const body = result.rawContent ? stripBoilerplate(result.rawContent) : '';
    const combined = body.length > snippet.length ? `${snippet} ${body}` : snippet;
    pages.push({
      id: `S${pages.length + 1}`,
      url: result.url,
      title: clip(clean(result.title), 160),
      text: clip(combined, 2600),
      section: siteSection(result.url),
    });
    if (pages.length >= 14) break;
  }
  return pages;
}

export const MIN_READABLE_PAGE_CHARS = 200;

export function readablePages(pages: SitePage[]): SitePage[] {
  return pages.filter((p) => p.text.length >= MIN_READABLE_PAGE_CHARS);
}

/** The audience evidence that gets labeled and scored, in a fixed order with fixed caps. */
export function audienceItems(data: JobData): EvidenceItem[] {
  const fromSearch = data.audience?.items ?? [];
  const discussions = fromSearch.filter((i) => i.kind === 'discussion').slice(0, 10);
  const reviews = fromSearch.filter((i) => i.kind === 'review').slice(0, 10);
  const videos = (data.youtube?.videos ?? []).slice(0, 4);
  const comments = (data.youtube?.comments ?? []).slice(0, 32);
  const all = [...discussions, ...reviews, ...videos, ...comments];
  // Once the evidence has been read, an item shown to be about a different business with a similar name is
  // not evidence about this brand: it is out of the scores, the themes, the competitor comparison and the fixes.
  const different = new Set((data.labels?.labels ?? []).filter((label) => label.sameBusiness === false).map((label) => label.id));
  return different.size === 0 ? all : all.filter((item) => !different.has(item.id));
}

/** Items the reading of the evidence showed to be about a different business, for the diagnostics section. */
export function differentBusinessItems(data: JobData): EvidenceItem[] {
  const different = new Set((data.labels?.labels ?? []).filter((label) => label.sameBusiness === false).map((label) => label.id));
  if (different.size === 0) return [];
  const fromSearch = data.audience?.items ?? [];
  const everything = [...fromSearch, ...(data.youtube?.videos ?? []), ...(data.youtube?.comments ?? [])];
  return everything.filter((item) => different.has(item.id));
}

export function sourceLabel(item: EvidenceItem): string {
  switch (item.kind) {
    case 'discussion':
      return `Community discussion on ${item.domain}`;
    case 'review':
      return `Article or review on ${item.domain}`;
    case 'youtube_video':
      return `YouTube video by ${item.channel || 'a creator'} (title and description)`;
    case 'youtube_comment':
      return 'Viewer comment on a YouTube video';
    case 'site_page':
      return `The brand's own site (${item.domain})`;
    case 'claim_source':
    case 'competitor_source':
      return `Web page on ${item.domain}`;
    default:
      return item.domain;
  }
}
