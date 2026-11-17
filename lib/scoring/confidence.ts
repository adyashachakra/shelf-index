// Overall confidence. There is deliberately no overall or composite score anywhere in this
// project: three different measurements are not averaged into one number.
// Overall confidence is stated only when all three metrics could be assessed; it is then the
// lowest of the three. Otherwise the report names what could not be assessed.

import type { ConfidenceLevel, Metric, OverallConfidence } from '../types';

const ORDER: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

export function overallConfidence(metrics: { name: string; metric: Metric }[]): OverallConfidence {
  const missing = metrics.filter((m) => m.metric.status !== 'scored').map((m) => m.name);
  if (metrics.some((m) => m.metric.status === 'not_recognised')) {
    return {
      status: 'not_stated',
      reason: 'Not stated, because the brand was not recognised in this category. An overall confidence level would not mean anything here.',
    };
  }
  if (missing.length > 0) {
    return {
      status: 'not_stated',
      reason: `Not stated, because ${missing.join(' and ')} could not be assessed in this audit.`,
    };
  }
  let lowest: { name: string; level: ConfidenceLevel } | null = null;
  for (const m of metrics) {
    if (m.metric.status !== 'scored') continue;
    if (lowest === null || ORDER[m.metric.confidence] < ORDER[lowest.level]) {
      lowest = { name: m.name, level: m.metric.confidence };
    }
  }
  if (lowest === null) return { status: 'not_stated', reason: 'No metric could be assessed.' };
  return { status: 'stated', level: lowest.level, limitedBy: lowest.name };
}
