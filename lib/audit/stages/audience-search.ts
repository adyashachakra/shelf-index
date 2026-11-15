import 'server-only';
import { canonicalUrl, SOCIAL_DOMAINS } from '../../evidence/normalize';
import type { StageContext } from '../context';
import { resultsToEvidence } from '../evidence-builders';
import type { AudienceData } from '../job';

/**
 * Stage 4: find what people say. Two Tavily searches (1 credit each):
 *  - Reddit threads as indexed by Tavily's search (Reddit itself is never scraped)
 *  - independent reviews, forums and publications, excluding social platforms and the brand's own site
 * Either search can fail without stopping the audit.
 */
export async function runAudienceSearch(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta } = ctx;
  const audience: AudienceData = ctx.data.audience ?? {
    discussionsDone: false,
    reviewsDone: false,
    items: [],
    brandDomains: [],
  };
  const seen = new Set(audience.items.map((i) => canonicalUrl(i.url)));
  const noteBrandDomain = (domain: string) => {
    if (!audience.brandDomains.includes(domain)) audience.brandDomains.push(domain);
  };

  if (!audience.discussionsDone) {
    const outcome = await ctx.search('Customer discussions', 'reddit.com, as indexed by Tavily', {
      query: `"${meta.brand}" ${meta.categoryNoun} reviews experiences`,
      maxResults: 10,
      includeDomains: ['reddit.com'],
    });
    if (outcome) {
      const items = resultsToEvidence({
        results: outcome.results,
        kind: 'discussion',
        prefix: 'D',
        brand: meta.brand,
        startIndex: 0,
        seenUrls: seen,
      });
      outcome.entry.kept = items.length;
      audience.items.push(...items);
    } else {
      ctx.warn('Reddit-indexed discussions could not be searched, so they are missing from this audit.');
    }
    audience.discussionsDone = true;
    await ctx.save('audience', audience);
  }

  if (!audience.reviewsDone) {
    if (ctx.timeLeft() < 12_000) return 'continue';
    const knownDomain = ctx.data.profile?.officialDomain;
    const outcome = await ctx.search('Independent reviews, forums and publications', 'open web, excluding social platforms and the brand site', {
      query: `${meta.brand} ${meta.categoryNoun} review honest opinion forum`,
      maxResults: 10,
      excludeDomains: [...SOCIAL_DOMAINS, 'reddit.com', 'youtube.com', ...(knownDomain ? [knownDomain] : [])],
    });
    if (outcome) {
      const items = resultsToEvidence({
        results: outcome.results,
        kind: 'review',
        prefix: 'R',
        brand: meta.brand,
        startIndex: 0,
        seenUrls: seen,
        onBrandDomain: noteBrandDomain,
      });
      outcome.entry.kept = items.length;
      audience.items.push(...items);
    } else {
      ctx.warn('Independent reviews could not be searched, so they are missing from this audit.');
    }
    audience.reviewsDone = true;
    await ctx.save('audience', audience);
  }

  const discussions = audience.items.filter((i) => i.kind === 'discussion').length;
  const reviews = audience.items.filter((i) => i.kind === 'review').length;
  ctx.note('audience', `${discussions} discussion thread${discussions === 1 ? '' : 's'} and ${reviews} independent page${reviews === 1 ? '' : 's'} name the brand`);
  return 'done';
}
