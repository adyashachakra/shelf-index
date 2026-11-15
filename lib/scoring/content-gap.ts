// Content gap severity (higher = more severe): pure arithmetic over the coverage checklist.
//
// Checklist = category questions that fit the brand's product range + recurring customer concerns.
// Each item is labeled clear / partial / none against the brand's own site pages.
// Gap points: none 1.0 · partial 0.5 · clear 0
// Score = round(100 × points ÷ checklist size)
// Insufficient data: site not identified, fewer than 3 readable pages, pages could not be
// analysed, or fewer than 4 checklist items.
// Confidence (sample size AND diversity):
//   High = 8+ pages across 3+ site sections · Medium = 5+ pages across 2+ sections · Low otherwise

import type { ChecklistItem, ConfidenceLevel, Metric } from '../types';

export const MIN_READABLE_PAGES = 3;
export const MIN_CHECKLIST_ITEMS = 4;

export function gapPoints(checklist: ChecklistItem[]): number {
  let points = 0;
  for (const item of checklist) {
    if (item.level === 'none') points += 1;
    else if (item.level === 'partial') points += 0.5;
  }
  return points;
}

export interface ContentGapInput {
  domain: string | null;
  pagesRead: number;
  sections: string[];
  analysisAvailable: boolean;
  checklist: ChecklistItem[];
}

export function scoreContentGap(input: ContentGapInput): Metric {
  if (!input.domain) {
    return { status: 'insufficient', reason: "The brand's official website could not be identified with confidence." };
  }
  if (input.pagesRead < MIN_READABLE_PAGES) {
    return {
      status: 'insufficient',
      reason: `Only ${input.pagesRead} readable page${input.pagesRead === 1 ? '' : 's'} could be retrieved from ${input.domain} (at least ${MIN_READABLE_PAGES} are needed).`,
    };
  }
  if (!input.analysisAvailable) {
    return { status: 'insufficient', reason: `Pages from ${input.domain} were retrieved but could not be analysed.` };
  }
  if (input.checklist.length < MIN_CHECKLIST_ITEMS) {
    return {
      status: 'insufficient',
      reason: `Only ${input.checklist.length} checklist question${input.checklist.length === 1 ? '' : 's'} fit this brand's product range (at least ${MIN_CHECKLIST_ITEMS} are needed).`,
    };
  }
  const score = Math.round((100 * gapPoints(input.checklist)) / input.checklist.length);
  let confidence: ConfidenceLevel = 'low';
  if (input.pagesRead >= 8 && input.sections.length >= 3) confidence = 'high';
  else if (input.pagesRead >= 5 && input.sections.length >= 2) confidence = 'medium';
  return {
    status: 'scored',
    score,
    confidence,
    confidenceReason: `${input.pagesRead} pages read across ${input.sections.length} site section${input.sections.length === 1 ? '' : 's'}; ${input.checklist.length} checklist items. Based on pages a search surfaced, not a full crawl.`,
  };
}
