// Logic tests: scoring formulas, brand matching, quote checks, validation. No network, no storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { domainMatchesBrand, mentionsBrand, sameBrand } from '../lib/evidence/brand-match';
import { cleanDomain, stripBoilerplate } from '../lib/evidence/normalize';
import { quoteAppearsIn } from '../lib/evidence/quotes';
import { detectSponsorship } from '../lib/evidence/sponsorship';
import { EXAMPLE_REPORT } from '../lib/report/example-report';
import { rankCompetitors, visibilityOverQuestions } from '../lib/scoring/competitors';
import { overallConfidence } from '../lib/scoring/confidence';
import { scoreContentGap } from '../lib/scoring/content-gap';
import { scorePerception, sentimentScore } from '../lib/scoring/perception';
import { placementOf, scoreVisibility } from '../lib/scoring/visibility';
import type { ChecklistItem, EvidenceItem, EvidenceLabel, GeminiAnswer, Sentiment, Voice } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { AskAnswerSchema, LabelsSchema } from '../lib/validation/model-output';

function answered(n: number, text: string, brands: string[], also: { brand: string; stance: 'neutral' | 'cautioned' }[] = []): GeminiAnswer {
  return { id: `G${n}`, questionId: `q${n}`, question: `Question ${n}?`, intent: `intent ${n}`, status: 'answered', answer: text, recommendations: brands.map((brand) => ({ brand, why: 'because' })), alsoMentioned: also };
}
function failed(n: number): GeminiAnswer {
  return { id: `G${n}`, questionId: `q${n}`, question: `Question ${n}?`, intent: `intent ${n}`, status: 'failed', failureReason: 'no answer' };
}

test('brand matching tolerates "The", accents, punctuation and product suffixes', () => {
  assert.ok(sameBrand('The Ordinary', 'ordinary'));
  assert.ok(sameBrand('CeraVe', 'Cerave Moisturizing Cream'));
  assert.ok(sameBrand('Fenty', 'Fenty Beauty by Rihanna'));
  assert.ok(sameBrand('H&M', 'H and M'));
  assert.ok(sameBrand("L'Oréal", 'Loreal Paris'));
  assert.ok(sameBrand('La Roche-Posay', 'La Roche Posay'));
  assert.ok(!sameBrand('Away', 'Far Away'));
  assert.ok(!sameBrand('Dove', 'Dover'));
  assert.ok(!sameBrand('Ordinary', 'Extraordinary Skin'));
  assert.ok(mentionsBrand('I love the ordinary serums', 'The Ordinary'));
  assert.ok(!mentionsBrand('An extraordinary serum', 'Ordinary'));
  assert.ok(mentionsBrand('Buy at drunkelephant.com today', 'Drunk Elephant'));
  assert.ok(domainMatchesBrand('www.glossier.com', 'Glossier'));
  assert.ok(!domainMatchesBrand('sephora.com', 'Glossier'));
});

test('visibility: placement credits and the published formula', () => {
  const answers = [
    answered(1, 'Try Alpha, then Beta.', ['Alpha', 'Beta']), // absent: 0
    answered(2, 'Try Alpha, Beta and Target.', ['Alpha', 'Beta', 'Target']), // 3rd: 0.70
    answered(3, 'Try Beta then Target.', ['Beta', 'Target']), // 2nd: 0.85
    answered(4, 'Target first.', ['Target']), // 1st: 1.00
    answered(5, 'Alpha. Target is also known.', ['Alpha'], [{ brand: 'Target', stance: 'neutral' }]), // mentioned: 0.20
    answered(6, 'Alpha. Avoid Target.', ['Alpha'], [{ brand: 'Target', stance: 'cautioned' }]), // cautioned: 0
  ];
  const { metric, detail } = scoreVisibility({ brand: 'Target', answers, outOfRange: new Map() });
  assert.equal(detail.counted, 6);
  assert.equal(detail.creditSum, 2.75);
  assert.equal(metric.status, 'scored');
  if (metric.status === 'scored') {
    assert.equal(metric.score, Math.round((100 * 2.75) / 6)); // 46
    assert.equal(metric.confidence, 'medium');
  }
});

test('visibility: a Gemini failure is missing data, never a zero', () => {
  const base = [1, 2, 3, 4, 5, 6].map((n) => answered(n, 'Target is best.', ['Target']));
  const withFailures = [...base, failed(7), failed(8)];
  const result = scoreVisibility({ brand: 'Target', answers: withFailures, outOfRange: new Map() });
  assert.equal(result.detail.failed, 2);
  assert.equal(result.detail.counted, 6);
  assert.equal(result.metric.status === 'scored' ? result.metric.score : -1, 100, 'failures must not pull the score down');
  assert.equal(result.detail.rows.filter((r) => r.state === 'no_answer').length, 2);
});

