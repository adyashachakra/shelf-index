// Who is this brand, in this category? Pure functions, no network.
//
// An audit about a brand is only meaningful if the brand it researched is the brand that was asked
// about. Two independent signals can establish that:
//   1. Gemini recognises the brand in the selected category (its own description, given with no sources);
//   2. a web address whose registered name is the brand's name appears in the search results.
// With neither, the audit stops before the expensive stages instead of reporting on whatever happens
// to share the name.

import { domainBelongsToBrand, isShortAmbiguousName } from './brand-match';
import type { BrandProfile, IdentityData, IdentitySection, IdentityStatus, Metric, SetAsideEvidence } from '../types';

/** The first domain in the list that strictly belongs to the brand, or null. */
export function firstVerifiedDomain(domains: readonly string[], brand: string): string | null {
  for (const domain of domains) {
    if (domain !== '' && domainBelongsToBrand(domain, brand)) return domain;
  }
  return null;
}

/**
 * The identity decision.
 *   profile null       Gemini's description could not be retrieved: identity was not checked, the audit goes on.
 *   recognised         Gemini recognises the brand in this category: the audit goes on.
 *   domain_verified    Gemini does not, but a strictly matching web address was found: the audit goes on, with warnings.
 *   failed             neither: the audit stops.
 */
export function decideIdentity(profile: BrandProfile | null | undefined, searchDomains: readonly string[], brand: string, category: string, searched = true): IdentityData {
  if (profile === null || profile === undefined) {
    return {
      status: 'unchecked',
      geminiRecognised: null,
      verifiedDomain: firstVerifiedDomain(searchDomains, brand),
      reason: `Gemini's description of ${brand} could not be retrieved, so whether it is recognised in this category was not checked.`,
    };
  }
  if (profile.recognized) {
    const own = profile.officialDomain !== '' && domainBelongsToBrand(profile.officialDomain, brand) ? profile.officialDomain : null;
    return {
      status: 'recognised',
      geminiRecognised: true,
      verifiedDomain: own ?? firstVerifiedDomain(searchDomains, brand),
      reason: `Gemini recognised ${brand} in the ${category} category.`,
    };
  }
  const verified = firstVerifiedDomain(searchDomains, brand);
  if (verified !== null) {
    return {
      status: 'domain_verified',
      geminiRecognised: false,
      verifiedDomain: verified,
      reason: `Gemini did not recognise ${brand} in the ${category} category, but a website whose address matches the name (${verified}) appeared in the search results.`,
    };
  }
  return {
    status: 'failed',
    geminiRecognised: false,
    verifiedDomain: null,
    reason: searched
      ? `Gemini did not recognise ${brand} in the ${category} category, and no website whose address matches the name was found.`
      : `Gemini did not recognise ${brand} in the ${category} category, and the search that looks for a website matching the name could not be run, so the brand could not be verified.`,
  };
}

/** Shown to the visitor when an audit stops on identity. "reason" is the decision's own statement of what was and was not found. */
export function identityStopMessage(reason: string, slotsReturned: boolean): string {
  return (
    `Brand not recognised in this category. ${reason} ` +
    `This audit stopped before the research stages, and no report was made. Check the spelling and the category, then start again. ` +
    (slotsReturned
      ? 'Nothing was used from the free research quota, and this audit does not count towards the daily limits.'
      : 'Unused research credits were returned. The one search that looked for the brand\'s website was used, so this audit still counts towards the daily limits.')
  );
}

const SUMMARY: Record<IdentityStatus, (brand: string, category: string, domain: string | null) => string> = {
  recognised: (brand, category) => `Gemini recognised ${brand} in the ${category} category, so the brand-specific findings below are about the brand that was asked about.`,
  domain_verified: (brand, category, domain) =>
    `Gemini did not recognise ${brand} in the ${category} category. The audit went ahead because a website whose address matches the name (${domain ?? 'unknown'}) was found. ` +
    `Gemini API recommendation visibility is not shown, because a score would not mean anything for a brand Gemini does not know in this category, and confidence in the other findings is limited.`,
  unchecked: (brand) => `Gemini's description of ${brand} could not be retrieved, so whether the brand is recognised in this category was not checked. Confidence is limited accordingly.`,
};

export function identitySection(identity: IdentityData, brand: string, category: string, setAside: SetAsideEvidence[]): IdentitySection | undefined {
  if (identity.status === 'failed') return undefined; // an audit that stopped has no report
  return {
    status: identity.status,
    geminiRecognised: identity.geminiRecognised,
    verifiedDomain: identity.verifiedDomain,
    summary: SUMMARY[identity.status](brand, category, identity.verifiedDomain),
    setAside: setAside.slice(0, 20),
    setAsideCount: setAside.length,
  };
}

/** What each identity state allows the report to say about confidence: the highest level any metric may show. */
export function confidenceCeiling(status: IdentityData['status'] | undefined): 'high' | 'medium' | 'low' {
  if (status === 'domain_verified') return 'low';
  if (status === 'unchecked') return 'medium';
  return 'high';
}

/**
 * Gemini did not recognise the brand in this category and the audit went on only because a matching web
 * address was found. In that state the brand's visibility cannot be scored, and the brands Gemini
 * recommended are not treated as the brand's verified competitors.
 */
export function brandNotRecognised(identity: IdentityData | undefined): boolean {
  return identity?.status === 'domain_verified';
}

/** Does the evidence about this brand need the stricter reading (a short name, or a brand Gemini does not know)? */
export function needsStrictIdentity(brand: string, identity: IdentityData | undefined): boolean {
  return isShortAmbiguousName(brand) || brandNotRecognised(identity);
}

const LEVEL_ORDER = { low: 0, medium: 1, high: 2 } as const;

/** Why a metric's confidence was lowered because of who the brand was established to be. */
export function ceilingReason(status: IdentityData['status'] | undefined): string {
  if (status === 'domain_verified') {
    return 'Confidence is capped at low because Gemini did not recognise the brand in this category and it was identified only from its website address.';
  }
  return 'Confidence is capped at medium because whether Gemini recognises the brand in this category could not be checked.';
}

/** Lowers a scored metric's confidence to the ceiling the brand's identity allows, and says why. Other metrics pass through. */
export function capConfidence<M extends Metric>(metric: M, status: IdentityData['status'] | undefined): M {
  if (metric.status !== 'scored') return metric;
  const ceiling = confidenceCeiling(status);
  if (LEVEL_ORDER[metric.confidence] <= LEVEL_ORDER[ceiling]) return metric;
  return { ...metric, confidence: ceiling, confidenceReason: `${metric.confidenceReason} ${ceilingReason(status)}` };
}

export const MAX_SET_ASIDE = 30;

/** Adds an entry unless that address is already listed, up to a cap. */
export function addSetAside(list: SetAsideEvidence[], entry: SetAsideEvidence): void {
  if (list.length >= MAX_SET_ASIDE || list.some((existing) => existing.url === entry.url)) return;
  list.push(entry);
}
