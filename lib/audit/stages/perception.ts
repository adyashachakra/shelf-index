import 'server-only';
import { quoteAppearsIn } from '../../evidence/quotes';
import { clip } from '../../evidence/normalize';
import type { AdvocacyNote, Concern, EvidenceLabel, Theme } from '../../types';
import type { LabelsOutput } from '../../validation/model-output';
import type { StageContext } from '../context';
import { audienceItems, sourceLabel } from '../evidence-builders';
import type { LabelsData } from '../job';
import { labelEvidencePrompt } from '../prompts';

const EMPTY: LabelsData = {
  available: false,
  labels: [],
  praise: [],
  complaints: [],
  concerns: [],
  advocacy: [],
  creatorVsCustomer: '',
  droppedThemes: 0,
};

/**
 * Stage 6: Gemini labels each piece of audience evidence (relevant? whose voice? what sentiment?)
 * and proposes themes. The code then checks every id and quote: a theme must be supported by
 * at least two real evidence items, and a quote is kept only if it appears in its source.
 */
export async function runPerception(ctx: StageContext): Promise<'done' | 'continue'> {
  if (ctx.data.labels) return 'done';
  const { meta } = ctx;
  const items = audienceItems(ctx.data);

  if (items.length === 0) {
    await ctx.save('labels', EMPTY);
    ctx.note('perception', 'No audience evidence was found');
    return 'done';
  }

  const result = await ctx.gemini(
    labelEvidencePrompt(
      meta.brand,
      meta.categoryLabel,
      items.map((item) => ({ id: item.id, source: sourceLabel(item), title: clip(item.title, 120), text: item.text })),
    ),
    'perception',
  );
  if (result === null) {
    await ctx.save('labels', EMPTY);
    ctx.warn('The audience evidence was collected but could not be analysed, so audience perception has no score.');
    ctx.note('perception', 'Analysis unavailable');
    return 'done';
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const labels: EvidenceLabel[] = [];
  const seen = new Set<string>();
  for (const label of result.data.labels) {
    if (!byId.has(label.id) || seen.has(label.id)) continue;
    seen.add(label.id);
    labels.push(label);
  }
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const relevant = (id: string) => labelById.get(id)?.relevant === true;

  let dropped = 0;
  const toThemes = (raw: LabelsOutput['praise_themes']): Theme[] => {
    const themes: Theme[] = [];
    for (const theme of raw) {
      const ids = [...new Set(theme.evidence_ids)].filter((id) => byId.has(id) && relevant(id));
      if (ids.length < 2) {
        dropped += 1;
        continue;
      }
      const quoteSource = byId.get(theme.quote_evidence_id);
      const quoteOk = quoteSource !== undefined && theme.quote_text !== '' && quoteAppearsIn(theme.quote_text, quoteSource.text);
      themes.push({
        label: theme.label,
        summary: theme.summary,
        evidenceIds: ids,
        ...(quoteOk ? { quote: { evidenceId: theme.quote_evidence_id, text: theme.quote_text } } : {}),
      });
    }
    return themes;
  };

  const praise = toThemes(result.data.praise_themes);
  const complaints = toThemes(result.data.complaint_themes);

  const concerns: Concern[] = [];
  for (const concern of result.data.concerns) {
    const ids = [...new Set(concern.evidence_ids)].filter((id) => byId.has(id) && relevant(id));
    if (ids.length < 2) continue;
    concerns.push({ id: `c${concerns.length + 1}`, label: concern.label, evidenceIds: ids });
  }

  const advocacy: AdvocacyNote[] = [];
  for (const entry of result.data.advocacy) {
    const label = labelById.get(entry.evidence_id);
    if (!label || !label.relevant || label.voice !== 'customer' || label.sentiment !== 'positive') continue;
    if (advocacy.some((a) => a.evidenceId === entry.evidence_id)) continue;
    advocacy.push({ evidenceId: entry.evidence_id, note: entry.note });
  }

  const data: LabelsData = {
    available: true,
    labels,
    praise,
    complaints,
    concerns,
    advocacy,
    creatorVsCustomer: result.data.creator_vs_customer,
    droppedThemes: dropped,
  };
  await ctx.save('labels', data);
  const usable = labels.filter((l) => l.relevant && l.voice !== 'brand' && l.sentiment !== 'neutral').length;
  ctx.note('perception', `${usable} usable opinion${usable === 1 ? '' : 's'} from ${items.length} items read`);
  return 'done';
}