test('visibility: fewer than 5 counted questions gives no score', () => {
  const answers = [answered(1, 'Target.', ['Target']), answered(2, 'Target.', ['Target']), failed(3), failed(4), failed(5), failed(6), answered(7, 'Target.', ['Target']), answered(8, 'Alpha.', ['Alpha'])];
  const result = scoreVisibility({ brand: 'Target', answers, outOfRange: new Map() });
  assert.equal(result.metric.status, 'insufficient');
});

test('visibility: range exclusion needs a reason AND the brand absent from that answer', () => {
  const answers = [1, 2, 3, 4, 5, 6].map((n) => answered(n, 'Alpha only.', ['Alpha']));
  answers.push(answered(7, 'Target is the pick.', ['Target']));
  answers.push(answered(8, 'Alpha only.', ['Alpha']));
  const outOfRange = new Map([
    ['q7', 'claimed out of range, but Gemini named the brand'],
    ['q8', 'site shows no such products'],
  ]);
  const { detail } = scoreVisibility({ brand: 'Target', answers, outOfRange });
  assert.equal(detail.rows.find((r) => r.questionId === 'q7')?.state, 'counted');
  assert.equal(detail.rows.find((r) => r.questionId === 'q8')?.state, 'excluded');
  assert.equal(detail.counted, 7);
});

test('visibility: a listed brand that is not in the answer text is ignored', () => {
  const a = answered(1, 'I suggest Alpha and Target.', ['Ghost', 'Alpha', 'Target']);
  assert.deepEqual(placementOf(a, 'Target'), { kind: 'recommended', position: 2 });
});

function evidence(id: string, kind: EvidenceItem['kind'], domain: string, source: string): EvidenceItem {
  return { id, kind, url: `${source}#${id}`, domain, title: id, text: 'text', sourceUrl: source };
}
function label(id: string, voice: Voice, sentiment: Sentiment, relevant = true): EvidenceLabel {
  return { id, relevant, voice, sentiment };
}

test('perception: weighted formula, raw counts kept separately', () => {
  const items: EvidenceItem[] = [];
  const labels: EvidenceLabel[] = [];
  // 6 customers: 4 positive, 1 mixed, 1 negative. 4 creators: 2 positive, 2 negative. 2 publications: 1 mixed, 1 negative.
  const plan: [Voice, Sentiment][] = [
    ['customer', 'positive'], ['customer', 'positive'], ['customer', 'positive'], ['customer', 'positive'], ['customer', 'mixed'], ['customer', 'negative'],
    ['creator', 'positive'], ['creator', 'positive'], ['creator', 'negative'], ['creator', 'negative'],
    ['publication', 'mixed'], ['publication', 'negative'],
  ];
  plan.forEach(([voice, sentiment], i) => {
    const domain = ['a.com', 'b.com', 'c.com'][i % 3];
    items.push(evidence(`E${i}`, 'review', domain, `https://${domain}/p${i % 5}`));
    labels.push(label(`E${i}`, voice, sentiment));
  });
  items.push(evidence('N1', 'review', 'a.com', 'https://a.com/n1'), evidence('B1', 'review', 'a.com', 'https://a.com/b1'), evidence('I1', 'review', 'a.com', 'https://a.com/i1'));
  labels.push(label('N1', 'customer', 'neutral'), label('B1', 'brand', 'positive'), label('I1', 'customer', 'positive', false));

  const { metric, detail } = scorePerception(items, labels);
  assert.deepEqual({ p: detail.raw.positive, m: detail.raw.mixed, n: detail.raw.negative, c: detail.raw.counted }, { p: 6, m: 2, n: 4, c: 12 });
  assert.equal(detail.raw.neutral, 1);
  assert.equal(detail.raw.brandCreated, 1);
  assert.equal(detail.raw.irrelevant, 1);
  // weighted: positive 4 + 0.5×2 = 5; mixed 1 + 0.5×1 = 1.5; negative 1 + 0.5×2 + 0.5×1 = 2.5; total 9
  assert.deepEqual(detail.weighted, { positive: 5, mixed: 1.5, negative: 2.5, total: 9 });
  assert.equal(metric.status, 'scored');
  if (metric.status === 'scored') {
    assert.equal(metric.score, Math.round((100 * (5 + 0.75)) / 9)); // 64
    assert.equal(metric.confidence, 'medium'); // 12 items, 3 domains
  }
  assert.equal(detail.voiceScores.customer, sentimentScore({ positive: 4, mixed: 1, negative: 1 }));
  assert.equal(detail.voiceScores.creator, null, 'fewer than 5 creator items: not scored on its own');
  assert.deepEqual(detail.sourceTypes, ['customer', 'creator', 'publication']);
  assert.equal(detail.uniqueDomains.length, 3);
});

