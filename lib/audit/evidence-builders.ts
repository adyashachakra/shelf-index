import 'server-only';
import type { TavilyResult } from '../clients/tavily';
import {
  brandAttributionOfFields,
  domainBelongsToBrand,
  domainResemblesBrand,
  isShortAmbiguousName,
  matchedContext,
  mentionsBrandInFields,
  mentionsBrandLoosely,
  type BrandField,
} from '../evidence/brand-match';
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
import type { EvidenceItem, EvidenceKind, MatchedContext, SetAsideEvidence, SitePage } from '../types';
import type { JobData } from './job';

/**
 * Why an item that names the brand and also a look-alike ("COS to COSRX", "COS vs Cos De Baha") is not counted:
 * what it says cannot be attributed to the brand, so it is unverified. Shown under "Found but not counted".
 */
export function mixedNameReason(brand: string, lookalikes: string[]): string {
  const names = lookalikes.slice(0, 2).map((name) => `"${name}"`).join(' and ');
  return `Names both "${brand}" and ${names} (a different name), so what it says cannot be attributed to ${brand}.`;
}

/** The reason for an item the reader judged to discuss both the brand and another business with a similar name. */
export function mixedByReaderReason(brand: string): string {
  return `Read and judged to discuss both ${brand} and a different business with a similar name, so what it says cannot be attributed to ${brand}.`;
}

/** The context for the look-alike that decided an attribution, or undefined when it has none. */
function contextOf(fields: BrandField[], trigger: ReturnType<typeof brandAttributionOfFields>['trigger']): MatchedContext | undefined {
  return trigger ? matchedContext(fields[trigger.index].text, trigger, trigger.field) : undefined;
}

/**
 * Why a result that used a similar name was not counted as the brand, or null when it did not use one, and the text that
 * triggered it when there is one. "COS RX" and "cos-IQ" are other names that begin with "cos"; "cosgramusa.com" only
 * contains it. An item that names the brand and the look-alike together is "mixed" (see brandAttributionOfFields).
 * Each field (title, snippet…) is examined on its own.
 */
export function similarNameSetAside(fields: BrandField[], domain: string, brand: string): { reason: string; matchedContext?: MatchedContext } | null {
  if (isShortAmbiguousName(brand)) {
    const attribution = brandAttributionOfFields(fields, brand);
    const matched = contextOf(fields, attribution.trigger);
    if (attribution.state === 'mixed') return { reason: mixedNameReason(brand, attribution.lookalikes), ...(matched ? { matchedContext: matched } : {}) };
    if (attribution.state === 'other') {
      return { reason: `Names "${attribution.lookalikes.slice(0, 2).join('" and "')}", which is a different name from "${brand}".`, ...(matched ? { matchedContext: matched } : {}) };
    }
  } else if (!mentionsBrandInFields(fields, brand) && fields.some((field) => mentionsBrandLoosely(field.text, brand))) {
    return { reason: `The name appears only in a form that is not "${brand}".` };
  }
  if (domainResemblesBrand(domain, brand)) {
    return { reason: `The web address ${domain} resembles the name but is not an exact match, so it was not treated as the brand's site.` };
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
    const fields: BrandField[] = [
      { name: 'title', text: title },
      { name: 'snippet', text },
    ];
    const named = mentionsBrandInFields(fields, options.brand);
    if (domainBelongsToBrand(domain, options.brand)) {
      // A page on the brand's own address that also names the brand is what establishes the address.
      if (named) options.onBrandDomain?.(domain);
      if (!options.allowBrandDomain) continue; // the brand's own pages are not independent evidence
    }
    if (text.length < 40) continue;
    // An item that names the brand together with a look-alike ("COS to COSRX") is unverified: it is never evidence about
    // the brand, whatever else it says. Only short ambiguous names are examined; the brand's own pages are not.
    if (named && !domainBelongsToBrand(domain, options.brand)) {
      const attribution = brandAttributionOfFields(fields, options.brand);
      if (attribution.state === 'mixed') {
        const matched = contextOf(fields, attribution.trigger);
        options.onSetAside?.({ title: clip(title, 120), url: result.url, domain, reason: mixedNameReason(options.brand, attribution.lookalikes), ...(matched ? { matchedContext: matched } : {}) });
        continue;
      }
    }
    if (!named) {
      const similar = similarNameSetAside(fields, domain, options.brand);
      if (similar !== null) options.onSetAside?.({ title: clip(title, 120), url: result.url, domain, ...similar });
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
