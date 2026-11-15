import 'server-only';
import { computeCore } from '../../report/core';
import { buildDigest, buildEvidenceIndex } from '../../report/digest';
import type { StageContext } from '../context';
import type { SynthesisData } from '../job';
import { fixesPrompt, synthesisPrompt } from '../prompts';

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Stage 10: Gemini compares the three bodies of evidence and proposes disagreements, patterns
 * and fixes. The traceability rule is enforced here in code: every item must cite evidence ids
 * that exist in this audit, from the right sides of the comparison. Anything that cannot be
 * connected to real evidence is discarded, never patched up.
 */
export async function runSynthesis(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta, data } = ctx;
  if (data.synthesis?.phase === 'done') return 'done';

  const core = computeCore(meta, data);
  const index = buildEvidenceIndex(data, core);
  const digest = buildDigest(meta, data, core);

  let state: SynthesisData;
  if (!data.synthesis) {
    if (ctx.timeLeft() < 25_000) return 'continue';
    state = { phase: 'insights', insightsAvailable: false, disagreements: [], insights: [], fixesAvailable: false, fixes: [] };
    const result = await ctx.gemini(synthesisPrompt(meta.brand, meta.categoryLabel, digest), 'synthesis');
    if (result === null) {
      ctx.warn("The point-by-point comparison of Gemini's view and the audience's view could not be generated.");
    } else {
      state.insightsAvailable = true;
      for (const d of result.data.disagreements) {
        const audience = unique(d.audience_evidence_ids).filter((id) => index.family(id) === 'audience');
        const gemini = unique(d.gemini_evidence_ids).filter((id) => index.family(id) === 'gemini');
        if (audience.length === 0 || gemini.length === 0) continue;
        state.disagreements.push({
          title: d.title,
          kind: d.kind,
          audienceSays: d.audience_says,
          geminiSays: d.gemini_says,
          implication: d.implication,
          audienceEvidenceIds: audience,
          geminiEvidenceIds: gemini,
        });
      }
      for (const insight of result.data.insights) {
        const ids = unique(insight.evidence_ids).filter((id) => index.has(id));
        const families = new Set(ids.map((id) => index.family(id)));
        const connected =
          insight.pattern === 'complaint_as_fact'
            ? families.has('gemini') && families.has('audience')
            : insight.pattern === 'narrow_range'
              ? families.has('gemini') && families.has('site')
              : families.has('site') && families.has('audience');
        if (!connected) continue;
        if (state.insights.some((i) => i.pattern === insight.pattern)) continue;
        state.insights.push({
          pattern: insight.pattern,
          observed: insight.observed,
          whyItMatters: insight.why_it_matters,
          implication: insight.strategic_implication,
          evidenceIds: ids,
        });
      }
    }
    await ctx.save('synthesis', state);
  } else {
    state = data.synthesis;
  }

  if (ctx.timeLeft() < 22_000) return 'continue';
  const result = await ctx.gemini(
    fixesPrompt(meta.brand, meta.categoryLabel, {
      ...digest,
      findings: {
        disagreements: state.disagreements.map((d) => ({ title: d.title, kind: d.kind, implication: d.implication, evidence_ids: [...d.audienceEvidenceIds, ...d.geminiEvidenceIds] })),
        observed_patterns: state.insights.map((i) => ({ pattern: i.pattern, observed: i.observed, evidence_ids: i.evidenceIds })),
      },
    }),
    'fixes',
  );
  if (result === null) {
    ctx.warn('The fix list could not be generated for this audit.');
  } else {
    state.fixesAvailable = true;
    for (const fix of result.data.fixes) {
      const ids = unique(fix.evidence_ids).filter((id) => index.has(id));
      if (ids.length === 0) continue; // no traceable evidence, no recommendation
      state.fixes.push({
        action: fix.action,
        why: fix.why,
        priority: fix.priority,
        effort: fix.effort,
        expectedImpact: fix.expected_impact,
        evidenceIds: ids,
      });
    }
  }
  state.phase = 'done';
  await ctx.save('synthesis', state);
  ctx.note('synthesis', `${state.disagreements.length} disagreement${state.disagreements.length === 1 ? '' : 's'}, ${state.fixes.length} evidence-backed fix${state.fixes.length === 1 ? '' : 'es'}`);
  return 'done';
}
