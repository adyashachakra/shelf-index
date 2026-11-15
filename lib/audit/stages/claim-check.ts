import 'server-only';
import { normalizeName } from '../../evidence/brand-match';
import { clip, SOCIAL_DOMAINS } from '../../evidence/normalize';
import { quoteAppearsIn } from '../../evidence/quotes';
import { placementOf, verifiedRecommendations } from '../../scoring/visibility';
import { sameBrand } from '../../evidence/brand-match';
import type { ClaimCheck, EvidenceItem } from '../../types';
import type { StageContext } from '../context';
import { readablePages, resultsToEvidence, sourceLabel } from '../evidence-builders';
import type { ClaimsData, JobData } from '../job';
import { claimVerdictsPrompt, type PromptEvidence } from '../prompts';

const TYPE_PRIORITY: Record<string, number> = { availability: 0, product: 1, pricing: 2, company: 3, reputation: 4, other: 5 };
const MAX_CLAIMS = 6;

/** Statements Gemini made about the brand that can be checked, most checkable first. */
function collectClaims(brand: string, data: JobData): ClaimCheck[] {
  const raw: Omit<ClaimCheck, 'id' | 'verdict'>[] = [];
  const profile = data.profile;
  if (profile && profile.recognized) {
    for (const claim of profile.claims) raw.push({ text: claim.text, type: claim.type, polarity: claim.polarity, origin: 'GP' });
  }
  for (const answer of data.answers ?? []) {
    if (answer.status !== 'answered' || placementOf(answer, brand).kind !== 'recommended') continue;
    const own = verifiedRecommendations(answer).find((r) => sameBrand(r.brand, brand));
    if (own && own.why.length >= 20) {
      raw.push({ text: `${brand}: ${own.why}`, type: 'reputation', polarity: 'positive', origin: answer.id });
    }
  }
  const seen = new Set<string>();
  const unique = raw.filter((claim) => {
    const key = normalizeName(claim.text);
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => {
    const byType = (TYPE_PRIORITY[a.type] ?? 5) - (TYPE_PRIORITY[b.type] ?? 5);
    if (byType !== 0) return byType;
    return (a.polarity === 'negative' ? 0 : 1) - (b.polarity === 'negative' ? 0 : 1);
  });
  return unique.slice(0, MAX_CLAIMS).map((claim, index) => ({ ...claim, id: `k${index + 1}`, verdict: 'unverified' as const }));
}

/**
 * Stage 8: check what Gemini said about the brand against retrieved sources.
 * Up to two targeted searches (credit-aware), then Gemini compares each claim with the sources.
 * A "supported" or "contradicted" verdict stands only if the quoted evidence is found in the source.
 */
export async function runClaimCheck(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta, data } = ctx;
  if (data.claims?.phase === 'done') return 'done';

  let state: ClaimsData;
  if (!data.claims) {
    const claims = collectClaims(meta.brand, data);
    if (claims.length === 0) {
      await ctx.save('claims', { phase: 'done', claims: [], sources: [], note: 'Gemini made no checkable statements about the brand.' });
      ctx.note('claims', 'Nothing to check');
      return 'done';
    }
    const searchCount = meta.tier === 'full' ? 2 : meta.tier === 'reduced' ? 1 : 0;
    if (searchCount > 0 && ctx.timeLeft() < 28_000) return 'continue';
    const sources: EvidenceItem[] = [];
    const seen = new Set<string>();
    for (const claim of claims.slice(0, searchCount)) {
      const outcome = await ctx.search('Checking a statement Gemini made', 'open web, excluding social platforms', {
        query: clip(`"${meta.brand}" ${claim.text.replace(`${meta.brand}: `, '')}`, 300),
        maxResults: 5,
        excludeDomains: SOCIAL_DOMAINS,
      });
      if (!outcome) continue;
      const items = resultsToEvidence({
        results: outcome.results,
        kind: 'claim_source',
        prefix: 'K',
        brand: meta.brand,
        startIndex: sources.length,
        seenUrls: seen,
        allowBrandDomain: true,
      });
      outcome.entry.kept = items.length;
      sources.push(...items);
    }
    state = { phase: 'searched', claims, sources };
    await ctx.save('claims', state);
  } else {
    state = data.claims;
  }

  const pool: (PromptEvidence & { url: string })[] = [
    ...state.sources.map((s) => ({ id: s.id, source: sourceLabel(s), title: clip(s.title, 120), text: clip(s.text, 900), url: s.url })),
    ...readablePages(data.site?.pages ?? [])
      .slice(0, 10)
      .map((p) => ({ id: p.id, source: "The brand's own site", title: clip(p.title, 120), text: clip(p.text, 900), url: p.url })),
    ...(data.audience?.items ?? [])
      .filter((i) => i.kind === 'review')
      .slice(0, 8)
      .map((i) => ({ id: i.id, source: sourceLabel(i), title: clip(i.title, 120), text: clip(i.text, 600), url: i.url })),
  ];

  if (pool.length === 0) {
    state.phase = 'done';
    state.note = 'No sources were available to check these statements against.';
    await ctx.save('claims', state);
    ctx.note('claims', 'No sources to check against');
    return 'done';
  }

  if (ctx.timeLeft() < 20_000) return 'continue';
  const result = await ctx.gemini(
    claimVerdictsPrompt(
      meta.brand,
      state.claims.map((c) => ({ id: c.id, text: c.text })),
      pool.map(({ id, source, title, text }) => ({ id, source, title, text })),
    ),
    'claims',
  );

  if (result === null) {
    state.note = "Gemini's statements were collected but could not be checked in this audit.";
    ctx.warn(state.note);
  } else {
    const poolById = new Map(pool.map((p) => [p.id, p]));
    for (const claim of state.claims) {
      const verdict = result.data.verdicts.find((v) => v.claim_id.toLowerCase() === claim.id.toLowerCase());
      if (!verdict || verdict.verdict === 'unverified') {
        claim.note = verdict?.note || 'The sources retrieved do not address this.';
        continue;
      }
      const source = poolById.get(verdict.evidence_id);
      if (!source || !quoteAppearsIn(verdict.quote, source.text)) {
        claim.note = 'A source was cited, but the quoted passage could not be found in it, so this stays unverified.';
        continue;
      }
      claim.verdict = verdict.verdict;
      claim.evidenceId = source.id;
      claim.url = source.url;
      claim.quote = verdict.quote;
      claim.note = verdict.note;
    }
  }
  state.phase = 'done';
  await ctx.save('claims', state);
  const supported = state.claims.filter((c) => c.verdict === 'supported').length;
  const contradicted = state.claims.filter((c) => c.verdict === 'contradicted').length;
  ctx.note('claims', `${state.claims.length} statements checked: ${supported} supported, ${contradicted} contradicted, ${state.claims.length - supported - contradicted} unverified`);
  return 'done';
}
