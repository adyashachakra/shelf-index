import 'server-only';
import { canonicalUrl, clip, SOCIAL_DOMAINS } from '../../evidence/normalize';
import { rankCompetitors } from '../../scoring/competitors';
import type { EvidenceLabel } from '../../types';
import type { StageContext } from '../context';
import { resultsToEvidence, sourceLabel } from '../evidence-builders';
import type { CompetitorsData } from '../job';
import { competitorLabelsPrompt } from '../prompts';

/**
 * Stage 9: the top three competitors are the brands Gemini recommended most in the same answers,
 * so their visibility costs nothing extra. At the full research depth each also gets one search
 * (1 credit) for a light read of sentiment. Nothing is estimated when that search is skipped or fails.
 */
export async function runCompetitors(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta, data } = ctx;
  const state: CompetitorsData = data.competitors ?? {
    names: rankCompetitors(data.answers ?? [], meta.brand).map((r) => r.name),
    searchedNames: [],
    items: [],
    labels: [],
    labeled: false,
  };
  if (!data.competitors) await ctx.save('competitors', state);

  if (meta.tier !== 'full' || state.names.length === 0) {
    if (!state.labeled) {
      state.labeled = true;
      if (meta.tier !== 'full') state.note = 'Competitor sentiment was skipped to stay inside the monthly research budget.';
      await ctx.save('competitors', state);
    }
    ctx.note('competitors', state.names.length > 0 ? state.names.join(', ') : 'No competitors named by Gemini');
    return 'done';
  }

  const seen = new Set(state.items.map((i) => canonicalUrl(i.url)));
  for (const name of state.names) {
    const attemptKey = `competitor:${name}`;
    if (state.searchedNames.includes(name) || (meta.attempts[attemptKey] ?? 0) > 0) continue;
    if (ctx.timeLeft() < 14_000) return 'continue';
    meta.attempts[attemptKey] = 1;
    const outcome = await ctx.search(`Competitor sentiment: ${name}`, 'open web, excluding social platforms', {
      query: `${name} ${meta.categoryNoun} reviews honest opinions`,
      maxResults: 10,
      excludeDomains: [...SOCIAL_DOMAINS, 'youtube.com'],
    });
    if (outcome) {
      const items = resultsToEvidence({
        results: outcome.results,
        kind: 'competitor_source',
        prefix: 'X',
        brand: name,
        startIndex: state.items.length,
        seenUrls: seen,
        competitor: name,
      });
      outcome.entry.kept = items.length;
      state.items.push(...items);
      state.searchedNames.push(name);
    }
    await ctx.save('competitors', state);
  }

  if (!state.labeled) {
    if (state.items.length > 0) {
      if (ctx.timeLeft() < 20_000) return 'continue';
      const result = await ctx.gemini(
        competitorLabelsPrompt(
          meta.categoryLabel,
          state.items.map((i) => ({ id: i.id, source: sourceLabel(i), title: clip(i.title, 120), text: clip(i.text, 700), about: i.competitor ?? '' })),
        ),
        'competitors',
      );
      if (result === null) {
        ctx.warn('Competitor evidence was collected but could not be analysed, so competitor sentiment is not shown.');
      } else {
        const known = new Set(state.items.map((i) => i.id));
        const labels: EvidenceLabel[] = [];
        for (const label of result.data.labels) {
          if (known.has(label.id) && !labels.some((l) => l.id === label.id)) labels.push(label);
        }
        state.labels = labels;
      }
    }
    state.labeled = true;
    await ctx.save('competitors', state);
  }

  ctx.note('competitors', state.names.join(', '));
  return 'done';
}
