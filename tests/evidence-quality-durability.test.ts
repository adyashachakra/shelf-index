// Evidence-quality changes (report format 9): durability is a brand claim, and a policy clause does not cancel it.
//
// Test group F of the approved plan (claude/evidence-quality-revised-implementation-plan.md, sections 4 and 6), including
// N1 option B (a repair-SERVICE question is a fact, while "which moisturisers repair the skin barrier" stays an
// effectiveness claim). No network and no storage. Every sentence here is invented or generic.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as relevance from '../lib/evidence/relevance';

const outcome = (level: 'clear' | 'partial', kind: 'direct' | 'brand_wide' = 'brand_wide') => ({ level, relevance: kind });
function all(itemText: string, quote: string, level: 'clear' | 'partial' = 'clear') {
  return relevance.applyAllRules({ itemText, quote, outcome: outcome(level) });
}

const FAQ = 'With the right care, we expect our pieces to remain a part of your wardrobe for years.';

function table(title: string, rows: [string, string | null][]): void {
  for (const [question, expected] of rows) {
    test(`${title}: "${question}" is ${expected ?? 'a question of fact (null)'}`, () => {
      assert.equal(relevance.claimKind(question), expected);
    });
  }
}

// F-1. Durability questions
table('F1-F7', [
  ['What clothing brands make pieces that last for years?', 'durability'],
  ['How long do the garments actually last?', 'durability'],
  ['Which cookware brands last the longest?', 'durability'],
  ['Do the shoes hold up after a year?', 'durability'],
  ['Which brands make the best durable jeans?', 'durability'],
  ['Are these boots hard-wearing?', 'durability'],
  ['Is it clinically proven to last?', 'clinical'],
]);

// F-2. Compound questions: a policy clause must not cancel a durability clause
table('F8-F14', [
  ['Do these shoes hold up, and can I return them?', 'durability'],
  ['Are these jeans durable, and does the brand offer repairs?', 'durability'],
  ['Do these shoes hold up and can I return them', 'durability'],
  ['How long do they last, and what is the return policy?', 'durability'],
  ['Which brands offer repairs and last for years?', 'durability'],
  ['Do the jeans last for years, or is there a warranty?', 'durability'],
  ['Does the warranty cover them, and do they wear well?', 'durability'],
]);

test('F15: both of your example questions, answered by the brand\'s FAQ sentence, are "touched on, brand claim"', () => {
  for (const question of ['Do these shoes hold up, and can I return them?', 'Are these jeans durable, and does the brand offer repairs?']) {
    const result = all(question, FAQ);
    assert.equal(result.level, 'partial', question);
    assert.equal(result.brandClaim, true, question);
    assert.equal(relevance.evidenceClass(result), 'touched_on', question);
    assert.match(result.note ?? '', /lasts or holds up over time/, question);
    assert.match(result.note ?? '', /does not independently establish/, question);
    assert.match(result.note ?? '', /counts as touched on, not as a clear answer/, question);
  }
});

test('F15b: the Stage 2 items (q5 and c2) answered by the same kind of sentence are lowered', () => {
  for (const question of ['What clothing brands make pieces that last for years?', 'How long do the garments actually last?']) {
    const result = all(question, FAQ);
    assert.equal(result.level, 'partial', question);
    assert.equal(result.brandClaim, true, question);
  }
});

// F-3. Policy questions: no durability claim (and N1 option B)
table('F16-F22', [
  ['What is the warranty on durability?', null],
  ['Is there a lifetime guarantee?', null],
  ['Can I return them?', null],
  ['Does the brand offer a repair service?', null], // N1 option B
  ['Does COS repair worn items?', null], // N1 option B
  ['Which moisturisers repair the skin barrier?', 'effectiveness'], // the skincare meaning is protected
  ['Does the 2-year warranty mean the jeans will last?', null], // a single clause that is both is read as policy
]);

test('F19-F21: both directions of N1 option B', () => {
  // A repair SERVICE is a fact the brand's pages can state clearly.
  for (const question of ['Does the brand offer a repair service?', 'Does COS repair worn items?', 'Is there a repair programme?']) {
    const result = all(question, 'We repair worn garments free of charge within two years of purchase.');
    assert.equal(result.level, 'clear', question);
    assert.equal(result.brandClaim, undefined, question);
  }
  // Repairing the skin is a claim about effectiveness.
  const claim = all('Which moisturisers repair the skin barrier?', 'Our cream repairs the skin barrier overnight.');
  assert.equal(claim.level, 'partial');
  assert.equal(claim.brandClaim, true);
  assert.match(claim.note ?? '', /that it is effective/);
});

test('F23: a policy question answered by a policy fact stays clear and is not a brand claim', () => {
  for (const question of ['What is the warranty on durability?', 'Is there a lifetime guarantee?', 'Can I return them?']) {
    const result = all(question, 'Our 2-year warranty covers defects in materials and workmanship.');
    assert.equal(result.level, 'clear', question);
    assert.equal(result.brandClaim, undefined, question);
  }
});

// F-4. Negative tests: "last" and other near-misses must not match
table('F24-F31', [
  ['How long does shipping take?', null],
  ['When did the last order ship?', null],
  ['How long does delivery take for the last item?', null],
  ['What did the brand launch last year?', null],
  ["Did last year's collection sell out?", null],
  ['How long does the return window last?', null],
  ['How long does the sale last?', null],
  ['Who was the last designer to join?', null],
]);

test('F32: the existing questions of fact and the five existing claim kinds are unchanged', () => {
  for (const question of [
    'How long does shipping take?',
    'What ingredients are in the moisturiser?',
    'Does the brand offer a returns policy?',
    'Is it fragrance-free?',
    'Is the packaging recyclable?',
    'Where can I buy the products?',
    'How do I use the cleanser?',
    'What is the price of the sunscreen?',
    'Is the brand available outside the United States or in Europe?',
  ]) {
    assert.equal(relevance.claimKind(question), null, question);
  }
  for (const [question, kind] of [
    ['Does it actually work for eczema-prone skin?', 'effectiveness'],
    ['Which cleanser is best for oily skin?', 'suitability'],
    ['Are the products safe for pregnancy?', 'suitability'],
    ['Is it clinically proven to hydrate?', 'clinical'],
    ['Which skincare brands do dermatologists recommend most?', 'expert'],
  ] as const) {
    assert.equal(relevance.claimKind(question), kind, question);
  }
});

// F-5. Known limitations (assert the draft rule's behaviour so a change shows up)
table('F34-F35', [
  ['How long does the event last?', 'durability'], // documented false positive: a brand-claim note on a fact, never a wrong score
  ['Do the zippers break easily?', null], // not recognised: the same word-list limit as Patch 6
]);

test('the durability rule is local: no model call, no search, no network', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/evidence/relevance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|gemini|tavily|youtube|redis|process\.env/i);
});

test('the question bank: only the two durability questions (q5 fashion, q8 cookware) change kind', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/audit/questions.ts', import.meta.url), 'utf8');
  const questions = [...source.matchAll(/q\('q\d+',\s*'[^']*',\s*'([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(questions.length >= 8);
  const durability = questions.filter((q) => relevance.claimKind(q) === 'durability');
  assert.deepEqual(durability.sort(), ['What clothing brands make pieces that last for years?', 'Which cookware brands last the longest?']);
});
