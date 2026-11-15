import 'server-only';
import { verifiedPriceTier } from '../../evidence/price';
import { normalizeForMatch, quoteAppearsIn } from '../../evidence/quotes';
import { clip } from '../../evidence/normalize';
import { stripSourceCounts, withoutOverclaim } from '../../evidence/overclaim';
import type { AdvocacyNote, Concern, EvidenceLabel, PricePosition, Theme, ThemeScope } from '../../types';
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
  pricePosition: null,
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
  const toThemes = (raw: LabelsOutput['praise_themes'], kind: 'praise' | 'complaint'): Theme[] => {
    const themes: Theme[] = [];
    for (const theme of raw) {
      const ids = [...new Set(theme.evidence_ids)].filter((id) => byId.has(id) && relevant(id));
      if (ids.length < 2) {
        dropped += 1;
        continue;
      }
      const quoteSource = byId.get(theme.quote_evidence_id);
      const quoteOk = quoteSource !== undefined && theme.quote_text !== '' && quoteAppearsIn(theme.quote_text, quoteSource.text);
      // Counted here, not by the model: how many separate threads, pages or videos show the theme.
      const cited = ids.map((id) => byId.get(id)).filter((item) => item !== undefined);
      const sourceCount = new Set(cited.map((item) => item.sourceUrl || item.url)).size;
      // "About one product" is kept only when that product's name is in the cited evidence.
      const product = normalizeForMatch(theme.product);
      const productNamed = product.length >= 3 && cited.some((item) => normalizeForMatch(`${item.title} ${item.text}`).includes(product));
      const scope: ThemeScope = theme.scope === 'one_product' && productNamed ? 'product' : theme.scope === 'brand_overall' ? 'brand' : 'unclear';
      // A complaint summary that states a cause or generalises beyond these reports is replaced
      // by a plain count. The customers' own words remain available in the linked sources.
      const stated = stripSourceCounts(theme.summary); // the count shown beside it comes from the code
      const summary =
        kind === 'complaint'
          ? withoutOverclaim(stated, `${sourceCount} separate source${sourceCount === 1 ? '' : 's'} report this in their own words. See the sources listed here.`)
          : stated;
      // The same check on the short label: a label is a topic, not a verdict.
      const label = kind === 'complaint' ? withoutOverclaim(theme.label, `Reported experience ${themes.length + 1}`) : theme.label;
      themes.push({
        label,
        summary,
        evidenceIds: ids,
        ...(quoteOk ? { quote: { evidenceId: theme.quote_evidence_id, text: theme.quote_text } } : {}),
        itemCount: ids.length,
        sourceCount,
        scope,
        ...(scope === 'product' ? { product: theme.product } : {}),
      });
    }
    return themes;
  };

  const praise = toThemes(result.data.praise_themes, 'praise');
  const complaints = toThemes(result.data.complaint_themes, 'complaint');

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

  // Price position: kept only if the quoted words are in the item, name one price tier and are about this brand.
  let pricePosition: PricePosition | null = null;
  const claimed = result.data.price_position;
  const priceSource = byId.get(claimed.evidence_id);
  if (priceSource && relevant(priceSource.id)) {
    const tier = verifiedPriceTier({ tier: claimed.tier, quote: claimed.quote, title: priceSource.title, text: priceSource.text, brand: meta.brand, ownSite: false });
    if (tier) {
      pricePosition = { tier, origin: 'independent_source', evidenceId: priceSource.id, url: priceSource.url, domain: priceSource.domain, quote: claimed.quote };
    }
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
    pricePosition,
  };
  await ctx.save('labels', data);
  const usable = labels.filter((l) => l.relevant && l.voice !== 'brand' && l.sentiment !== 'neutral').length;
  ctx.note('perception', `${usable} usable opinion${usable === 1 ? '' : 's'} from ${items.length} items read`);
  return 'done';
}
