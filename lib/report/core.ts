import 'server-only';
import { audienceItems, readablePages } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { clip } from '../evidence/normalize';
import { isLeftOut } from '../evidence/relevance';
import { findStatedPricePositions, questionPriceTier, questionTierPhrase, sourceIndependence, sourceSiteKey, tierPhrase, tiersConflict, tierWordsIn } from '../evidence/price';
import { scoreContentGap, gapPoints, MIN_CHECKLIST_ITEMS, MIN_READABLE_PAGES } from '../scoring/content-gap';
import { scorePerception } from '../scoring/perception';
import { scoreVisibility } from '../scoring/visibility';
import type {
  ChecklistItem,
  ConfidenceLevel,
  ContentGapSection,
  EvidenceItem,
  ExcludedQuestion,
  Metric,
  PerceptionSection,
  PricePosition,
  PriceSupport,
  ProductRangeAssessment,
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
  sources?: { domain: string; url: string; quote: string }[];
}

/**
 * What the audit can say about the brand's price position, and how well it is supported.
 * Four places can supply a statement of it:
 *   1. the brand's own pages (a passage the analysis pointed to, checked against the page);
 *   2. an independent source in the audience evidence (same check);
 *   3. a statement of Gemini's about price that a source supported, with the price word in the quote;
 *   4. the title of a retrieved source that names the brand and states one price tier, read
 *      directly by this code with no model involved.
 * Gemini's own opinion of the brand's price level is never used: it is not evidence about the brand.
 *
 * Counting rules, which decide whether a question may be left out on price:
 *   - Pages are counted by site: several pages of one domain are ONE source.
 *   - The brand's own site may be one of the two, but a second, different domain is needed, and at
 *     least one source must be genuinely independent of the brand. Press releases, corporate
 *     announcements and company-owned material (including a parent company's) are set aside and
 *     never count as independent evidence. If independence cannot be shown, the position stays unestablished.
 *   - A YouTube viewer comment is never counted: it is one person's passing remark.
 *   - Sources that name different tiers establish nothing.
 *   - One source is reported as "insufficient", not used.
 */
export function priceSupport(brand: string, data: JobData): PriceSupport {
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
  for (const stated of findStatedPricePositions(titled, brand)) {
    found.push({
      tier: stated.tier,
      origin: 'independent_source',
      evidenceId: stated.item.id,
      url: stated.item.sourceUrl || stated.item.url,
      domain: stated.item.domain,
      quote: clip(stated.quote, 200),
    });
  }

  // A viewer comment (evidence ids starting with "C") is set aside before anything is counted.
  const counted = found
    .filter((entry) => !entry.evidenceId.startsWith('C'))
    .map((entry) => (entry.origin === 'brand_site' && entry.domain === '' ? { ...entry, domain: siteDomain } : entry));
  if (counted.length === 0) return { status: 'none', tier: null, sources: [] };

  // One entry per site, the most substantial first: the brand's own site, then an article or
  // review, then a discussion thread, then a video.
  const weight = (entry: PricePosition): number => {
    if (entry.origin === 'brand_site') return 0;
    const kind = entry.evidenceId.charAt(0);
    if (kind === 'R' || kind === 'K') return 1;
    if (kind === 'D') return 2;
    if (kind === 'V') return 3;
    return 4;
  };
  // Every domain the brand is known to own: its recorded site, domains seen in the search results that
  // belong to it, and the official site Gemini named. All of them are one source, the brand's own.
  const brandOwned = [siteDomain, ...(data.audience?.brandDomains ?? []), data.profile?.officialDomain ?? ''].filter((d) => d !== '');
  const ownText = (data.site?.pages ?? []).map((page) => page.text).join('\n');
  const bySite = new Map<string, PricePosition>();
  const setAside: NonNullable<PriceSupport['setAside']> = [];
  const setAsideSites = new Set<string>();
  let independent = 0;
  const tiersSeen = new Set<string>(); // every usable statement, including a second page of a site already counted
  for (const entry of [...counted].sort((a, b) => weight(a) - weight(b))) {
    const key = sourceSiteKey(entry.domain, brandOwned) || 'unknown';
    if (setAsideSites.has(key)) continue;
    // The brand's own site counts as one source. Anything else must be independent of the brand:
    // press releases and company material are shown, but never counted.
    const kind = entry.origin === 'brand_site' ? { kind: 'brand' as const } : sourceIndependence({ domain: entry.domain, url: entry.url, quote: entry.quote }, brandOwned, ownText);
    if (kind.kind === 'company_material') {
      setAsideSites.add(key);
      setAside.push({ domain: entry.domain, url: entry.url, quote: entry.quote, tier: entry.tier, reason: kind.reason ?? 'company material' });
      continue;
    }
    tiersSeen.add(entry.tier);
    if (bySite.has(key)) continue;
    if (kind.kind === 'independent') independent += 1;
    bySite.set(key, entry);
  }
  const sources = [...bySite.values()];
  const aside = setAside.length > 0 ? { setAside } : {};
  if (sources.length === 0) return { status: setAside.length > 0 ? 'not_independent' : 'none', tier: null, sources: [], ...aside };
  if (tiersSeen.size > 1) return { status: 'conflicting', tier: null, sources, ...aside };
  // Only the brand's own site is left. With company material set aside, say independence is missing;
  // with nothing else found, it is simply one source.
  if (independent === 0) return { status: setAside.length > 0 ? 'not_independent' : 'insufficient', tier: sources[0].tier, sources, ...aside };
  return { status: sources.length >= 2 ? 'established' : 'insufficient', tier: sources[0].tier, sources, ...aside };
}

