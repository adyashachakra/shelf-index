// Patch 5: four checks on how evidence is classified and counted, and the builder credit.
//   1. "Which cleanser is best for combination or oily skin?" is not answered by "suitable for a wide range of skin types".
//   2. "Available outside the United States or in Europe?" is not answered by a notice about the visitor's location.
//   3. A brand's own "dermatologist recommended" is the brand's claim; a named expert or organisation can be a clear answer.
//   4. The count of sources shown with a recommendation is the count of unique sources, and the text beside it never gives another.
//   5. The builder credit reads "Built by Adyasha Chakra" and the old spelling appears nowhere in the project.
// No network and no storage. The quotes below are the ones from the first V1.1 Cetaphil report.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { describeEvidenceBase, type EvidenceFamily, type EvidenceIndex } from '../lib/report/digest';
import { stripSourceCounts, withoutSourceCounts } from '../lib/evidence/overclaim';
import * as relevance from '../lib/evidence/relevance';

const outcome = (level: 'clear' | 'partial', kind: 'direct' | 'brand_wide' = 'direct') => ({ level, relevance: kind });

// ---------- 1. best-for questions and general suitability ----------

const CLEANSER_Q = 'Which cleanser is best for combination or oily skin types?';
const CLEANSER_QUOTE = 'Cetaphil is suitable for a wide range of skin types from very dry to combination or oily';

test('the cleanser case: suiting a range of skin types is touched on, not a clear answer', () => {
  assert.equal(relevance.isSelectionQuestion(CLEANSER_Q), true);
  assert.equal(relevance.onlyGeneralSuitability(CLEANSER_QUOTE), true);
  const result = relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote: CLEANSER_QUOTE, outcome: outcome('clear') });
  assert.equal(result.level, 'partial');
  assert.equal(result.relevance, 'indirect');
  assert.match(result.note ?? '', /suits a range of types/);
  assert.equal(relevance.evidenceClass(result), 'touched_on');
  assert.equal(relevance.isLeftOut(result), false, 'it is scored as touched on (half a point), not left out');
});

test('a quote that picks the product out for the need is left as the analysis judged it', () => {
  for (const quote of [
    'Our Daily Oil Control Cleanser is specifically formulated for combination to oily skin',
    'The best cleanser for oily skin: Cetaphil Oily Skin Cleanser',
    'Recommended for combination and oily skin types',
  ]) {
    const result = relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote, outcome: outcome('clear') });
    assert.equal(result.level, 'clear', quote);
  }
});

test('the suitability rule touches nothing else', () => {
  const clear = outcome('clear');
  assert.deepEqual(relevance.applyQuoteRules({ itemText: 'How long does shipping take?', quote: CLEANSER_QUOTE, outcome: clear }), clear, 'not a best-for question');
  assert.deepEqual(relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote: '', outcome: clear }), clear, 'no verified quote');
  const none = { level: 'none' as const, relevance: 'direct' as const };
  assert.deepEqual(relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote: CLEANSER_QUOTE, outcome: none }), none, 'already not addressed');
  const uncertain = { level: 'none' as const, relevance: 'uncertain' as const, note: 'x' };
  assert.deepEqual(relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote: CLEANSER_QUOTE, outcome: uncertain }), uncertain);
  assert.equal(relevance.applyQuoteRules({ itemText: CLEANSER_Q, quote: CLEANSER_QUOTE, outcome: outcome('partial') }).level, 'partial', 'a partial verdict stays partial');
});

// ---------- 2. availability outside the United States ----------

const REGION_Q = 'Are certain products available outside the United States or in Europe?';
const GEO_QUOTE = 'we have detected that you are shopping from a different location';

