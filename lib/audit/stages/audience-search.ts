import 'server-only';
import { canonicalUrl, SOCIAL_DOMAINS } from '../../evidence/normalize';
import { addSetAside, decideIdentity } from '../../evidence/identity';
import type { SetAsideEvidence } from '../../types';
import { StopSignal, type StageContext } from '../context';
import { resultsToEvidence } from '../evidence-builders';
import type { AudienceData } from '../job';

/**
 * Stage 3: identify the brand, then find what people say. Two Tavily searches (1 credit each):
 *  - Reddit threads as indexed by Tavily's search (Reddit itself is never scraped)
 *  - independent reviews, forums and publications, excluding social platforms and the brand's own site
 * Either search can fail without stopping the audit.
 *
 * The brand is identified here, from two independent signals: Gemini's own description (stage 2) and a
 * web address that strictly matches the brand's name in the search results. When Gemini does not
 * recognise the brand, the reviews search runs FIRST (it is the one that can show the brand's own
 * address), and if no matching address turns up the audit stops before the second search and before
 * any of the eight shopper questions. Nothing new is searched for this: it is the same search, earlier.
 */
export async function runAudienceSearch(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta } = ctx;
  const audience: AudienceData = ctx.data.audience ?? {
    discussionsDone: false,
    reviewsDone: false,
    items: [],
    brandDomains: [],
    setAside: [],
  };
  audience.setAside ??= [];
  const setAside: SetAsideEvidence[] = audience.setAside;
  const seen = new Set(audience.items.map((i) => canonicalUrl(i.url)));
  const noteBrandDomain = (domain: string) => {
    if (!audience.brandDomains.includes(domain)) audience.brandDomains.push(domain);
  };
  const profile = ctx.data.profile;
  const unrecognised = profile !== undefined && profile !== null && !profile.recognized;

  const runDiscussions = async () => {
    if (audience.discussionsDone) return;
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
        onSetAside: (entry) => addSetAside(setAside, entry),
      });
      outcome.entry.kept = items.length;
      audience.items.push(...items);
    } else {
      ctx.warn('Reddit-indexed discussions could not be searched, so they are missing from this audit.');
    }
    audience.discussionsDone = true;
    await ctx.save('audience', audience);
  };

  const runReviews = async (): Promise<'continue' | null> => {
    if (audience.reviewsDone) return null;
    if (ctx.timeLeft() < 12_000) return 'continue';
    const knownDomain = profile?.officialDomain;
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
        onSetAside: (entry) => addSetAside(setAside, entry),
      });
      outcome.entry.kept = items.length;
      audience.items.push(...items);
    } else {
      ctx.warn('Independent reviews could not be searched, so they are missing from this audit.');
    }
    audience.reviewsDone = true;
    audience.reviewsSearched = outcome !== null;
    await ctx.save('audience', audience);
    return null;
  };

  const decide = async () => {
    if (ctx.data.identity) return;
    const identity = decideIdentity(profile, audience.brandDomains, meta.brand, meta.categoryLabel, audience.reviewsSearched !== false);
    await ctx.save('identity', identity);
    if (identity.status === 'failed') {
      ctx.note('audience', 'The brand could not be identified in this category');
      throw new StopSignal('identity', identity.reason);
    }
    if (identity.status === 'domain_verified') {
      ctx.warn(`Gemini did not recognise ${meta.brand} in this category. The audit went on because a website matching the name (${identity.verifiedDomain}) was found, so its findings are limited.`);
    } else if (identity.status === 'unchecked') {
      ctx.warn(`Whether Gemini recognises ${meta.brand} in this category was not checked, so confidence in the findings is limited.`);
    }
  };

  if (unrecognised) {
    if ((await runReviews()) === 'continue') return 'continue';
    await decide(); // stops here, before the second search, when no matching website was found
    await runDiscussions();
  } else {
    await runDiscussions();
    if ((await runReviews()) === 'continue') return 'continue';
    await decide();
  }

  const discussions = audience.items.filter((i) => i.kind === 'discussion').length;
  const reviews = audience.items.filter((i) => i.kind === 'review').length;
  ctx.note('audience', `${discussions} discussion thread${discussions === 1 ? '' : 's'} and ${reviews} independent page${reviews === 1 ? '' : 's'} name the brand`);
  return 'done';
}
