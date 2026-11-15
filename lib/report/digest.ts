import 'server-only';
import { readablePages, sourceLabel } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { sameBrand } from '../evidence/brand-match';
import { clip } from '../evidence/normalize';
import { placementOf, verifiedRecommendations } from '../scoring/visibility';
import type { EvidenceItem, GeminiAnswer, InsightEvidence, Metric, Placement, SitePage } from '../types';
import type { Core } from './core';

// The evidence index is the single list of things an insight is allowed to cite.
// Anything Gemini cites that is not in this index is discarded by the callers.

export type EvidenceFamily = 'gemini' | 'audience' | 'site' | 'source';

export interface EvidenceIndex {
  has(id: string): boolean;
  family(id: string): EvidenceFamily | null;
  toInsight(id: string): InsightEvidence | null;
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
  return metric.status === 'scored' ? metric.score : `insufficient data (${metric.reason})`;
}

export function buildEvidenceIndex(data: JobData, core: Core): EvidenceIndex {
  const answers = new Map<string, GeminiAnswer>();
  for (const answer of data.answers ?? []) if (answer.status === 'answered') answers.set(answer.id, answer);
  if (data.signature && data.signature.status === 'answered') answers.set('GS', data.signature);
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
  return {
    scores: {
      gemini_api_recommendation_visibility: metricForDigest(core.visibility.metric),
      audience_perception: metricForDigest(core.perception.metric),
      content_gap_severity_higher_is_worse: metricForDigest(core.contentGap.metric),
    },
    ai_model: {
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
      praise_themes: core.perception.praise.map((t) => ({ label: t.label, summary: t.summary, evidence_ids: t.evidenceIds })),
      complaint_themes: core.perception.complaints.map((t) => ({ label: t.label, summary: t.summary, evidence_ids: t.evidenceIds })),
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
      positioning: core.contentGap.detail.positioning.map((p) => ({ statement: p.statement, page_id: p.ref.pageId })),
      signature_claim: core.contentGap.detail.signatureClaim
        ? { claim: core.contentGap.detail.signatureClaim.claim, page_id: core.contentGap.detail.signatureClaim.ref.pageId }
        : 'none verified',
      checklist: core.contentGap.detail.checklist.map((c) => ({ question_or_concern: c.text, site_coverage: c.level })),
      questions_outside_product_range: core.contentGap.detail.excluded.map((e) => e.question),
    },
  };
}
