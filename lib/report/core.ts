import 'server-only';
import { audienceItems, readablePages } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { clip } from '../evidence/normalize';
import { findStatedPricePosition, questionPriceTier, questionTierPhrase, tierPhrase, tiersConflict, tierWordsIn } from '../evidence/price';
import { scoreContentGap, gapPoints, MIN_READABLE_PAGES } from '../scoring/content-gap';
import { scorePerception } from '../scoring/perception';
import { scoreVisibility } from '../scoring/visibility';
import type {
  ChecklistItem,
  ContentGapSection,
  EvidenceItem,
  ExcludedQuestion,
  Metric,
  PerceptionSection,
  PricePosition,
  VisibilityDetail,
} from '../types';

// The three metrics, computed in code from saved answers and labeled evidence.
// Used twice: to brief the synthesis step, and to build the final report.

export interface Core {
  items: EvidenceItem[];
  visibility: { metric: Metric; detail: VisibilityDetail };
  perception: PerceptionSection;
  contentGap: ContentGapSection;
  countedQuestionIds: Set<string>;
}

const MAX_RANGE_EXCLUSIONS = 3;

export interface RangeExclusion {
  kind: 'product_range' | 'price_tier';
  reason: string;
  sourceUrl?: string;
}

/**
 * The brand's price position, if the audit has it in words from a source. Four places can
 * supply it:
 *   1. the brand's own pages (a passage the analysis pointed to, checked against the page);
 *   2. an independent source in the audience evidence (same check);
 *   3. a statement of Gemini's about price that a source supported, with the price word in the quote;
 *   4. the title of a retrieved source that names the brand and states one price tier, read
 *      directly by this code with no model involved.
 * Gemini's own opinion of the brand's price level is never used: it is not evidence about the brand.
 * If two places disagree, nothing is established.
 */
export function establishedPricePosition(brand: string, data: JobData): PricePosition | null {
  const found: PricePosition[] = [];
  if (data.siteAnalysis?.pricePosition) found.push(data.siteAnalysis.pricePosition);
  if (data.labels?.pricePosition) found.push(data.labels.pricePosition);
  for (const claim of data.claims?.claims ?? []) {
    if (claim.verdict !== 'supported' || !claim.quote || !claim.url || !claim.evidenceId) continue;
    const tier = tierWordsIn(claim.quote);
    if (tier !== 'budget' && tier !== 'premium') continue;
    if (tierWordsIn(claim.text) !== tier) continue; // the statement itself must be about that price tier
    const source = (data.claims?.sources ?? []).find((item) => item.id === claim.evidenceId);
    const onBrandSite = (data.site?.pages ?? []).some((page) => page.id === claim.evidenceId);
    found.push({
      tier,
      origin: onBrandSite ? 'brand_site' : 'independent_source',
      evidenceId: claim.evidenceId,
      url: claim.url,
      domain: source?.domain ?? (onBrandSite ? (data.site?.domain ?? '') : ''),
      quote: claim.quote,
    });
  }

  // 4. Source titles. Only material about the brand that the brand did not write: audience
  // evidence labeled relevant, and the pages retrieved to check Gemini's statements.
  const labelById = new Map((data.labels?.labels ?? []).map((label) => [label.id, label]));
  const siteDomain = data.site?.domain ?? '';
  const titled = [
    ...audienceItems(data).filter((item) => labelById.get(item.id)?.relevant === true && labelById.get(item.id)?.voice !== 'brand'),
    ...(data.claims?.sources ?? []).filter((item) => siteDomain === '' || item.domain !== siteDomain),
  ];
  const stated = findStatedPricePosition(titled, brand);
  if (stated) {
    found.push({
      tier: stated.tier,
      origin: 'independent_source',
      evidenceId: stated.item.id,
      url: stated.item.sourceUrl || stated.item.url,
      domain: stated.item.domain,
      quote: clip(stated.quote, 200),
    });
  }

  if (found.length === 0) return null;
  if (new Set(found.map((entry) => entry.tier)).size > 1) return null;
  return found[0];
}

/**
 * Questions that fall outside the brand's range, with the evidence-backed reason. The same two
 * tests run for every category:
 *
 *  1. Kind of product. The brand's own site was read (enough pages), at least one product line
 *     was verified by a quote from it, and the pages show it sells nothing of the kind asked about.
 *  2. Price tier. The question asks about premium brands (or about low-priced ones) and a
 *     retrieved source says in words that the brand sits in the other tier.
 *
 * The scoring formulas add one more condition to both: the brand must not have been named in
 * that question's answer. If Gemini named it, the question counts.
 */
