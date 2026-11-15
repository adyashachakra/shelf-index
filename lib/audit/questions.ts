// The category question bank. Every brand in a category is asked the same eight questions,
// which is what makes two brands' visibility scores comparable. Questions never name a brand.
// Each question covers a different shopper intent.
//
// EDIT ME: these are a first draft. Changing a question changes what the score measures,
// so bump QUESTION_BANK_VERSION when you edit them.

import type { CategoryId, CategoryQuestion } from '../types';

export const QUESTION_BANK_VERSION = '2026-11-14';

type Bank = Record<Exclude<CategoryId, 'other'>, CategoryQuestion[]>;

function q(id: string, intent: string, text: string): CategoryQuestion {
  return { id, intent, text };
}

export const QUESTION_BANK: Bank = {
  skincare: [
    q('q1', 'best overall', 'What are the best skincare brands right now?'),
    q('q2', 'value', 'Which affordable skincare brands actually work?'),
    q('q3', 'sensitive skin', 'What skincare brands are best for sensitive skin?'),
    q('q4', 'acne', 'Which skincare brands do you recommend for acne-prone skin?'),
    q('q5', 'anti-aging', 'What are the best skincare brands for anti-aging?'),
    q('q6', 'expert trust', 'Which skincare brands do dermatologists recommend most?'),
    q('q7', 'clean and fragrance-free', 'What are the best clean or fragrance-free skincare brands?'),
    q('q8', 'premium', 'Which luxury skincare brands are worth the money?'),
  ],
  fashion: [
    q('q1', 'everyday basics', 'What are the best clothing brands for everyday basics?'),
    q('q2', 'value', 'Which affordable clothing brands have the best quality for the price?'),
    q('q3', 'sustainability', 'What are the best sustainable and ethical clothing brands?'),
    q('q4', 'workwear', 'Which clothing brands are best for workwear and office outfits?'),
    q('q5', 'durability', 'What clothing brands make pieces that last for years?'),
    q('q6', 'inclusive sizing', 'Which clothing brands are best for inclusive sizing?'),
    q('q7', 'premium', 'What premium or designer clothing brands are worth the price?'),
    q('q8', 'trend', 'Which clothing brands are most popular right now?'),
  ],
  homeware: [
    q('q1', 'best overall', 'What are the best homeware brands for furnishing a home?'),
    q('q2', 'value', 'Which affordable homeware brands look more expensive than they are?'),
    q('q3', 'bedding and bath', 'What are the best brands for bedding and bath linens?'),
    q('q4', 'small spaces', 'Which homeware brands are best for small apartments?'),
    q('q5', 'sustainability', 'What are the best sustainable homeware brands?'),
    q('q6', 'gifting', 'Which homeware brands make the best gifts?'),
    q('q7', 'premium', 'What premium homeware brands are worth the investment?'),
    q('q8', 'tableware', 'Which brands are best for dinnerware and glassware?'),
  ],
  cookware: [
    q('q1', 'best overall', 'What are the best cookware brands?'),
    q('q2', 'value', 'Which affordable cookware brands perform like the expensive ones?'),
    q('q3', 'non-toxic', 'What are the best non-toxic cookware brands?'),
    q('q4', 'nonstick', 'Which brands make the best nonstick pans?'),
    q('q5', 'stainless steel', 'What are the best stainless steel cookware brands?'),
    q('q6', 'beginners', 'Which cookware brands are best for beginners?'),
    q('q7', 'premium', 'What premium cookware brands are worth the money?'),
    q('q8', 'durability', 'Which cookware brands last the longest?'),
  ],
  beverages: [
    q('q1', 'best overall', 'What are the best beverage brands to try right now?'),
    q('q2', 'healthy', 'Which healthy drink brands are actually good for you?'),
    q('q3', 'low sugar', 'What are the best low-sugar or zero-sugar drink brands?'),
    q('q4', 'energy', 'Which energy drink brands are the best?'),
    q('q5', 'functional', 'What are the best functional beverage brands, like prebiotic or adaptogen drinks?'),
    q('q6', 'alcohol alternatives', 'Which non-alcoholic drink brands are best for replacing alcohol?'),
    q('q7', 'coffee and tea', 'What are the best coffee or tea brands for drinking at home?'),
    q('q8', 'sparkling', 'Which sparkling water or soda-alternative brands are best?'),
  ],
  agencies: [
    q('q1', 'best overall', 'What are the best marketing agencies?'),
    q('q2', 'small budgets', 'Which marketing agencies are best for small businesses with limited budgets?'),
    q('q3', 'brand launch', 'What are the best agencies for launching a consumer brand?'),
    q('q4', 'social and influencer', 'Which agencies are best for social media and influencer marketing?'),
    q('q5', 'performance', 'What are the best performance marketing agencies for e-commerce?'),
    q('q6', 'brand strategy', 'Which agencies are best for brand strategy and positioning?'),
    q('q7', 'creative', 'What are the best creative advertising agencies?'),
    q('q8', 'B2B', 'Which agencies are best for B2B marketing?'),
  ],
};

/** Deterministic questions for a typed-in category, used when Gemini cannot generate a set. */
export function templateQuestions(categoryNoun: string): CategoryQuestion[] {
  const c = categoryNoun.trim();
  return [
    q('q1', 'best overall', `What are the best ${c} brands?`),
    q('q2', 'value', `Which affordable ${c} brands offer the best value?`),
    q('q3', 'premium', `What premium ${c} brands are worth the money?`),
    q('q4', 'beginners', `Which ${c} brands are best for someone buying for the first time?`),
    q('q5', 'trust', `What ${c} brands are the most trusted?`),
    q('q6', 'quality', `Which ${c} brands have the best quality?`),
    q('q7', 'popularity', `What are the most popular ${c} brands right now?`),
    q('q8', 'expert trust', `Which ${c} brands do experts recommend?`),
  ];
}
