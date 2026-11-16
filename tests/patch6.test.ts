// Patch 6: a brand's own statement is a claim, not independent evidence.
//   For a question about effectiveness, suitability, clinical performance or what experts recommend, a quote from the
//   brand's OWN website shows what the brand claims. It does not independently establish it, so the item is "touched on,
//   brand claim", never "answered clearly". Questions of fact (where products are sold, shipping, ingredients) are not
//   affected: the brand's page is the authority on those.
// Also: scoring formulas and API usage are unchanged, and saved format-5 reports open as they were saved.
// No network and no storage. The quote and question below are the ones from the Patch 5 Cetaphil audit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as relevance from '../lib/evidence/relevance';
import { gapPoints, scoreContentGap } from '../lib/scoring/content-gap';
import { EXAMPLE_REPORT } from '../lib/report/example-report';
import type { ChecklistItem } from '../lib/types';

const outcome = (level: 'clear' | 'partial', kind: 'direct' | 'brand_wide' = 'direct') => ({ level, relevance: kind });

const Q3 = 'What skincare brands are best for sensitive skin?';
const Q3_QUOTE = 'Cetaphil is a dermatologist recommended sensitive skincare brand.';

function all(itemText: string, quote: string, level: 'clear' | 'partial' = 'clear', kind: 'direct' | 'brand_wide' = 'brand_wide') {
  return relevance.applyAllRules({ itemText, quote, outcome: outcome(level, kind) });
}

// ---------- 1. the case from the Patch 5 audit ----------