test('perception: too few items or too few sources gives no score', () => {
  const few = Array.from({ length: 7 }, (_, i) => evidence(`E${i}`, 'review', 'a.com', `https://a.com/${i}`));
  assert.equal(scorePerception(few, few.map((e) => label(e.id, 'customer', 'positive'))).metric.status, 'insufficient');
  const oneSource = Array.from({ length: 10 }, (_, i) => evidence(`E${i}`, 'youtube_comment', 'youtube.com', i < 5 ? 'https://youtube.com/v1' : 'https://youtube.com/v2'));
  const result = scorePerception(oneSource, oneSource.map((e) => label(e.id, 'customer', 'positive')));
  assert.equal(result.metric.status, 'insufficient');
  assert.equal(result.detail.uniqueSources, 2);
});

test('perception: high confidence needs size AND diversity', () => {
  const items = Array.from({ length: 30 }, (_, i) => evidence(`E${i}`, 'review', 'only-one.com', `https://only-one.com/${i}`));
  const single = scorePerception(items, items.map((e) => label(e.id, 'customer', 'positive')));
  assert.equal(single.metric.status === 'scored' ? single.metric.confidence : '', 'low', '30 items from one domain is not high confidence');
  const spread = Array.from({ length: 30 }, (_, i) => evidence(`E${i}`, 'review', `d${i % 5}.com`, `https://d${i % 5}.com/${i}`));
  const diverse = scorePerception(spread, spread.map((e, i) => label(e.id, i % 2 ? 'customer' : 'publication', 'positive')));
  assert.equal(diverse.metric.status === 'scored' ? diverse.metric.confidence : '', 'high');
});

function check(id: string, level: ChecklistItem['level']): ChecklistItem {
  return { id, source: 'category_question', text: id, level };
}

test('content gap: formula and insufficient-data states', () => {
  const checklist = [check('a', 'none'), check('b', 'none'), check('c', 'partial'), check('d', 'clear')];
  const scored = scoreContentGap({ domain: 'x.com', pagesRead: 9, sections: ['home', 'blog', 'products'], analysisAvailable: true, checklist });
  assert.equal(scored.status === 'scored' ? scored.score : -1, Math.round((100 * 2.5) / 4)); // 63
  assert.equal(scored.status === 'scored' ? scored.confidence : '', 'high');
  assert.equal(scoreContentGap({ domain: 'x.com', pagesRead: 9, sections: ['products'], analysisAvailable: true, checklist }).status === 'scored', true);
  assert.equal(scoreContentGap({ domain: null, pagesRead: 0, sections: [], analysisAvailable: false, checklist: [] }).status, 'insufficient');
  assert.equal(scoreContentGap({ domain: 'x.com', pagesRead: 2, sections: ['home'], analysisAvailable: true, checklist }).status, 'insufficient');
  assert.equal(scoreContentGap({ domain: 'x.com', pagesRead: 6, sections: ['home'], analysisAvailable: true, checklist: checklist.slice(0, 3) }).status, 'insufficient');
});

test('overall confidence is not stated when any metric could not be assessed', () => {
  const scored = (c: 'high' | 'medium' | 'low') => ({ status: 'scored' as const, score: 50, confidence: c, confidenceReason: '' });
  const all = overallConfidence([{ name: 'a', metric: scored('high') }, { name: 'b', metric: scored('low') }, { name: 'c', metric: scored('medium') }]);
  assert.deepEqual(all, { status: 'stated', level: 'low', limitedBy: 'b' });
  const partial = overallConfidence([{ name: 'a', metric: scored('high') }, { name: 'b', metric: { status: 'insufficient', reason: 'x' } }]);
  assert.equal(partial.status, 'not_stated');
});

test('quotes are verified against the retrieved text', () => {
  const text = 'Our oat cleanser is made for sensitive and reactive skin, and it is fragrance-free.';
  assert.ok(quoteAppearsIn('made for sensitive and reactive skin', text));
  assert.ok(quoteAppearsIn('Made for SENSITIVE and reactive skin!', text));
  assert.ok(!quoteAppearsIn('the best cleanser in the world', text));
  assert.ok(!quoteAppearsIn('skin', text), 'very short quotes are not accepted');
});

