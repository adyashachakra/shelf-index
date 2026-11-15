import 'server-only';
import type { GeminiAnswer } from '../../types';
import { StopSignal, type StageContext } from '../context';
import { askQuestionPrompt } from '../prompts';

/**
 * Stage 2: put each question to Gemini separately and save every raw answer.
 * The questions never name the audited brand. A question Gemini fails to answer is recorded
 * as "failed" (missing data); it is never treated as the brand being absent.
 */
export async function runAskGemini(ctx: StageContext): Promise<'done' | 'continue'> {
  const questions = ctx.data.questions ?? [];
  const answers: GeminiAnswer[] = ctx.data.answers ?? [];

  for (const [index, question] of questions.entries()) {
    if (answers.some((a) => a.questionId === question.id)) continue;
    if (ctx.timeLeft() < 15_000) {
      ctx.note('ask', `${answers.filter((a) => a.status === 'answered').length} of ${questions.length} questions answered`);
      return 'continue';
    }
    const base = { id: `G${index + 1}`, questionId: question.id, question: question.text, intent: question.intent };
    const result = await ctx.gemini(askQuestionPrompt(question.text), `ask:${question.id}`);
    if (result === null) {
      answers.push({ ...base, status: 'failed', failureReason: 'Gemini did not return a usable answer after 3 attempts' });
    } else {
      answers.push({
        ...base,
        status: 'answered',
        answer: result.data.answer,
        recommendations: result.data.recommendations,
        alsoMentioned: result.data.also_mentioned,
        model: result.model,
        askedAt: new Date().toISOString(),
      });
      ctx.meta.model = result.model;
    }
    await ctx.save('answers', answers);
    const answered = answers.filter((a) => a.status === 'answered').length;
    const failed = answers.length - answered;
    ctx.note('ask', `${answered} of ${questions.length} questions answered${failed > 0 ? `, ${failed} without an answer` : ''}`);
  }

  if (answers.length > 0 && answers.every((a) => a.status === 'failed')) {
    throw new StopSignal('no_answers', 'Gemini did not return a usable answer to any question, so this audit could not continue.');
  }
  return 'done';
}
