// Audience perception: pure arithmetic over labeled evidence.
//
// Counted item = relevant to the brand, not brand-created, sentiment not neutral.
// Weight by voice: customer 1.0 · creator, publication or unclear 0.5
// Score = round(100 × (positive + 0.5 × mixed) ÷ (positive + mixed + negative)), weighted counts.
// Insufficient data: fewer than 8 counted items, or fewer than 3 distinct sources.
// Confidence (sample size AND diversity):
//   High   = 25+ counted items, 4+ unique domains, 2+ source types
//   Medium = 12+ counted items, 2+ unique domains
//   Low    = anything else that clears the minimum
// Raw (unweighted) counts are kept separately from the weighted counts used in the score.

import type {
  ConfidenceLevel,
  CountedVoice,
  EvidenceItem,
  EvidenceLabel,
  Metric,
  PerceptionDetail,
  SampleCounts,
  SentimentCounts,
} from '../types';

export const VOICE_WEIGHTS: Record<CountedVoice, number> = {
  customer: 1,
  creator: 0.5,
  publication: 0.5,
  unclear: 0.5,
};
export const MIN_COUNTED_ITEMS = 8;
export const MIN_DISTINCT_SOURCES = 3;
const MIN_ITEMS_FOR_VOICE_SCORE = 5;

function emptyCounts(): SampleCounts {
  return { discussions: 0, reviews: 0, videos: 0, comments: 0 };
}

function countKey(item: EvidenceItem): keyof SampleCounts {
  if (item.kind === 'discussion') return 'discussions';
  if (item.kind === 'youtube_video') return 'videos';
  if (item.kind === 'youtube_comment') return 'comments';
  return 'reviews';
}

/** The score formula on its own. Returns null when there is nothing to count. */
export function sentimentScore(counts: SentimentCounts): number | null {
  const total = counts.positive + counts.mixed + counts.negative;
  if (total <= 0) return null;
  return Math.round((100 * (counts.positive + 0.5 * counts.mixed)) / total);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function scorePerception(
  items: EvidenceItem[],
  labels: EvidenceLabel[],
): { metric: Metric; detail: PerceptionDetail } {
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const raw = { positive: 0, mixed: 0, negative: 0, counted: 0, neutral: 0, irrelevant: 0, brandCreated: 0 };
  const weighted = { positive: 0, mixed: 0, negative: 0, total: 0 };
  const byVoice: Record<CountedVoice, number> = { customer: 0, creator: 0, publication: 0, unclear: 0 };
  const perVoice: Record<'customer' | 'creator' | 'publication', SentimentCounts> = {
    customer: { positive: 0, mixed: 0, negative: 0 },
    creator: { positive: 0, mixed: 0, negative: 0 },
    publication: { positive: 0, mixed: 0, negative: 0 },
  };
  const sources = new Set<string>();
  const relevantSources = new Set<string>();
  const domains = new Set<string>();
  let itemsLabeled = 0;
  // Material read -> material about the brand -> opinions counted, by kind of material.
  const sample = { read: emptyCounts(), aboutBrand: emptyCounts(), counted: emptyCounts() };

  for (const item of items) {
    const kind = countKey(item);
    sample.read[kind] += 1;
    const label = labelById.get(item.id);
    if (!label) continue;
    itemsLabeled += 1;
    if (label.relevant) {
      sample.aboutBrand[kind] += 1;
      relevantSources.add(item.sourceUrl || item.url);
    }
    if (!label.relevant) {
      raw.irrelevant += 1;
      continue;
    }
    if (label.voice === 'brand') {
      raw.brandCreated += 1;
      continue;
    }
    if (label.sentiment === 'neutral') {
      raw.neutral += 1;
      continue;
    }
    const voice: CountedVoice = label.voice;
    const weight = VOICE_WEIGHTS[voice];
    raw[label.sentiment] += 1;
    raw.counted += 1;
    sample.counted[kind] += 1;
    weighted[label.sentiment] += weight;
    weighted.total += weight;
    byVoice[voice] += 1;
    if (voice !== 'unclear') perVoice[voice][label.sentiment] += 1;
    sources.add(item.sourceUrl || item.url);
    if (item.domain) domains.add(item.domain);
  }

  const sourceTypes = (['customer', 'creator', 'publication'] as const).filter((v) => byVoice[v] > 0);
  const voiceScore = (voice: 'customer' | 'creator' | 'publication'): number | null =>
    byVoice[voice] >= MIN_ITEMS_FOR_VOICE_SCORE ? sentimentScore(perVoice[voice]) : null;

  const detail: PerceptionDetail = {
    itemsRetrieved: items.length,
    itemsLabeled,
    raw,
    weighted: {
      positive: round2(weighted.positive),
      mixed: round2(weighted.mixed),
      negative: round2(weighted.negative),
      total: round2(weighted.total),
    },
    uniqueSources: sources.size,
    sourcesAboutBrand: relevantSources.size,
    uniqueDomains: [...domains].sort(),
    sourceTypes,
    byVoice,
    voiceScores: {
      customer: voiceScore('customer'),
      creator: voiceScore('creator'),
      publication: voiceScore('publication'),
    },
    sponsoredItems: items
      .filter((item) => item.sponsored && item.sponsored.length > 0)
      .map((item) => ({ evidenceId: item.id, signals: item.sponsored ?? [] })),
    sample,
  };

  if (raw.counted < MIN_COUNTED_ITEMS) {
    return {
      metric: {
        status: 'insufficient',
        reason: `Only ${raw.counted} usable opinion${raw.counted === 1 ? '' : 's'} about the brand were found (at least ${MIN_COUNTED_ITEMS} are needed).`,
      },
      detail,
    };
  }
  if (sources.size < MIN_DISTINCT_SOURCES) {
    return {
      metric: {
        status: 'insufficient',
        reason: `The ${raw.counted} usable opinions come from only ${sources.size} unique source${sources.size === 1 ? '' : 's'} (at least ${MIN_DISTINCT_SOURCES} separate threads, pages or videos are needed).`,
      },
      detail,
    };
  }

  const score = sentimentScore(weighted) ?? 0;
  let confidence: ConfidenceLevel = 'low';
  if (raw.counted >= 25 && domains.size >= 4 && sourceTypes.length >= 2) confidence = 'high';
  else if (raw.counted >= 12 && domains.size >= 2) confidence = 'medium';
  const typeList = sourceTypes.length > 0 ? sourceTypes.join(', ') : 'none identified';
  return {
    metric: {
      status: 'scored',
      score,
      confidence,
      confidenceReason: `${raw.counted} counted opinions, drawn from ${sources.size} unique source${sources.size === 1 ? '' : 's'} (threads, pages or videos) on ${domains.size} website${domains.size === 1 ? '' : 's'}. Voices heard: ${typeList}.`,
    },
    detail,
  };
}
