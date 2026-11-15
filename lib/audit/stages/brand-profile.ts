import 'server-only';
import { cleanDomain, isSocialDomain } from '../../evidence/normalize';
import type { BrandProfile } from '../../types';
import type { StageContext } from '../context';
import { brandProfilePrompt } from '../prompts';

/** Stage 3: ask Gemini, with no sources supplied, what it knows about the brand. */
export async function runBrandProfile(ctx: StageContext): Promise<'done' | 'continue'> {
  if (ctx.data.profile !== undefined) return 'done';
  const { meta } = ctx;

  const result = await ctx.gemini(brandProfilePrompt(meta.brand, meta.categoryLabel), 'profile');
  if (result === null) {
    await ctx.save('profile', null);
    ctx.warn("Gemini's own description of the brand could not be retrieved, so its claims were not checked.");
    ctx.note('profile', 'No description available');
    return 'done';
  }

  const p = result.data;
  const domain = cleanDomain(p.official_domain);
  const profile: BrandProfile = {
    recognized: p.recognized,
    description: p.description,
    knownFor: p.known_for,
    products: p.products,
    pricePositioning: p.price_positioning || 'unknown',
    officialDomain: domain !== '' && !isSocialDomain(domain) ? domain : '',
    strengths: p.strengths,
    criticisms: p.criticisms,
    claims: p.recognized ? p.claims : [],
    model: result.model,
  };
  await ctx.save('profile', profile);
  ctx.note('profile', profile.recognized ? 'Gemini recognises the brand' : 'Gemini does not recognise this brand');
  return 'done';
}