/** The brand's price position, only when two independent sources state it; otherwise null. */
export function establishedPricePosition(brand: string, data: JobData): PricePosition | null {
  const support = priceSupport(brand, data);
  return support.status === 'established' ? support.sources[0] : null;
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
      const question = questions.find((q) => q.id === entry.questionId);
      if (!question) continue;
      // A question about a price tier ("luxury", "affordable") is never decided here. The first
      // live V1.1 audit showed why: the model marked the luxury question "out of range" because
      // of how the brand is positioned, which is a price judgement with no source behind it.
      // Such questions are decided only by the price rule below, which needs a source's words.
      if (questionPriceTier(question) !== null) continue;
      // For the same reason, a "kind of product" verdict whose stated reason talks about price is not used.
      if (tierWordsIn(entry.reason) !== null) continue;
      const reason = entry.reason !== '' ? entry.reason.replace(/[.\s]+$/, '') : 'Outside the product range';
      out.set(entry.questionId, { kind: 'product_range', reason: `${reason}. ${site.domain} shows these product lines: ${lines}.` });
    }
  }

  const support = priceSupport(brand, data);
  if (support.status === 'established' && support.tier !== null) {
    const tier = support.tier;
    const shown = support.sources.slice(0, 3);
    const named = shown.map((s) => `${s.origin === 'brand_site' ? "the brand's own site" : s.domain} ("${s.quote}")`).join('; ');
    for (const question of questions) {
      if (out.size >= MAX_RANGE_EXCLUSIONS) break;
      if (out.has(question.id)) continue;
      const asked = questionPriceTier(question);
      if (!asked || !tiersConflict(asked, tier)) continue;
      out.set(question.id, {
        kind: 'price_tier',
        reason: `This question asks about ${questionTierPhrase(asked)} brands. ${shown.length} independent sources describe ${brand} as ${tierPhrase(tier)}: ${named}.`,
        sourceUrl: shown[0].url,
        sources: shown.map((s) => ({ domain: s.origin === 'brand_site' ? (s.domain || "the brand's own site") : s.domain, url: s.url, quote: s.quote })),
      });
    }
  }
  return out;
}

const LOWER: Record<ConfidenceLevel, ConfidenceLevel> = { high: 'medium', medium: 'low', low: 'low' };

/** Lowers a scored content-gap metric's confidence one level when items were left out, and says why. */
function contentGapMetric(metric: Metric, leftOut: number, total: number): Metric {
  if (leftOut === 0) return metric;
  const assessed = total - leftOut;
  if (metric.status === 'insufficient') {
    return assessed < MIN_CHECKLIST_ITEMS && total >= MIN_CHECKLIST_ITEMS
      ? {
          status: 'insufficient',
          reason: `Only ${assessed} of the ${total} checklist items could be assessed (at least ${MIN_CHECKLIST_ITEMS} are needed). ${leftOut} ${leftOut === 1 ? 'was' : 'were'} left out because the evidence could not be tied to the question or the analysis returned no verdict for it.`,
        }
      : metric;
  }
  return {
    ...metric,
    confidence: LOWER[metric.confidence],
    confidenceReason: `${metric.confidenceReason} ${leftOut} of the ${total} checklist items could not be assessed and ${leftOut === 1 ? 'is' : 'are'} left out of the score, so confidence is lowered one level.`,
  };
}

