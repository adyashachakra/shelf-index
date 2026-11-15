import 'server-only';
import { getJson, setJson } from '../../clients/redis';
import { QUESTIONS_PER_AUDIT } from '../../config';
import { brandKey, mentionsBrand } from '../../evidence/brand-match';
import type { CategoryQuestion } from '../../types';
import type { StageContext } from '../context';
import { generateQuestionsPrompt } from '../prompts';
import { QUESTION_BANK, QUESTION_BANK_VERSION, templateQuestions } from '../questions';

/** Stage 1: load the fixed question set for the category (or write one, once, for a typed-in category). */
export async function runQuestions(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta } = ctx;
  if (ctx.data.questions) return 'done';

  let questions: CategoryQuestion[];
  if (meta.categoryId !== 'other') {
    questions = QUESTION_BANK[meta.categoryId];
  } else {
    const cacheKey = `si:questions:${QUESTION_BANK_VERSION}:${brandKey(meta.categoryLabel)}`;
    const cached = await getJson<CategoryQuestion[]>(cacheKey);
    if (cached && cached.length >= 6) {
      questions = cached;
    } else {
      const result = await ctx.gemini(generateQuestionsPrompt(meta.categoryLabel), 'questions');
      const seen = new Set<string>();
      const generated: CategoryQuestion[] = [];
      for (const entry of result?.data.questions ?? []) {
        const key = entry.text.toLowerCase();
        if (seen.has(key) || mentionsBrand(entry.text, meta.brand)) continue;
        seen.add(key);
        generated.push({ id: `q${generated.length + 1}`, intent: entry.intent.toLowerCase(), text: entry.text });
        if (generated.length >= QUESTIONS_PER_AUDIT) break;
      }
      if (generated.length >= 6) {
        questions = generated;
        await setJson(cacheKey, questions, 30 * 24 * 60 * 60);
      } else {
        questions = templateQuestions(meta.categoryNoun);
        ctx.warn('Gemini could not write questions for this category, so a standard set of questions was used.');
      }
    }
  }

  await ctx.save('questions', questions);
  ctx.note('questions', `${questions.length} questions ready`);
  return 'done';
}
