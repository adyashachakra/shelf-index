// Gemini API recommendation visibility: pure arithmetic over Gemini's saved answers.
//
// Per counted question, credit for the brand's placement in that answer:
//   recommended 1st 1.00 · 2nd 0.85 · 3rd 0.70 · 4th 0.55 · 5th 0.45 · 6th or lower 0.35
//   named but not recommended 0.20 · absent or cautioned against 0
// Score = round(100 × sum of credits ÷ counted questions)
//
// Counted = Gemini answered AND the question fits the brand's product range.
//   - A failed Gemini call is missing data: it is left out of the denominator, never scored as zero.
//   - A question is excluded for range only when the caller supplies an evidence-backed reason
//     AND the brand was not named in that answer.
// Fewer than 5 counted questions = insufficient data.

import { mentionsBrand, normalizeName, sameBrand } from '../evidence/brand-match';
import type {
  AnswerRecommendation,
  ConfidenceLevel,
  GeminiAnswer,
  Metric,
  Placement,
  VisibilityDetail,
  VisibilityRow,
} from '../types';

export const POSITION_CREDITS = [1, 0.85, 0.7, 0.55, 0.45];
export const LOWER_POSITION_CREDIT = 0.35;
export const MENTION_CREDIT = 0.2;
export const MIN_COUNTED_QUESTIONS = 5;

/** Recommendations that are actually named in the answer text, in order, without repeats. */
export function verifiedRecommendations(answer: GeminiAnswer): AnswerRecommendation[] {
  const text = answer.answer ?? '';
  const seen = new Set<string>();
  const out: AnswerRecommendation[] = [];
  for (const rec of answer.recommendations ?? []) {
    const key = normalizeName(rec.brand);
    if (key === '' || seen.has(key)) continue;
    if (text !== '' && !mentionsBrand(text, rec.brand)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

export function placementOf(answer: GeminiAnswer, brand: string): Placement {
  if (answer.status !== 'answered') return { kind: 'absent' };
  const recs = verifiedRecommendations(answer);
  const index = recs.findIndex((rec) => sameBrand(rec.brand, brand));
  if (index >= 0) return { kind: 'recommended', position: index + 1 };
  const mention = (answer.alsoMentioned ?? []).find((m) => sameBrand(m.brand, brand));
  if (mention) return mention.stance === 'cautioned' ? { kind: 'cautioned' } : { kind: 'mentioned' };
  if (mentionsBrand(answer.answer ?? '', brand)) return { kind: 'mentioned' };
  return { kind: 'absent' };
}

export function creditFor(placement: Placement): number {
  if (placement.kind === 'recommended') {
    return POSITION_CREDITS[placement.position - 1] ?? LOWER_POSITION_CREDIT;
  }
  if (placement.kind === 'mentioned') return MENTION_CREDIT;
  return 0;
}

function confidenceFor(counted: number): ConfidenceLevel {
  if (counted >= 8) return 'high';
  if (counted >= 6) return 'medium';
  return 'low';
}

export interface VisibilityInput {
  brand: string;
  answers: GeminiAnswer[];
  /** questionId -> evidence-backed reason the question is outside the brand's product range. */
  outOfRange: Map<string, string>;
}

export function scoreVisibility(input: VisibilityInput): { metric: Metric; detail: VisibilityDetail } {
  const rows: VisibilityRow[] = [];
  let creditSum = 0;
  let appearances = 0;
  let positionSum = 0;
  let positionCount = 0;
  const intents = new Set<string>();

  for (const answer of input.answers) {
    const base = {
      answerId: answer.id,
      questionId: answer.questionId,
      question: answer.question,
      intent: answer.intent,
    };
    if (answer.status !== 'answered') {
      rows.push({ ...base, state: 'no_answer', topBrands: [], failureReason: answer.failureReason ?? 'No answer' });
      continue;
    }
    const recs = verifiedRecommendations(answer);
    const topBrands = recs.slice(0, 5).map((r) => r.brand);
    const placement = placementOf(answer, input.brand);
    const rangeReason = input.outOfRange.get(answer.questionId);
    if (rangeReason !== undefined && placement.kind === 'absent') {
      rows.push({ ...base, state: 'excluded', placement, topBrands, exclusionReason: rangeReason });
      continue;
    }
    const credit = creditFor(placement);
    creditSum += credit;
    intents.add(answer.intent);
    if (placement.kind === 'recommended' || placement.kind === 'mentioned') appearances += 1;
    if (placement.kind === 'recommended') {
      positionSum += placement.position;
      positionCount += 1;
    }
    const own = recs.find((r) => sameBrand(r.brand, input.brand));
    rows.push({ ...base, state: 'counted', placement, credit, topBrands, why: own?.why });
  }

  const planned = input.answers.length;
  const failed = rows.filter((r) => r.state === 'no_answer').length;
  const excluded = rows.filter((r) => r.state === 'excluded').length;
  const counted = rows.filter((r) => r.state === 'counted').length;
  const detail: VisibilityDetail = {
    planned,
    answered: planned - failed,
    failed,
    excluded,
    counted,
    creditSum: Math.round(creditSum * 100) / 100,
    appearances,
    averagePosition: positionCount > 0 ? Math.round((positionSum / positionCount) * 10) / 10 : null,
    rows,
  };

  if (counted < MIN_COUNTED_QUESTIONS) {
    const parts: string[] = [`Only ${counted} of ${planned} questions could be counted (at least ${MIN_COUNTED_QUESTIONS} are needed).`];
    if (failed > 0) parts.push(`${failed} had no Gemini answer, which is missing data rather than a zero.`);
    if (excluded > 0) parts.push(`${excluded} fall outside this brand's product range.`);
    return { metric: { status: 'insufficient', reason: parts.join(' ') }, detail };
  }

  const score = Math.round((100 * creditSum) / counted);
  const reasonParts = [`${counted} of ${planned} questions counted, covering ${intents.size} different shopper intents`];
  if (failed > 0) reasonParts.push(`${failed} without a Gemini answer`);
  if (excluded > 0) reasonParts.push(`${excluded} excluded as outside the product range`);
  return {
    metric: {
      status: 'scored',
      score,
      confidence: confidenceFor(counted),
      confidenceReason: `${reasonParts.join('; ')}. One Gemini run per question.`,
    },
    detail,
  };
}