test('"best for sensitive skin" answered by the brand calling itself dermatologist recommended is touched on, brand claim', () => {
  const result = all(Q3, Q3_QUOTE);
  assert.equal(result.level, 'partial');
  assert.equal(result.brandClaim, true);
  assert.equal(relevance.evidenceClass(result), 'touched_on');
  assert.match(result.note ?? '', /brand's own statement on its website/);
  assert.match(result.note ?? '', /does not independently establish/);
});

// ---------- 2. the same principle across the four kinds of claim ----------

const CLAIMS: { kind: relevance.ClaimKind; question: string; quote: string; says: RegExp }[] = [
  { kind: 'effectiveness', question: 'Does it actually work for eczema-prone skin?', quote: 'Our moisturiser soothes and repairs dry, eczema-prone skin.', says: /that it is effective/ },
  { kind: 'suitability', question: 'Which cleanser is best for oily skin?', quote: 'Our Oily Skin Cleanser is the best choice for oily, blemish-prone skin.', says: /best or a suitable choice/ },
  { kind: 'suitability', question: 'Are the products safe for pregnancy?', quote: 'All our products are safe to use during pregnancy.', says: /best or a suitable choice/ },
  { kind: 'clinical', question: 'Is it clinically proven to hydrate?', quote: 'Clinically proven to hydrate skin for 48 hours.', says: /its clinical performance/ },
  { kind: 'expert', question: 'Which skincare brands do dermatologists recommend most?', quote: 'Recommended by dermatologists worldwide', says: /(?:brand's own page says experts recommend|that experts recommend it)/ },
];

for (const c of CLAIMS) {
  test(`a brand's own words about ${c.kind} are a brand claim: "${c.question}"`, () => {
    assert.equal(relevance.claimKind(c.question), c.kind);
    const result = all(c.question, c.quote);
    assert.equal(result.level, 'partial', 'a "clear" verdict is lowered to touched on');
    assert.equal(result.brandClaim, true);
    assert.equal(relevance.evidenceClass(result), 'touched_on');
    assert.match(result.note ?? '', c.says);
    assert.doesNotMatch(result.note ?? '', /independently verified|verified independently/i, 'the note never says it was verified');
  });
}

test('a named dermatologist or organisation on the brand\'s own page is also a brand claim', () => {
  for (const quote of ['Recommended by Dr. Jane Smith, board-certified dermatologist', 'Recommended by the American Academy of Dermatology']) {
    const result = all('Which skincare brands do dermatologists recommend most?', quote, 'clear', 'direct');
    assert.equal(result.level, 'partial', quote);
    assert.equal(result.brandClaim, true, quote);
    assert.equal(result.expertEvidence === 'recommendation' || result.expertEvidence === 'endorsement', true, 'the name is still recognised as a name');
    assert.match(result.note ?? '', /named expert or organisation is quoted, on the brand's own page/);
    assert.match(result.note ?? '', /does not independently establish that experts recommend it/);
  }
});

test('a "partial" verdict on a claim question stays touched on and is marked as a brand claim; it is never raised', () => {
  const result = all('Does it actually work for eczema-prone skin?', 'Gentle on eczema-prone skin.', 'partial');
  assert.equal(result.level, 'partial');
  assert.equal(result.brandClaim, true);
  assert.doesNotMatch(result.note ?? '', /counts as touched on, not as a clear answer/, 'nothing was lowered, so nothing is said to have been');
});

// ---------- 3. questions of fact are not affected ----------

const FACT_QUESTIONS = [
  'How long does shipping take?',
  'What ingredients are in the moisturiser?',
  'Does the brand offer a returns policy?',
  'Is it fragrance-free?',
  'Is the packaging recyclable?',
  'Where can I buy the products?',
  'How do I use the cleanser?',
  'What is the price of the sunscreen?',
];

test('questions of fact can still be answered clearly from the brand\'s own pages', () => {
  for (const question of FACT_QUESTIONS) {
    assert.equal(relevance.claimKind(question), null, question);
    const result = all(question, 'Orders ship within 3 to 5 working days.');
    assert.equal(result.level, 'clear', question);
    assert.equal(result.brandClaim, undefined, question);
    assert.equal(relevance.evidenceClass(result), 'clear', question);
  }
});

test('regional availability is still a question of fact: a named place and an availability word can answer it clearly', () => {
  const q = 'Is the brand available outside the United States or in Europe?';
  assert.equal(relevance.claimKind(q), null);
  const result = all(q, 'Our products are available in the United Kingdom, Germany and France.');
  assert.equal(result.level, 'clear');
  assert.equal(result.brandClaim, undefined);
});

// ---------- 4. earlier rules are unchanged ----------

test('earlier rules still apply and are not marked as brand claims where they already say "not addressed" or "left out"', () => {
  // A location notice is not availability information.
  const q = 'Is the brand available outside the United States or in Europe?';
  const notice = all(q, 'We detected that you are visiting from the United States.');
  assert.equal(notice.level, 'none');
  assert.equal(notice.brandClaim, undefined);
  // No expert at all: left out of the score.
  const noExpert = all('Which skincare brands do dermatologists recommend most?', 'Clinically proven to hydrate for 48 hours');
  assert.equal(relevance.isLeftOut(noExpert), true);
  assert.equal(noExpert.brandClaim, undefined);
  // Negation: a denial is not a claim of recommendation.
  const denied = all('Which skincare brands do dermatologists recommend most?', 'Most doctors do not recommend this brand.');
  assert.equal(denied.level, 'none');
  assert.equal(denied.expertEvidence, 'negated');
  assert.equal(denied.brandClaim, undefined);
  // A different product's quote is not evidence about this question.
  const other = relevance.applyAllRules({ itemText: Q3, quote: 'Sunscreen SPF 50', outcome: { level: 'clear', relevance: 'different_product' } });
  assert.equal(other.brandClaim, undefined);
  // Collaboration is still collaboration, and now also a claim: the note keeps its own wording.
  const collab = all('Which skincare brands do dermatologists recommend most?', "We've partnered with dermatologists to identify 5 signs of sensitivity", 'clear');
  assert.equal(collab.expertEvidence, 'collaboration');
  assert.equal(collab.level, 'partial');
  // The general-suitability rule still produces its own note.
  const general = all('Which cleanser is best for combination or oily skin types?', 'Cetaphil is suitable for a wide range of skin types from very dry to combination or oily', 'clear', 'direct');
  assert.equal(general.level, 'partial');
  assert.match(general.note ?? '', /suits a range of types/);
});

test('no quote, no change: an item without a verified quote is returned as it was', () => {
  const result = relevance.applyFirstPartyRule({ itemText: Q3, quote: '', outcome: { level: 'none', relevance: 'direct' } });
  assert.equal(result.level, 'none');
  assert.equal(result.brandClaim, undefined);
});

// ---------- 5. scoring formulas are unchanged ----------

const item = (id: string, level: ChecklistItem['level'], extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id,
  text: id,
  source: 'category_question',
  level,
  ...extra,
});

test('the severity formula is unchanged: none 1, partial 0.5, clear 0; score = round(100 x points / items)', () => {
  const checklist = [item('a', 'clear'), item('b', 'partial'), item('c', 'none'), item('d', 'partial', { brandClaim: true })];
  assert.equal(gapPoints(checklist), 2);
  const metric = scoreContentGap({ domain: 'example.com', pagesRead: 6, sections: ['a', 'b'], analysisAvailable: true, checklist });
  assert.equal(metric.status === 'scored' && metric.score, 50);
});

test('the effect on a score is only the lowered verdicts: one "clear" item becoming "partial" adds 0.5 point', () => {
  const before = [item('a', 'clear'), item('b', 'clear'), item('c', 'partial'), item('d', 'none')];
  const after = [item('a', 'clear'), item('b', 'partial', { brandClaim: true }), item('c', 'partial'), item('d', 'none')];
  assert.equal(gapPoints(after) - gapPoints(before), 0.5);
});

// ---------- 6. no extra requests ----------

test('the brand-claim rule is local: no model call, no search, no network in the rule module', () => {
  const source = readFileSync(new URL('../lib/evidence/relevance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|gemini|tavily|youtube|redis|process\.env/i);
  // And website.ts still sends the same single site-analysis request: the rules run on its answer.
  const website = readFileSync(new URL('../lib/audit/stages/website.ts', import.meta.url), 'utf8');
  assert.match(website, /applyAllRules\(/);
});

// ---------- 7. the illustrative example follows the same rule ----------

test('the illustrative example report obeys the rule and its content gap numbers still follow the formula', () => {
  const detail = EXAMPLE_REPORT.contentGap.detail;
  for (const entry of detail.checklist) {
    if (relevance.claimKind(entry.text) !== null && entry.quote) {
      assert.notEqual(entry.level, 'clear', `"${entry.text}" is a claim question answered by the brand's own words`);
      assert.equal(entry.brandClaim, true, entry.text);
    }
  }
  assert.equal(EXAMPLE_REPORT.version, 6);
  assert.equal(detail.points, gapPoints(detail.checklist));
  assert.equal(EXAMPLE_REPORT.contentGap.metric.status === 'scored' && EXAMPLE_REPORT.contentGap.metric.score, Math.round((100 * detail.points) / detail.checklist.length));
});