export function outOfRangeQuestions(brand: string, data: JobData): Map<string, RangeExclusion> {
  const out = new Map<string, RangeExclusion>();
  const questions = data.questions ?? [];
  const analysis = data.siteAnalysis;
  const site = data.site;

  if (analysis?.available && site?.domain && readablePages(site.pages).length >= MIN_READABLE_PAGES && analysis.productLines.length >= 1) {
    const lines = analysis.productLines
      .slice(0, 6)
      .map((l) => l.name)
      .join(', ');
    for (const entry of analysis.relevance) {
      if (out.size >= MAX_RANGE_EXCLUSIONS) break;
      if (entry.fit !== 'out_of_range') continue;
      if (!questions.some((q) => q.id === entry.questionId)) continue;
      const reason = entry.reason !== '' ? entry.reason.replace(/[.\s]+$/, '') : 'Outside the product range';
      out.set(entry.questionId, { kind: 'product_range', reason: `${reason}. ${site.domain} shows these product lines: ${lines}.` });
    }
  }

  const position = establishedPricePosition(brand, data);
  if (position) {
    const where = position.origin === 'brand_site' ? "The brand's own site" : `An independent source (${position.domain})`;
    for (const question of questions) {
      if (out.size >= MAX_RANGE_EXCLUSIONS) break;
      if (out.has(question.id)) continue;
      const asked = questionPriceTier(question);
      if (!asked || !tiersConflict(asked, position.tier)) continue;
      out.set(question.id, {
        kind: 'price_tier',
        reason: `This question asks about ${questionTierPhrase(asked)} brands. ${where} describes ${brand} as ${tierPhrase(position.tier)}: "${position.quote}"`,
        sourceUrl: position.url,
      });
    }
  }
  return out;
}

export function computeCore(meta: JobMeta, data: JobData): Core {
  const answers = data.answers ?? [];
  const outOfRange = outOfRangeQuestions(meta.brand, data);
  const visibility = scoreVisibility({
    brand: meta.brand,
    answers,
    outOfRange: new Map([...outOfRange].map(([questionId, exclusion]) => [questionId, exclusion.reason])),
  });
  const countedQuestionIds = new Set(
    visibility.detail.rows.filter((r) => r.state === 'counted').map((r) => r.questionId),
  );

  // ----- audience perception -----
  const items = audienceItems(data);
  const labels = data.labels;
  const scored = scorePerception(items, labels?.available ? labels.labels : []);
  let perceptionMetric = scored.metric;
  if (items.length === 0) {
    perceptionMetric = {
      status: 'insufficient',
      reason: 'No independent discussions, reviews or YouTube comments naming the brand were found.',
    };
  } else if (!labels?.available) {
    perceptionMetric = {
      status: 'insufficient',
      reason: 'Audience evidence was found but could not be analysed in this audit.',
    };
  }
  const detail = scored.detail;
  const enoughToCompare = detail.byVoice.customer >= 3 && detail.byVoice.creator >= 2;
  let themesNote: string | undefined;
  if (labels?.available && ((labels.praise.length < 3) || (labels.complaints.length < 3))) {
    themesNote =
      'A theme is listed only when at least two separate items of evidence show it, which is why fewer than three may appear.';
  }
  const perception: PerceptionSection = {
    metric: perceptionMetric,
    detail,
    praise: labels?.praise ?? [],
    complaints: labels?.complaints ?? [],
    concerns: labels?.concerns ?? [],
    advocacy: labels?.advocacy ?? [],
    creatorVsCustomer: enoughToCompare ? (labels?.creatorVsCustomer ?? '') : '',
    themesNote,
  };

  // ----- content gap -----
  const site = data.site;
  const analysis = data.siteAnalysis;
  const pages = readablePages(site?.pages ?? []);
  const sections = [...new Set(pages.map((p) => p.section))].sort();
  const checklist: ChecklistItem[] = [];
  const excluded: ExcludedQuestion[] = [];
  if (analysis?.available) {
    for (const question of data.questions ?? []) {
      const row = visibility.detail.rows.find((r) => r.questionId === question.id);
      const named = !row || row.state === 'no_answer' ? null : row.placement !== undefined && row.placement.kind !== 'absent';
      const exclusion = outOfRange.get(question.id);
      if (exclusion !== undefined && named !== true) {
        excluded.push({
          questionId: question.id,
          question: question.text,
          kind: exclusion.kind,
          reason: exclusion.reason,
          ...(exclusion.sourceUrl ? { sourceUrl: exclusion.sourceUrl } : {}),
        });
        continue;
      }
      const coverage = analysis.coverage.find((c) => c.itemId === question.id);
      checklist.push({
        id: question.id,
        source: 'category_question',
        text: question.text,
        level: coverage?.level ?? 'none',
        ...(coverage?.url ? { url: coverage.url } : {}),
        ...(coverage?.quote ? { quote: coverage.quote } : {}),
        ...(coverage?.downgraded ? { downgraded: true } : {}),
        geminiNamedBrand: named,
      });
    }
    for (const concern of labels?.concerns ?? []) {
      const coverage = analysis.coverage.find((c) => c.itemId === concern.id);
      checklist.push({
        id: concern.id,
        source: 'customer_concern',
        text: concern.label,
        level: coverage?.level ?? 'none',
        ...(coverage?.url ? { url: coverage.url } : {}),
        ...(coverage?.quote ? { quote: coverage.quote } : {}),
        ...(coverage?.downgraded ? { downgraded: true } : {}),
      });
    }
  }
  const contentGap: ContentGapSection = {
    metric: scoreContentGap({
      domain: site?.domain ?? null,
      pagesRead: pages.length,
      sections,
      analysisAvailable: analysis?.available === true,
      checklist,
    }),
    detail: {
      domain: site?.domain ?? null,
      pagesRead: pages.length,
      sections,
      checklist,
      excluded,
      productLines: analysis?.productLines ?? [],
      positioning: analysis?.positioning ?? [],
      signatureClaim: analysis?.signatureClaim ?? null,
      pricePosition: establishedPricePosition(meta.brand, data),
      points: gapPoints(checklist),
    },
  };

  return { items, visibility, perception, contentGap, countedQuestionIds };
}
