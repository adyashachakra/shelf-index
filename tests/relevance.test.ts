// The product-relevance check applied to a content-gap verdict before it is accepted.
// Pure functions: no network and no storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRelevance, evidenceClass, productGroupsIn, type RelevanceInput } from '../lib/evidence/relevance';

const CLEANSER_CONCERN = 'Does the cleanser dry out my skin?';

function input(overrides: Partial<RelevanceInput>): RelevanceInput {
  return {
    itemText: CLEANSER_CONCERN,
    level: 'clear',
    relation: 'same_product',
    asksAbout: 'cleanser',
    quoteAbout: 'cleanser',
    quote: 'Our gentle skin cleanser is soap-free and will not dry out your skin',
    pageTitle: 'Gentle Skin Cleanser',
    ...overrides,
  };
}

test('clear: the same product, or a fact that is genuinely about the whole brand', () => {
  const same = assessRelevance(input({}));
  assert.deepEqual([same.level, same.relevance, evidenceClass({ level: same.level, relevance: same.relevance })], ['clear', 'direct', 'clear']);

  const brandWide = assessRelevance(input({ relation: 'brand_wide', quoteAbout: 'brand-wide', quote: 'Every Cetaphil formula is fragrance-free and dermatologist tested' }));
  assert.deepEqual([brandWide.level, brandWide.relevance], ['clear', 'brand_wide']);
});

test('touched on: relevant but indirect, or incomplete', () => {
  const related = assessRelevance(input({ relation: 'related', quoteAbout: 'face wash' }));
  assert.deepEqual([related.level, related.relevance, evidenceClass({ level: related.level, relevance: related.relevance })], ['partial', 'indirect', 'touched_on'], 'a "clear" verdict about a related product is capped');
  const partial = assessRelevance(input({ level: 'partial' }));
  assert.deepEqual([partial.level, partial.relevance], ['partial', 'direct']);
});

test('not addressed: evidence about a different product is not partial evidence either', () => {
  // The case from the third live audit: a lotion quote offered for a cleanser question.
  const lotion = assessRelevance(input({ quote: 'Our daily hydrating lotion locks in moisture for twenty four hours', quoteAbout: 'lotion', pageTitle: 'Daily Hydrating Lotion' }));
  assert.deepEqual([lotion.level, lotion.relevance, lotion.evidenceAbout], ['none', 'different_product', 'lotion']);
  assert.equal(evidenceClass({ level: lotion.level, relevance: lotion.relevance }), 'not_addressed');

  // The same when the model only said the quote was on the same product, and only called it partial.
  const partialLotion = assessRelevance(input({ level: 'partial', quote: 'Our daily hydrating lotion locks in moisture for twenty four hours', quoteAbout: 'cleanser' }));
  assert.equal(partialLotion.level, 'none');

  // The model's own judgement that it is a different product is taken at its word.
  const said = assessRelevance(input({ relation: 'different', quoteAbout: 'serum', quote: 'Vitamin C serum brightens' }));
  assert.deepEqual([said.level, said.relevance], ['none', 'different_product']);

  // A quote that names both the asked-about product and another one is not a clash.
  const both = assessRelevance(input({ quote: 'Use our cleanser first, then the lotion', quoteAbout: 'cleanser' }));
  assert.equal(both.level, 'clear');
});

test('uncertain: the link between the evidence and the question cannot be confirmed', () => {
  const unknown = assessRelevance(input({ relation: 'unknown', quoteAbout: '', asksAbout: '' }));
  assert.deepEqual([unknown.level, unknown.relevance, evidenceClass({ level: unknown.level, relevance: unknown.relevance })], ['none', 'uncertain', 'uncertain']);
  assert.ok((unknown.note ?? '').length > 0, 'the reason is stated');

  // The model says "same product" but the product it names is not in the words it quoted.
  const unsupported = assessRelevance(input({ quoteAbout: 'cleanser', quote: 'Gentle, fragrance-free formulas for sensitive skin', pageTitle: 'About us' }));
  assert.equal(unsupported.relevance, 'uncertain');

  // "Brand-wide" for a quote that is only about another product cannot be trusted.
  const disguised = assessRelevance(input({ relation: 'brand_wide', quoteAbout: 'brand-wide', quote: 'Our daily hydrating lotion locks in moisture' }));
  assert.deepEqual([disguised.level, disguised.relevance], ['none', 'uncertain']);
});

test('the product word list names groups, and says nothing about unlisted products', () => {
  assert.deepEqual(productGroupsIn('Gentle foaming face wash and a daily lotion'), ['cleanser', 'moisturizer']);
  assert.deepEqual(productGroupsIn('SPF 50 sunscreen'), ['sunscreen']);
  assert.deepEqual(productGroupsIn('Which brands are best for sensitive skin?'), []);
});