test('the availability case: a notice about the visitor\'s location is not availability information', () => {
  assert.equal(relevance.isAvailabilityQuestion(REGION_Q), true);
  assert.equal(relevance.regionalAvailabilityIn(GEO_QUOTE), 'none');
  const result = relevance.applyQuoteRules({ itemText: REGION_Q, quote: GEO_QUOTE, outcome: outcome('clear') });
  assert.equal(result.level, 'none');
  assert.equal(relevance.evidenceClass(result), 'not_addressed');
  assert.equal(relevance.isLeftOut(result), false, 'a page was read and does not answer it: counted as not addressed, not left out');
  assert.match(result.note ?? '', /do not say where products are available/);
  assert.match(result.note ?? '', /notice about the visitor's location/);
});

test('availability counts when a page names where products are available', () => {
  for (const quote of [
    'Cetaphil is available in Canada, the UK and across Europe',
    'We ship to Australia and New Zealand',
    'Our products are sold in over 60 countries, including Germany and France',
  ]) {
    const result = relevance.applyQuoteRules({ itemText: REGION_Q, quote, outcome: outcome('clear') });
    assert.equal(result.level, 'clear', quote);
  }
});

test('availability stated only in general terms is touched on; availability only in the United States is not addressed', () => {
  const general = relevance.applyQuoteRules({ itemText: REGION_Q, quote: 'We ship internationally', outcome: outcome('clear') });
  assert.equal(general.level, 'partial');
  assert.equal(relevance.evidenceClass(general), 'touched_on');
  const usOnly = relevance.applyQuoteRules({ itemText: REGION_Q, quote: 'Free shipping on orders in the United States', outcome: outcome('clear') });
  assert.equal(usOnly.level, 'none');
});

test('the availability rule touches nothing else', () => {
  const clear = outcome('clear');
  assert.deepEqual(relevance.applyQuoteRules({ itemText: 'How long does shipping take?', quote: GEO_QUOTE, outcome: clear }), clear);
  assert.equal(relevance.isAvailabilityQuestion('Which cleanser is best for combination or oily skin types?'), false);
  assert.equal(relevance.isAvailabilityQuestion('Is the brand fragrance-free?'), false);
});

// ---------- 3. the brand's own claim versus a named expert ----------

const Q6 = 'Which skincare brands do dermatologists recommend most?';

test("a brand's own 'dermatologist recommended' is its claim, shown as touched on", () => {
  for (const quote of ['The #1 dermatologist-recommended cleanser brand', 'Recommended by dermatologists worldwide', 'Dermatologist approved for sensitive skin']) {
    const result = relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('clear', 'brand_wide') });
    assert.equal(result.level, 'partial', quote);
    assert.equal(result.relevance, 'indirect', quote);
    assert.equal(result.expertEvidence, 'brand_claim', quote);
    assert.match(result.note ?? '', /brand's own page says experts recommend or endorse it/);
    assert.match(result.note ?? '', /name no expert or organisation/);
    assert.match(result.note ?? '', /did not verify/);
    assert.equal(relevance.evidenceClass(result), 'touched_on');
  }
});

test('a named dermatologist or organisation recommending the brand can be a clear answer, still described as stated on the brand\'s page', () => {
  for (const quote of [
    'Recommended by Dr. Jane Smith, board-certified dermatologist',
    'Recommended by the American Academy of Dermatology',
    'Accepted by the Skin Cancer Foundation, an organisation of dermatologists',
  ]) {
    const result = relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('clear') });
    assert.equal(result.level, 'clear', quote);
    assert.ok(result.expertEvidence === 'recommendation' || result.expertEvidence === 'endorsement', quote);
    assert.match(result.note ?? '', /on the brand's own page/);
    assert.match(result.note ?? '', /did not check the statement against any independent source/);
    assert.doesNotMatch(result.note ?? '', /independently verified|verified independently/i);
  }
});

test('working with experts is still touched on; no expert at all is still left out', () => {
  const collab = relevance.applyExpertRule({ itemText: Q6, quote: "We've partnered with dermatologists to identify 5 signs of sensitivity", outcome: outcome('clear') });
  assert.deepEqual([collab.level, collab.relevance, collab.expertEvidence], ['partial', 'indirect', 'collaboration']);
  const none = relevance.applyExpertRule({ itemText: Q6, quote: 'Clinically proven to hydrate for 48 hours', outcome: outcome('clear') });
  assert.equal(relevance.isLeftOut(none), true);
});

