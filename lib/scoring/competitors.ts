// Competitors are taken from Gemini's own answers: the brands it recommended most, other than
// the audited brand. Their visibility uses the same formula over the same counted questions.

import { sameBrand } from '../evidence/brand-match';
import type { GeminiAnswer } from '../types';
import { creditFor, placementOf, verifiedRecommendations } from './visibility';

export interface CompetitorRank {
  name: string;
  credit: number;
  appearances: number;
}

export function rankCompetitors(answers: GeminiAnswer[], brand: string, limit = 3): CompetitorRank[] {
  const groups: { names: Map<string, number>; credit: number; appearances: number }[] = [];
  for (const answer of answers) {
    if (answer.status !== 'answered') continue;
    const recs = verifiedRecommendations(answer);
    recs.forEach((rec, index) => {
      if (sameBrand(rec.brand, brand)) return;
      let group = groups.find((g) => [...g.names.keys()].some((name) => sameBrand(name, rec.brand)));
      if (!group) {
        group = { names: new Map(), credit: 0, appearances: 0 };
        groups.push(group);
      }
      group.names.set(rec.brand, (group.names.get(rec.brand) ?? 0) + 1);
      group.credit += creditFor({ kind: 'recommended', position: index + 1 });
      group.appearances += 1;
    });
  }
  return groups
    .map((g) => {
      // Display the most frequent spelling; on a tie, the shortest.
      const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      return { name, credit: Math.round(g.credit * 100) / 100, appearances: g.appearances };
    })
    .sort((a, b) => b.credit - a.credit || b.appearances - a.appearances || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The visibility formula for any brand over a fixed set of questions. */
export function visibilityOverQuestions(
  brand: string,
  answers: GeminiAnswer[],
  questionIds: Set<string>,
): { score: number | null; appearances: number; counted: number } {
  let credit = 0;
  let counted = 0;
  let appearances = 0;
  for (const answer of answers) {
    if (answer.status !== 'answered' || !questionIds.has(answer.questionId)) continue;
    const placement = placementOf(answer, brand);
    credit += creditFor(placement);
    counted += 1;
    if (placement.kind === 'recommended' || placement.kind === 'mentioned') appearances += 1;
  }
  return { score: counted > 0 ? Math.round((100 * credit) / counted) : null, appearances, counted };
}
