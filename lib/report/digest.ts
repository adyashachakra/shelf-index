import { isLeftOut } from '../evidence/relevance';
import 'server-only';
import { readablePages, sourceLabel } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { sameBrand } from '../evidence/brand-match';
import { brandNotRecognised } from '../evidence/identity';
import { clip } from '../evidence/normalize';
import { normalizeForMatch } from '../evidence/quotes';
import { placementOf, verifiedRecommendations } from '../scoring/visibility';
import type { EvidenceItem, GeminiAnswer, InsightEvidence, Metric, Placement, PositioningStatement, SitePage } from '../types';
import type { Core } from './core';

// The evidence index is the single list of things an insight is allowed to cite.
// Anything Gemini cites that is not in this index is discarded by the callers.

export type EvidenceFamily = 'gemini' | 'audience' | 'site' | 'source';

export interface EvidenceIndex {
  has(id: string): boolean;
  family(id: string): EvidenceFamily | null;
  toInsight(id: string): InsightEvidence | null;
  /** How many separate threads, pages or videos these audience ids come from. */
  audienceSources(ids: string[]): number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How much evidence a statement rests on, counted in code and shown next to it, so a reader can
 * see when a recommendation stands on two customer comments and when it stands on twenty.
 */
export function describeEvidenceBase(ids: string[], index: EvidenceIndex): string {
  const unique = [...new Set(ids)];
  const audience = index.audienceSources(unique.filter((id) => index.family(id) === 'audience'));
  const gemini = unique.filter((id) => index.family(id) === 'gemini').length;
  const site = unique.filter((id) => index.family(id) === 'site').length;
  const other = unique.filter((id) => index.family(id) === 'source').length;
  const audienceExcerpts = unique.filter((id) => index.family(id) === 'audience').length;
  const parts: string[] = [];
  // Sources are counted by thread, page or video, not by excerpt: two comments under one video are one source.
  // When there are more excerpts than sources, both numbers are shown so the two can never look like a conflict.
  if (audience > 0) {
    const excerpts = audienceExcerpts > audience ? ` (${audienceExcerpts} excerpts in total)` : '';
    parts.push(`${plural(audience, 'customer or reviewer source', 'customer or reviewer sources')}${excerpts}`);
  }
  if (gemini > 0) parts.push(plural(gemini, 'Gemini answer', 'Gemini answers'));
  if (site > 0) parts.push(plural(site, "page of the brand's own site", "pages of the brand's own site"));
  if (other > 0) parts.push(plural(other, 'other web source', 'other web sources'));
  return parts.length > 0 ? parts.join(', ') : 'no evidence';
}

export function describePlacement(placement: Placement): string {
  switch (placement.kind) {
    case 'recommended':
      return `recommended, position ${placement.position}`;
    case 'mentioned':
      return 'named but not recommended';
    case 'cautioned':
      return 'cautioned against';
    default:
      return 'not named';
  }
}

function metricForDigest(metric: Metric): number | string {
  if (metric.status === 'not_recognised') return 'not shown: the brand was not recognised in this category';
  return metric.status === 'scored' ? metric.score : `insufficient data (${metric.reason})`;
}

export function buildEvidenceIndex(data: JobData, core: Core): EvidenceIndex {
  const answers = new Map<string, GeminiAnswer>();
  // Gemini's answers are about the brands it recommended. When it did not recognise the audited brand, nothing in
  // them is evidence about that brand, so none of it can be cited by a comparison or a recommendation.
  if (!brandNotRecognised(data.identity)) {
    for (const answer of data.answers ?? []) if (answer.status === 'answered') answers.set(answer.id, answer);
    if (data.signature && data.signature.status === 'answered') answers.set('GS', data.signature);
  }
  const profile = data.profile && data.profile.recognized && data.profile.description !== '' ? data.profile : null;

  const audience = new Map<string, EvidenceItem>(core.items.map((item) => [item.id, item]));
  const pages = new Map<string, SitePage>(readablePages(data.site?.pages ?? []).map((p) => [p.id, p]));
  const sources = new Map<string, EvidenceItem>((data.claims?.sources ?? []).map((s) => [s.id, s]));

  const family = (id: string): EvidenceFamily | null => {
    if (answers.has(id) || (id === 'GP' && profile !== null)) return 'gemini';
    if (audience.has(id)) return 'audience';
    if (pages.has(id)) return 'site';
    if (sources.has(id)) return 'source';
    return null;
  };

  return {
    has: (id) => family(id) !== null,
    family,
    audienceSources(ids) {
      const seen = new Set<string>();
      for (const id of ids) {
        const item = audience.get(id);
        if (item) seen.add(item.sourceUrl || item.url);
      }
      return seen.size;
    },
    toInsight(id) {
      const answer = answers.get(id);
      if (answer) return { id, label: `Gemini, asked: "${answer.question}"`, quote: clip(answer.answer ?? '', 220) };
      if (id === 'GP' && profile) return { id, label: "Gemini's own description of the brand", quote: clip(profile.description, 220) };
      const item = audience.get(id) ?? sources.get(id);
      if (item) return { id, label: `${sourceLabel(item)}: ${clip(item.title, 90)}`, url: item.url, quote: clip(item.text, 200) };
      const page = pages.get(id);
      if (page) return { id, label: `Brand site: ${clip(page.title || page.url, 90)}`, url: page.url };
      return null;
    },
  };
}

export interface SiteStatement extends PositioningStatement {
  /** P1, P2, ... An id for the statement itself, so a comparison can point at the exact words. */
  id: string;
}

/**
 * What the brand says about itself on its own pages: the verified positioning statements and
 * the signature claim. Each already carries a quote that was found on the page. They get ids
 * here so that a complaint can be set against one exact statement, not against a whole page.
 */
export function siteStatements(core: Core): SiteStatement[] {
  const out: SiteStatement[] = [];
  const add = (statement: string, ref: PositioningStatement['ref']) => {
    if (out.some((existing) => normalizeForMatch(existing.statement) === normalizeForMatch(statement))) return;
    out.push({ id: `P${out.length + 1}`, statement, ref });
  };
  for (const entry of core.contentGap.detail.positioning) add(entry.statement, entry.ref);
  const claim = core.contentGap.detail.signatureClaim;
  if (claim) add(claim.claim, claim.ref);
  return out;
}

/** A compact, id-tagged summary of everything gathered, for the synthesis prompts. */
export function buildDigest(meta: JobMeta, data: JobData, core: Core): Record<string, unknown> {
  const labelById = new Map((data.labels?.labels ?? []).map((l) => [l.id, l]));
  const cited = new Set<string>();
  for (const theme of [...core.perception.praise, ...core.perception.complaints]) theme.evidenceIds.forEach((id) => cited.add(id));
  for (const concern of core.perception.concerns) concern.evidenceIds.forEach((id) => cited.add(id));

  const relevantItems = core.items.filter((item) => labelById.get(item.id)?.relevant === true);
  const ordered = [...relevantItems.filter((i) => cited.has(i.id)), ...relevantItems.filter((i) => !cited.has(i.id))].slice(0, 26);

  const answers = (data.answers ?? []).map((answer) => {
    if (answer.status !== 'answered') return { id: answer.id, question: answer.question, result: 'no answer from the AI model (missing data)' };
    const placement = placementOf(answer, meta.brand);
    const own = verifiedRecommendations(answer).find((r) => sameBrand(r.brand, meta.brand));
    return {
      id: answer.id,
      question: answer.question,
      audited_brand: describePlacement(placement),
      recommended_brands: verifiedRecommendations(answer)
        .slice(0, 5)
        .map((r) => r.brand),
      said_about_audited_brand: own?.why ?? '',
    };
  });

  const profile = data.profile;
  const signature = data.signature;
  const notRecognised = brandNotRecognised(data.identity);
  return {
    scores: {
      gemini_api_recommendation_visibility: metricForDigest(core.visibility.metric),
      audience_perception: metricForDigest(core.perception.metric),
      content_gap_severity_higher_is_worse: metricForDigest(core.contentGap.metric),
    },
    ai_model: notRecognised
      ? 'not used: Gemini did not recognise the audited brand in this category, so what it said in answer to the shopper questions concerns other brands and is not evidence about this one'
      : {
      answers,
      description:
        profile && profile.recognized
          ? {
              id: 'GP',
              description: profile.description,
              known_for: profile.knownFor,
              products: profile.products,
              criticisms: profile.criticisms,
            }
          : 'the AI model did not recognise the brand or gave no description',
      signature_claim_question:
        signature && signature.status === 'answered'
          ? {
              id: 'GS',
              question: signature.question,
              audited_brand: describePlacement(placementOf(signature, meta.brand)),
              recommended_brands: verifiedRecommendations(signature)
                .slice(0, 5)
                .map((r) => r.brand),
            }
          : 'not asked',
      claim_checks: (data.claims?.claims ?? []).map((c) => ({
        claim: c.text,
        said_in: c.origin,
        verdict: c.verdict,
        evidence_id: c.evidenceId ?? '',
      })),
    },
    audience: {
      counted_opinions: core.perception.detail.raw,
      unique_sources_read: core.perception.detail.uniqueSources,
      praise_themes: core.perception.praise.map((t) => ({ label: t.label, summary: t.summary, evidence_ids: t.evidenceIds, reported_by_sources: t.sourceCount })),
      complaint_themes: core.perception.complaints.map((t) => ({
        label: t.label,
        summary: t.summary,
        evidence_ids: t.evidenceIds,
        reported_by_sources: t.sourceCount,
        about: t.scope === 'product' ? `one product: ${t.product ?? ''}` : t.scope === 'brand' ? 'the brand in general' : 'not clear',
      })),
      customer_concerns: core.perception.concerns.map((c) => ({ label: c.label, evidence_ids: c.evidenceIds })),
      evidence: ordered.map((item) => ({
        id: item.id,
        source: sourceLabel(item),
        voice: labelById.get(item.id)?.voice ?? 'unclear',
        sentiment: labelById.get(item.id)?.sentiment ?? 'neutral',
        text: clip(item.text, 240),
      })),
    },
    brand_site: {
      domain: core.contentGap.detail.domain ?? 'not identified',
      product_lines: core.contentGap.detail.productLines.map((l) => ({ name: l.name, page_id: l.ref.pageId })),
      positioning: siteStatements(core).map((p) => ({ statement_id: p.id, statement: p.statement, page_id: p.ref.pageId })),
      signature_claim: core.contentGap.detail.signatureClaim
        ? { claim: core.contentGap.detail.signatureClaim.claim, page_id: core.contentGap.detail.signatureClaim.ref.pageId }
        : 'none verified',
      checklist: core.contentGap.detail.checklist.map((c) => ({ question_or_concern: c.text, site_coverage: isLeftOut(c) ? 'could not be assessed' : c.level })),
      questions_outside_brand_range: core.contentGap.detail.excluded.map((e) => e.question),
    },
  };
}