// ---------- 4. unique source counts ----------

// An index over two YouTube comments under ONE video and one other source, as in the first V1.1 report.
function index(): EvidenceIndex {
  const families: Record<string, EvidenceFamily> = { C4: 'audience', C7: 'audience', D1: 'audience', GP: 'gemini', S1: 'site' };
  const sourceOf: Record<string, string> = { C4: 'https://www.youtube.com/watch?v=vid1', C7: 'https://www.youtube.com/watch?v=vid1', D1: 'https://www.reddit.com/r/x/comments/1' };
  return {
    has: (id) => id in families,
    family: (id) => families[id] ?? null,
    toInsight: () => null,
    audienceSources: (ids) => new Set(ids.map((id) => sourceOf[id]).filter(Boolean)).size,
  };
}

test('the recommendation case: two comments under one video are one source, and both numbers are shown', () => {
  assert.equal(describeEvidenceBase(['C4', 'C7'], index()), '1 customer or reviewer source (2 excerpts in total)');
  assert.equal(describeEvidenceBase(['C4', 'D1'], index()), '2 customer or reviewer sources');
  assert.equal(describeEvidenceBase(['C4', 'C7', 'D1'], index()), '2 customer or reviewer sources (3 excerpts in total)');
  assert.equal(describeEvidenceBase(['C4', 'S1'], index()), "1 customer or reviewer source, 1 page of the brand's own site");
  assert.equal(describeEvidenceBase(['C4', 'C4'], index()), '1 customer or reviewer source', 'the same id twice is still one excerpt');
});

test("the model's own counts of sources are removed, whatever it counts", () => {
  // The exact sentence from the first V1.1 report, which sat beside "1 customer or reviewer source".
  const why = 'Customer inquiries show questions about which cleansers and moisturizers work best for combination or oily skin types across two sources.';
  assert.equal(withoutSourceCounts(why), 'Customer inquiries show questions about which cleansers and moisturizers work best for combination or oily skin types.');
  assert.equal(withoutSourceCounts('Some customers report difficulty finding specific products outside the United States or in Europe across two sources.'),
    'Some customers report difficulty finding specific products outside the United States or in Europe.');
  for (const text of [
    'Shoppers ask this in three separate threads.',
    'The question comes up in 2 comments.',
    'It appears in two different videos and in one review.',
    'Mentioned among several discussions.',
  ]) {
    assert.doesNotMatch(withoutSourceCounts(text), /\b(?:one|two|three|2|several)\b/i, text);
  }
});

test('a sentence that opens with a count of sources is dropped, so no number in the text can disagree with the count shown', () => {
  assert.equal(withoutSourceCounts('Two sources report this. Customers ask which cleanser suits oily skin.'), 'Customers ask which cleanser suits oily skin.');
  assert.equal(withoutSourceCounts('Two sources report this.'), '', 'nothing left: the recommendation shows no explanation, and the counted evidence is listed under it');
  assert.equal(withoutSourceCounts('Customers ask which cleanser suits oily skin.'), 'Customers ask which cleanser suits oily skin.', 'text with no count is unchanged');
  // The earlier function is unchanged for text it already handled.
  assert.equal(stripSourceCounts('Delivery is slow across three sources.'), 'Delivery is slow.');
});

// ---------- 5. builder credit ----------

function walk(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

test('the footer credit is spelled Adyasha Chakra and the old spelling appears nowhere in the project', () => {
  const root = join(import.meta.dirname, '..');
  const footer = readFileSync(join(root, 'components/SiteFooter.tsx'), 'utf8');
  assert.match(footer, /Built by Adyasha Chakra/);
  assert.match(footer, /linkedin\.com\/in\/adyashachakra/, 'the links are unchanged');
  assert.match(footer, /github\.com\/adyashachakra/);
  const old = new RegExp(['Adya', 'Chakra'].join('\\s+'), 'i'); // the old two-word spelling, built here so this file does not contain it
  const offenders = walk(root).filter((file) => {
    if (!/\.(tsx?|md|json|css|mjs)$/.test(file) || file.endsWith('tests/patch5.test.ts')) return false;
    return old.test(readFileSync(file, 'utf8'));
  });
  assert.deepEqual(offenders, [], 'files still using the old spelling');
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /Built by \[Adyasha Chakra\]/);
  assert.match(readFileSync(join(root, 'app/privacy/page.tsx'), 'utf8'), /Adyasha Chakra on LinkedIn/);
  // The footer lives in the root layout, so every page, including report pages, shows it.
  assert.match(readFileSync(join(root, 'app/layout.tsx'), 'utf8'), /<SiteFooter \/>/);
});