const RANGE_DISCLAIMER = "These are the products found on the pages read. They are not a verified inventory of the brand's complete product range.";

/**
 * What was found about the product range, in three states:
 *   identified   at least one product line was found and confirmed by a quote from a page
 *   partial      product information was found but none of it could be confirmed on a page
 *   not_assessed there is no reliable product information to report
 * Whatever the state, the page count and product count shown are the real ones.
 */
export function productRangeAssessment(analysis: JobData['siteAnalysis'], pagesRead: number): ProductRangeAssessment {
  const linesIdentified = analysis?.available ? analysis.productLines.length : 0;
  const unverified = analysis?.available ? (analysis.productLinesUnverified ?? 0) : 0;
  if (linesIdentified >= 1) {
    const more = unverified > 0 ? ` ${unverified} further candidate${unverified === 1 ? '' : 's'} could not be confirmed on a page and ${unverified === 1 ? 'is' : 'are'} not shown.` : '';
    return { status: 'identified', pagesRead, linesIdentified, unverified, note: `${linesIdentified} product line${linesIdentified === 1 ? ' was' : 's were'} found and confirmed on ${pagesRead} page${pagesRead === 1 ? '' : 's'} read.${more} ${RANGE_DISCLAIMER}` };
  }
  if (unverified >= 1) {
    return { status: 'partial', pagesRead, linesIdentified: 0, unverified, note: `${unverified} product candidate${unverified === 1 ? ' was' : 's were'} identified on the ${pagesRead} page${pagesRead === 1 ? '' : 's'} read but could not be fully verified against a page, so none is listed. ${RANGE_DISCLAIMER}` };
  }
  return { status: 'not_assessed', pagesRead, linesIdentified: 0, unverified: 0, note: `No reliable product information could be confirmed from the ${pagesRead} page${pagesRead === 1 ? '' : 's'} read. ${RANGE_DISCLAIMER}` };
}

function relevanceFields(coverage: NonNullable<JobData['siteAnalysis']>['coverage'][number] | undefined) {
  return {
    ...(coverage?.relevance ? { relevance: coverage.relevance } : {}),
    ...(coverage?.evidenceAbout ? { evidenceAbout: coverage.evidenceAbout } : {}),
    ...(coverage?.relevanceNote ? { relevanceNote: coverage.relevanceNote } : {}),
    ...(coverage?.expertEvidence ? { expertEvidence: coverage.expertEvidence } : {}),
    ...(coverage?.brandClaim ? { brandClaim: true } : {}),
  };
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
          ...(exclusion.sources ? { sources: exclusion.sources } : {}),
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
        ...(coverage?.unanswered ? { unanswered: true } : {}),
        ...relevanceFields(coverage),
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
        ...(coverage?.unanswered ? { unanswered: true } : {}),
        ...relevanceFields(coverage),
      });
    }
  }
  // Items that could not be assessed (evidence not tied to the question, or no verdict came back)
  // are left out of the score and lower its confidence one level. They are not counted as "not addressed".
  const scoredChecklist = checklist.filter((item) => !isLeftOut(item));
  const leftOut = checklist.length - scoredChecklist.length;
  const contentGap: ContentGapSection = {
    metric: contentGapMetric(
      scoreContentGap({
        domain: site?.domain ?? null,
        pagesRead: pages.length,
        sections,
        analysisAvailable: analysis?.available === true,
        checklist: scoredChecklist,
      }),
      leftOut,
      checklist.length,
    ),
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
      priceSupport: priceSupport(meta.brand, data),
      productRange: productRangeAssessment(analysis, pages.length),
      points: gapPoints(scoredChecklist),
    },
  };

  return { items, visibility, perception, contentGap, countedQuestionIds };
}
