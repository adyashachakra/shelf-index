import 'server-only';
import { asHypothesis, overclaims, withoutOverclaim } from '../../evidence/overclaim';
import { normalizeForMatch } from '../../evidence/quotes';
import { computeCore } from '../../report/core';
import { buildDigest, buildEvidenceIndex, describeEvidenceBase, siteStatements } from '../../report/digest';
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
        const sourceCount = index.audienceSources(audience);
        state.disagreements.push({
          title: withoutOverclaim(d.title, 'A point where customers and Gemini differ'),
          kind: d.kind,
          // Wording that states a cause, generalises or promises an outcome is replaced, not shown.
          audienceSays: withoutOverclaim(d.audience_says, "The summary written for this point claimed more than the evidence shows, so it is not displayed. The customers' own words are in the evidence linked here."),
          geminiSays: d.gemini_says,
          implication: withoutOverclaim(d.implication, ''),
          audienceEvidenceIds: audience,
          geminiEvidenceIds: gemini,
          audienceSourceCount: sourceCount,
        });
      }
      for (const insight of result.data.insights) {
        // Only one pattern is still read from this list. The product-range pattern is counted in
        // code from Gemini's own product list, and positioning is handled statement by statement below.
        if (insight.pattern !== 'complaint_as_fact') continue;
        const ids = unique(insight.evidence_ids).filter((id) => index.has(id));
        const families = new Set(ids.map((id) => index.family(id)));
        if (!families.has('gemini') || !families.has('audience')) continue;
        if (state.insights.some((i) => i.pattern === insight.pattern)) continue;
        state.insights.push({
          pattern: insight.pattern,
          observed: withoutOverclaim(insight.observed, 'Gemini states as fact something that appears in the evidence only as individual customer complaints. See the evidence below.'),
          whyItMatters: withoutOverclaim(insight.why_it_matters, ''),
          implication: withoutOverclaim(insight.strategic_implication, ''),
          evidenceIds: ids,
        });
      }
      // Positioning against complaints: the model is asked about every complaint theme in turn.
      // A tension is recorded only when it names a real complaint theme and a real statement
      // that was verified on the brand's own site. How strong it is gets decided later, in code,
      // from the number of sources behind the complaint.
      const statements = siteStatements(core);
      for (const check of result.data.positioning_checks) {
        if (check.statement_id === '' || check.note === '') continue;
        const statement = statements.find((entry) => entry.id === check.statement_id);
        if (!statement) continue;
        const theme = core.perception.complaints.find((t) => normalizeForMatch(t.label) === normalizeForMatch(check.complaint));
        if (!theme) continue;
        state.insights.push({
          pattern: 'positioning_contradiction',
          observed: withoutOverclaim(check.note, "A statement on the brand's site and a customer complaint are about the same thing. See the evidence below."),
          whyItMatters: '',
          implication: '',
          evidenceIds: unique([statement.ref.pageId, ...theme.evidenceIds]),
          siteStatement: { statement: statement.statement, ref: statement.ref },
        });
        break;
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
      // An action that itself asserts a cause, a brand-wide problem or a business result cannot
      // be reworded safely by code, so the whole recommendation is left out.
      if (overclaims(fix.action)) continue;
      const base = describeEvidenceBase(ids, index);
      state.fixes.push({
        action: fix.action,
        // "Why" may only describe the evidence. A cause or a business outcome is not evidence.
        why: withoutOverclaim(fix.why, 'The explanation written for this recommendation claimed more than the evidence shows, so it is not displayed. Read the sources listed here before acting on it.'),
        priority: fix.priority,
        effort: fix.effort,
        // Shown only as a hypothesis, never as a result.
        expectedImpact: asHypothesis(fix.expected_impact),
        evidenceIds: ids,
        evidenceBase: base,
      });
    }
  }
  state.phase = 'done';
  await ctx.save('synthesis', state);
  ctx.note('synthesis', `${state.disagreements.length} disagreement${state.disagreements.length === 1 ? '' : 's'}, ${state.fixes.length} evidence-backed fix${state.fixes.length === 1 ? '' : 'es'}`);
  return 'done';
}