test('a named doctor is recognised even though the title ends in a full stop', () => {
  assert.equal(relevance.expertEvidenceIn('Approved by Dr. Jane Smith for sensitive skin'), 'endorsement');
  assert.equal(relevance.expertEvidenceIn('Dr. Jane Smith recommends it for daily use'), 'recommendation');
  const result = relevance.applyExpertRule({ itemText: Q6, quote: 'Dr. Jane Smith recommends it for daily use', outcome: outcome('clear') });
  assert.equal(result.level, 'clear');
  assert.equal(result.expertEvidence, 'recommendation');
});

// ---------- 6. a denied recommendation is not a recommendation ----------

test('"doctors do not recommend this brand" is not read as a recommendation', () => {
  const quote = 'Doctors do not recommend this brand';
  assert.equal(relevance.expertEvidenceIn(quote), 'negated');
  const result = relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('clear', 'brand_wide') });
  assert.equal(result.level, 'none');
  assert.equal(result.relevance, 'indirect');
  assert.equal(result.expertEvidence, 'negated');
  assert.match(result.note ?? '', /do not recommend or endorse the brand/);
  assert.equal(relevance.evidenceClass(result), 'not_addressed');
  assert.equal(relevance.isLeftOut(result), false, 'the page was read and does not answer the question: counted as not addressed');
});

test('other ways of denying a recommendation, including a named expert', () => {
  for (const quote of [
    'Not recommended by dermatologists',
    "Dermatologists don't recommend it",
    "Dermatologists don’t recommend it",
    'Dermatologists never recommend this cleanser',
    'No dermatologist endorses this brand',
    'None of the doctors we asked recommend it',
    'Not approved by dermatologists',
    'Dr. Jane Smith does not recommend this brand',
  ]) {
    assert.equal(relevance.expertEvidenceIn(quote), 'negated', quote);
    const result = relevance.applyExpertRule({ itemText: Q6, quote, outcome: outcome('clear') });
    assert.equal(result.level, 'none', quote);
  }
});

test('a "no" or "not" elsewhere in the sentence does not turn a recommendation into a denial', () => {
  for (const quote of [
    'No harsh chemicals, recommended by dermatologists',
    'No added fragrance. Dermatologist recommended.',
    'Not only recommended by doctors but loved by customers',
    'Not just tested but recommended by dermatologists',
    "Dermatologists can't recommend it enough",
    'Recommended by Dr. Jane Smith, dermatologist',
  ]) {
    const kind = relevance.expertEvidenceIn(quote);
    assert.ok(kind === 'recommendation' || kind === 'endorsement', `${quote} -> ${kind}`);
  }
  assert.equal(relevance.isNegated('Recommended by dermatologists'), false);
});

test('negation changes only the expert rule', () => {
  const clear = outcome('clear');
  assert.deepEqual(relevance.applyExpertRule({ itemText: 'What are the best skincare brands for anti-aging?', quote: 'Doctors do not recommend this brand', outcome: clear }), clear, 'not an expert question');
  assert.deepEqual(relevance.applyExpertRule({ itemText: Q6, quote: '', outcome: clear }), clear, 'no verified quote');
  assert.equal(relevance.expertEvidenceIn('Clinically proven to hydrate for 48 hours'), null);
  assert.equal(relevance.expertEvidenceIn("We've partnered with dermatologists to identify 5 signs of sensitivity"), 'collaboration');
});
