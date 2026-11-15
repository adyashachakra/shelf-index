import 'server-only';
import { audienceItems, readablePages } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
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

/**
 * Questions that fall outside the brand's product range, with the evidence-backed reason.
 * A question can only be listed here when the brand's own site was read (enough pages) and at
 * least one product line was verified by a quote from it. The visibility formula adds one more
 * condition: the brand must not have been named in that question's answer.
 */
export function outOfRangeQuestions(data: JobData): Map<string, string> {
  const out = new Map<string, string>();
  const analysis = data.siteAnalysis;
  const site = data.site;
  if (!analysis?.available || !site?.domain) return out;
  if (readablePages(site.pages).length < MIN_READABLE_PAGES || analysis.productLines.length < 1) return out;
  const lines = analysis.productLines
    .slice(0, 6)
    .map((l) => l.name)
    .join(', ');
  for (const entry of analysis.relevance) {
    if (entry.fit !== 'out_of_range') continue;
    if (!(data.questions ?? []).some((q) => q.id === entry.questionId)) continue;
    const reason = entry.reason !== '' ? entry.reason.replace(/[.\s]+$/, '') : 'Outside the product range';
    out.set(entry.questionId, `${reason}. ${site.domain} shows these product lines: ${lines}.`);
    if (out.size >= MAX_RANGE_EXCLUSIONS) break;
  }
  return out;
}

export function computeCore(meta: JobMeta, data: JobData): Core {
  const answers = data.answers ?? [];
  const outOfRange = outOfRangeQuestions(data);
  const visibility = scoreVisibility({ brand: meta.brand, answers, outOfRange });
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
      'Fewer than three recurring themes are listed where the evidence did not support more: a theme needs at least two separate sources.';
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
      const rangeReason = outOfRange.get(question.id);
      if (rangeReason !== undefined && named !== true) {
        excluded.push({ questionId: question.id, question: question.text, reason: rangeReason });
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
      points: gapPoints(checklist),
    },
  };

  return { items, visibility, perception, contentGap, countedQuestionIds };
}