test('sponsorship is flagged only when identifiable', () => {
  assert.deepEqual(detectSponsorship('A plain review of the product.'), []);
  assert.ok(detectSponsorship('This video is sponsored by Brand. Use my code X.').length >= 2);
  assert.ok(detectSponsorship('Honest review', true).includes('YouTube paid-promotion flag'));
  assert.ok(detectSponsorship('We may earn a commission from links.').length === 1);
});

test('helpers: domains and page boilerplate', () => {
  assert.equal(cleanDomain('https://www.Glowwell.com/shop'), 'glowwell.com');
  assert.equal(cleanDomain('not a domain'), '');
  const stripped = stripBoilerplate('[Home](/) [Shop](/shop) [About](/about)\n\n# Title\n\nReal sentence about the product that should be kept.');
  assert.ok(stripped.includes('Real sentence'));
  assert.ok(!stripped.includes('Shop'));
});

test('input validation rejects junk and normalises the cache key', () => {
  const ok = validateAuditInput({ brand: '  The   Ordinary ', category: 'skincare' });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.cacheKey, 'skincare:ordinary');
  assert.equal(validateAuditInput({ brand: 'x', category: 'skincare' }).ok, false);
  assert.equal(validateAuditInput({ brand: 'https://brand.com', category: 'skincare' }).ok, false);
  assert.equal(validateAuditInput({ brand: 'Brand <script>', category: 'skincare' }).ok, false);
  assert.equal(validateAuditInput({ brand: 'Brand', category: 'nope' }).ok, false);
  assert.equal(validateAuditInput({ brand: 'Brand', category: 'other' }).ok, false);
  const other = validateAuditInput({ brand: 'Brand', category: 'other', customCategory: 'Running Shoes' });
  assert.ok(other.ok);
  if (other.ok) assert.equal(other.value.cacheKey, 'other:running-shoes:brand');
});

test('model output is validated leniently: bad entries are dropped, not trusted', () => {
  const parsed = AskAnswerSchema.parse({ answer: ' An answer ', recommendations: [{ brand: 'A', why: 'x' }, { why: 'no brand' }, 'junk', { brand: '', why: 'empty' }] });
  assert.equal(parsed.answer, 'An answer');
  assert.deepEqual(parsed.recommendations.map((r) => r.brand), ['A']);
  assert.deepEqual(parsed.also_mentioned, []);
  assert.throws(() => AskAnswerSchema.parse({ answer: '' }));
  const labels = LabelsSchema.parse({ labels: [{ id: 'd1.', relevant: 'true', voice: 'alien', sentiment: 'positive' }] });
  assert.deepEqual(labels.labels[0], { id: 'D1', relevant: true, voice: 'unclear', sentiment: 'positive' });
});

test('the example report agrees with the formulas it illustrates', () => {
  const r = EXAMPLE_REPORT;
  const outOfRange = new Map([['q5', 'illustrative']]);
  const v = scoreVisibility({ brand: r.brand, answers: r.answers, outOfRange });
  assert.equal(v.metric.status === 'scored' ? v.metric.score : -1, r.visibility.metric.status === 'scored' ? r.visibility.metric.score : -2);
  assert.equal(v.detail.counted, r.visibility.detail.counted);
  assert.equal(v.detail.creditSum, r.visibility.detail.creditSum);
  const counted = new Set(v.detail.rows.filter((row) => row.state === 'counted').map((row) => row.questionId));
  for (const row of r.competitors.rows.filter((c) => !c.isAuditedBrand)) {
    const computed = visibilityOverQuestions(row.name, r.answers, counted);
    assert.equal(computed.score, row.visibility.status === 'scored' ? row.visibility.score : -1, row.name);
    assert.equal(computed.appearances, row.appearances, row.name);
  }
  assert.deepEqual(rankCompetitors(r.answers, r.brand).map((c) => c.name), r.competitors.rows.filter((c) => !c.isAuditedBrand).map((c) => c.name));
  assert.equal(sentimentScore(r.perception.detail.weighted), r.perception.metric.status === 'scored' ? r.perception.metric.score : -1);
  const gap = scoreContentGap({ domain: 'x', pagesRead: 9, sections: ['a', 'b', 'c'], analysisAvailable: true, checklist: r.contentGap.detail.checklist });
  assert.equal(gap.status === 'scored' ? gap.score : -1, r.contentGap.metric.status === 'scored' ? r.contentGap.metric.score : -2);
});
