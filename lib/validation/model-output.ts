// Validation of everything Gemini returns. The API promises valid JSON, not correct JSON,
// so each answer is parsed against a schema, trimmed, capped and stripped of malformed entries
// before any other code reads it.

import { z } from 'zod';

/** Any value -> trimmed single-line string capped at max characters. */
function text(max: number) {
  return z
    .preprocess((v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)), z.string())
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));
}

function requiredText(max: number) {
  return text(max).refine((s) => s.length > 0, 'required');
}

/** Evidence ids such as "D3" or "g2." -> "D3", "G2". */
const idText = z
  .preprocess((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''), z.string())
  .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12));

const flag = z.preprocess((v) => v === true || v === 'true' || v === 1, z.boolean());

/** Keep the valid entries of an array and silently drop malformed ones. */
function lenientArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown()))
    .transform((entries) => {
      const out: z.output<T>[] = [];
      for (const entry of entries) {
        if (out.length >= max) break;
        const parsed = item.safeParse(entry);
        if (parsed.success) out.push(parsed.data as z.output<T>);
      }
      return out;
    });
}

const idList = lenientArray(idText.refine((s) => s.length > 0), 20);

const voice = z.enum(['customer', 'creator', 'publication', 'brand', 'unclear']).catch('unclear');
const sentiment = z.enum(['positive', 'mixed', 'negative', 'neutral']).catch('neutral');

// 1. One consumer question answered by Gemini.
export const AskAnswerSchema = z.object({
  answer: requiredText(3000),
  recommendations: lenientArray(z.object({ brand: requiredText(80), why: text(320) }), 15),
  also_mentioned: lenientArray(
    z.object({ brand: requiredText(80), stance: z.enum(['neutral', 'cautioned']).catch('neutral') }),
    15,
  ),
});
export type AskAnswerOutput = z.output<typeof AskAnswerSchema>;

// 2. Gemini's unaided description of the brand.
export const ProfileSchema = z.object({
  recognized: flag,
  description: text(700),
  known_for: lenientArray(requiredText(120), 6),
  products: lenientArray(requiredText(80), 10),
  price_positioning: text(40),
  official_domain: text(120),
  strengths: lenientArray(requiredText(160), 5),
  criticisms: lenientArray(requiredText(160), 5),
  claims: lenientArray(
    z.object({
      text: requiredText(240),
      type: z.enum(['product', 'availability', 'pricing', 'company', 'reputation', 'other']).catch('other'),
      polarity: z.enum(['positive', 'negative', 'neutral']).catch('neutral'),
    }),
    10,
  ),
});
export type ProfileOutput = z.output<typeof ProfileSchema>;

// 3. Generated questions for a typed-in category.
export const GeneratedQuestionsSchema = z.object({
  questions: lenientArray(z.object({ intent: requiredText(40), text: requiredText(200) }), 10),
});
export type GeneratedQuestionsOutput = z.output<typeof GeneratedQuestionsSchema>;

// 4. Labels and themes for audience evidence.
const themeSchema = z.object({
  label: requiredText(80),
  summary: text(260),
  evidence_ids: idList,
  quote_evidence_id: idText,
  quote_text: text(220),
});
export const LabelsSchema = z.object({
  labels: lenientArray(
    z.object({ id: idText.refine((s) => s.length > 0), relevant: flag, voice, sentiment }),
    120,
  ),
  praise_themes: lenientArray(themeSchema, 3),
  complaint_themes: lenientArray(themeSchema, 3),
  concerns: lenientArray(z.object({ label: requiredText(140), evidence_ids: idList }), 4),
  advocacy: lenientArray(z.object({ evidence_id: idText.refine((s) => s.length > 0), note: text(160) }), 4),
  creator_vs_customer: text(320),
});
export type LabelsOutput = z.output<typeof LabelsSchema>;

// 5. What the brand's own site says and covers.
const quoteRef = { page_id: idText, quote: text(220) };
export const SiteAnalysisSchema = z.object({
  product_lines: lenientArray(z.object({ name: requiredText(80), ...quoteRef }), 10),
  positioning: lenientArray(z.object({ statement: requiredText(200), ...quoteRef }), 4),
  signature_claim: z
    .preprocess((v) => (typeof v === 'object' && v !== null ? v : {}), z.object({ claim: text(80), ...quoteRef }))
    .catch({ claim: '', page_id: '', quote: '' }),
  question_relevance: lenientArray(
    z.object({
      question_id: text(12),
      fit: z.enum(['in_range', 'out_of_range', 'unclear']).catch('unclear'),
      reason: text(200),
    }),
    12,
  ),
  coverage: lenientArray(
    z.object({ item_id: text(12), level: z.enum(['clear', 'partial', 'none']).catch('none'), ...quoteRef }),
    16,
  ),
});
export type SiteAnalysisOutput = z.output<typeof SiteAnalysisSchema>;

// 6. Verdicts on Gemini's claims.
export const ClaimVerdictsSchema = z.object({
  verdicts: lenientArray(
    z.object({
      claim_id: text(12),
      verdict: z.enum(['supported', 'contradicted', 'unverified']).catch('unverified'),
      evidence_id: idText,
      quote: text(220),
      note: text(220),
    }),
    10,
  ),
});
export type ClaimVerdictsOutput = z.output<typeof ClaimVerdictsSchema>;

// 7. Labels for competitor evidence.
export const CompetitorLabelsSchema = z.object({
  labels: lenientArray(
    z.object({ id: idText.refine((s) => s.length > 0), relevant: flag, voice, sentiment }),
    80,
  ),
});
export type CompetitorLabelsOutput = z.output<typeof CompetitorLabelsSchema>;

// 8. Disconnect and between-the-lines candidates.
export const SynthesisSchema = z.object({
  disagreements: lenientArray(
    z.object({
      title: requiredText(120),
      kind: z.enum(['disagreement', 'opportunity', 'risk']).catch('disagreement'),
      audience_says: requiredText(280),
      gemini_says: requiredText(280),
      implication: text(280),
      audience_evidence_ids: idList,
      gemini_evidence_ids: idList,
    }),
    5,
  ),
  insights: lenientArray(
    z.object({
      pattern: z.enum(['complaint_as_fact', 'narrow_range', 'positioning_contradiction']),
      observed: requiredText(320),
      why_it_matters: text(280),
      strategic_implication: text(280),
      evidence_ids: idList,
    }),
    6,
  ),
});
export type SynthesisOutput = z.output<typeof SynthesisSchema>;

// 9. Fix list.
export const FixesSchema = z.object({
  fixes: lenientArray(
    z.object({
      action: requiredText(260),
      why: text(300),
      priority: z.preprocess((v) => Number(v), z.number().int().min(1).max(5)).catch(3),
      effort: z.enum(['Low', 'Medium', 'High']).catch('Medium'),
      expected_impact: text(260),
      evidence_ids: idList,
    }),
    7,
  ),
});
export type FixesOutput = z.output<typeof FixesSchema>;
