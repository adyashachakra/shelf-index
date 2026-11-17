// End-to-end engine test: a whole audit, start to finished report.
// Redis and the Lua scripts are REAL. Gemini, Tavily and YouTube are SIMULATED with canned
// responses shaped like the documented APIs (see tests/helpers/mock-apis.ts).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { getNumber } from '../lib/clients/redis';
import { USER_MESSAGES } from '../lib/config';
import { redact } from '../lib/log';
import { reservationState } from '../lib/quota/reservations';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const logged: string[] = [];
const realLog = console.log;

before(async () => {
  shim = await startShim(6399, 2);
  await shim.flush();
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3';
  process.env.PER_VISITOR_DAILY_LIMIT = '1';
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  state = newMockState();
  restoreFetch = installMockFetch(state, shim.url);
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  await shim.close();
});

function input(brand: string) {
  const parsed = validateAuditInput({ brand, category: 'skincare' });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

async function runToEnd(id: string): Promise<{ last: JobSnapshot; calls: number; waits: string[] }> {
  const waits: string[] = [];
  for (let calls = 1; calls <= 120; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds && snapshot.waitReason) {
      waits.push(snapshot.waitReason);
      await shim.raw('DEL', 'si:gemini:cooldown'); // skip the real-time wait in tests
    }
    if (snapshot.status === 'complete' || snapshot.status === 'failed') return { last: snapshot, calls, waits };
  }
  throw new Error('the audit did not finish');
}

let firstId = '';
let report: Report;

test('a full audit runs stage by stage to a finished report', async () => {
  resetGeminiFeatureMemory();
  state.rejectJsonSchemaOnce = true; // the API rejects the newest JSON field once
  state.rateLimitOnce = true; // and returns one per-minute rate limit
  state.failQuestionContaining = 'luxury skincare'; // and never answers question 8

  const started = await startAudit(input('Glowwell'), '203.0.113.9');
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') return;
  firstId = started.body.id;

  const { last, calls, waits } = await runToEnd(firstId);
  assert.equal(last.status, 'complete', last.error ?? 'the audit did not complete');
  assert.ok(calls >= 11, 'one stage per request');
  assert.ok(last.stages.every((s) => s.state === 'done'));
  assert.ok(waits.includes('Gemini asked us to slow down'), 'the rate limit became a visible wait, not a failure');

  const loaded = await loadReport(firstId);
  assert.ok(loaded);
  report = loaded as Report;
  // Optional: save this report so the page-render check can display a report the engine produced.
  if (process.env.SI_DUMP_REPORT) writeFileSync(process.env.SI_DUMP_REPORT, JSON.stringify(report));
  assert.equal(report.model, 'gemini-3.5-flash-lite', 'the model name comes from what the API reported');
  assert.equal(report.methodology.modelConfigured, 'gemini-3.5-flash-lite');
  assert.ok(report.methodology.modelNote.includes('free tier'));
  assert.equal(report.version, 7);
});

test('visibility: failed answers are missing data, range exclusions need evidence', () => {
  const d = report.visibility.detail;
  assert.equal(d.planned, 8);
  assert.equal(d.failed, 1, 'question 8 never got an answer');
  assert.equal(d.excluded, 1, 'only q5 is excluded');
  assert.equal(d.counted, 6);
  assert.equal(d.rows.find((r) => r.questionId === 'q8')?.state, 'no_answer');
  assert.equal(d.rows.find((r) => r.questionId === 'q5')?.state, 'excluded');
  assert.equal(d.rows.find((r) => r.questionId === 'q3')?.state, 'counted', 'the brand was named there, so it cannot be excluded');
  assert.deepEqual(d.rows.find((r) => r.questionId === 'q7')?.placement, { kind: 'recommended', position: 3 }, 'a listed brand absent from the answer text is ignored');
  // credits: q1 2nd 0.85, q2 0, q3 1st 1.00, q4 0, q6 named 0.20, q7 3rd 0.70 = 2.75 over 6
  assert.equal(d.creditSum, 2.75);
  assert.deepEqual(report.visibility.metric.status === 'scored' && [report.visibility.metric.score, report.visibility.metric.confidence], [46, 'medium']);
});

test('perception: raw and weighted counts, verified themes, sponsorship disclosed', () => {
  const p = report.perception;
  const d = p.detail;
  assert.equal(d.itemsRetrieved, 18, '6 threads + 4 pages + 2 videos + 6 comments (brand site, Instagram, spam and off-topic items dropped)');
  assert.deepEqual({ positive: d.raw.positive, mixed: d.raw.mixed, negative: d.raw.negative, counted: d.raw.counted }, { positive: 9, mixed: 4, negative: 3, counted: 16 });
  assert.equal(d.raw.neutral, 1);
  assert.equal(d.raw.irrelevant, 1);
  assert.deepEqual(d.weighted, { positive: 7.5, mixed: 3, negative: 3, total: 13.5 });
  assert.deepEqual(p.metric.status === 'scored' && [p.metric.score, p.metric.confidence], [67, 'medium']);
  assert.equal(d.uniqueDomains.length, 5);
  assert.deepEqual(d.sourceTypes, ['customer', 'creator', 'publication']);
  assert.deepEqual(p.praise.map((t) => t.label), ['Gentle on skin'], 'a theme with one source is dropped');
  assert.deepEqual(p.praise[0].evidenceIds, ['D1', 'D4']);
  assert.ok(p.praise[0].quote, 'a quote found in its source is kept');
  assert.deepEqual([p.praise[0].itemCount, p.praise[0].sourceCount], [2, 2], 'reach is counted in code, not taken from the model');
  assert.deepEqual([p.praise[0].scope, p.praise[0].product], ['product', 'oat cleanser'], 'the product is named in the evidence');
  assert.deepEqual(p.complaints[0].evidenceIds, ['D2', 'C2'], 'an id that does not exist is removed');
  assert.equal(p.complaints[0].quote, undefined, 'a quote not found in its source is removed');
  assert.deepEqual([p.complaints[0].sourceCount, p.complaints[0].scope, p.complaints[0].product], [2, 'unclear', undefined], 'a product the evidence never names is not kept');
  assert.deepEqual(
    [p.complaints[1].label, p.complaints[1].summary],
    ['Reported experience 2', '2 separate sources report this in their own words. See the sources listed here.'],
    'a complaint worded as a cause or a brand-wide verdict is replaced by a plain count',
  );
  // Opinions, individual comments and unique sources are three different counts.
  assert.deepEqual(d.sample.read, { discussions: 6, reviews: 4, videos: 2, comments: 6 });
  assert.deepEqual(d.sample.counted, { discussions: 5, reviews: 3, videos: 2, comments: 6 });
  assert.equal(d.sample.read.comments + d.sample.read.discussions + d.sample.read.reviews + d.sample.read.videos, d.itemsRetrieved);
  assert.ok(d.uniqueSources < d.raw.counted, 'several opinions share a source');
  assert.equal(d.sourcesAboutBrand, 11);
  assert.deepEqual(p.advocacy.map((a) => a.evidenceId), ['D1'], 'a negative item cannot be advocacy');
  const sponsored = new Map(d.sponsoredItems.map((s) => [s.evidenceId, s.signals]));
  assert.ok(sponsored.get('V1')?.includes('YouTube paid-promotion flag'));
  assert.ok(sponsored.has('R1'), 'an affiliate notice in a review is disclosed');
  assert.ok(!report.evidence.some((e) => e.domain.includes('instagram')), 'social platforms are never used');
  assert.ok(!JSON.stringify(report).includes('Should Not Be Stored'), 'comment author names are not kept');
});

test('content gap: relevance check, verified quotes, downgrade when a quote cannot be found', () => {
  const g = report.contentGap;
  assert.equal(g.detail.domain, 'glowwell.com');
  assert.equal(g.detail.pagesRead, 6, 'a too-short page and a page from another domain are not counted');
  // q5: the site sells nothing of that kind. q8: a luxury question, and an independent source calls the brand a drugstore brand.
  assert.deepEqual(g.detail.excluded.map((e) => [e.questionId, e.kind]), [['q5', 'product_range'], ['q8', 'price_tier']]);
  // The simulated model also called q8 "out of range" for a positioning reason. That reason must not appear:
  // the luxury question is left out on the price rule, with the source's words.
  assert.ok(!g.detail.excluded[1].reason.includes('positioned as'), 'the model\'s own price judgement is not used as the reason');
  const priceExclusion = g.detail.excluded[1];
  assert.ok(priceExclusion.reason.includes('affordable drugstore'), 'the exclusion quotes the words that establish the price tier');
  assert.ok(priceExclusion.reason.includes('beautydesk.example.com') && priceExclusion.sourceUrl?.startsWith('https://beautydesk.example.com'));
  assert.deepEqual([g.detail.pricePosition?.tier, g.detail.pricePosition?.origin], ['budget', 'independent_source']);
  assert.equal(g.detail.pricePosition?.evidenceId, 'R2', 'the claimed "premium" from the site had no price word in its quote and was rejected');
  assert.deepEqual(g.detail.productLines.map((l) => l.name), ['Cleansers', 'Moisturisers', 'Sunscreen'], 'a product line with an unverifiable quote is dropped');
  const byId = new Map(g.detail.checklist.map((c) => [c.id, c]));
  assert.equal(g.detail.checklist.length, 8, '6 questions in range + 2 customer concerns');
  // Patch 6: "best skincare brands" is a claim question and the quote is the brand describing itself, so a verdict of "clear" is "touched on, brand claim".
  assert.deepEqual([byId.get('q1')?.level, byId.get('q1')?.brandClaim], ['partial', true]);
  assert.match(byId.get('q1')?.relevanceNote ?? '', /brand's own statement on its website/);
  assert.deepEqual([byId.get('q2')?.level, byId.get('q2')?.downgraded], ['none', true]);
  assert.equal(byId.get('q3')?.geminiNamedBrand, true);
  assert.equal(byId.has('q8'), false, 'a brand is not marked down for failing to answer a question outside its price tier');
  assert.equal(byId.get('c1')?.source, 'customer_concern');
  // No verdict came back for q4: it is left out of the score (a missing answer is not proof the site fails to address it), flagged and reported.
  assert.deepEqual([byId.get('q4')?.level, byId.get('q4')?.unanswered], ['none', true]);
  assert.equal(byId.get('q6')?.unanswered, undefined, 'an explicit "none" is not a missing verdict');
  assert.ok(report.warnings.some((w) => w.includes('returned no verdict for 1 of the 8 checklist items') && w.includes('left out of the content gap score')));
  // ...and the runtime log says how many verdicts were asked for, how many came back and which were missing.
  const coverageLine = logged.find((line) => line.includes('"event":"site_coverage"'));
  assert.ok(coverageLine, 'the site-analysis step logs its verdict counts');
  assert.deepEqual(
    (({ asked, returned, missing }) => ({ asked, returned, missing }))(JSON.parse(coverageLine) as { asked: number; returned: number; missing: string }),
    { asked: 10, returned: 9, missing: 'q4' },
  );
  // Patch 3: two independent domains (a review title and an article) state the price tier, so q8 is still left out.
  assert.equal(g.detail.priceSupport?.status, 'established');
  assert.equal(g.detail.priceSupport?.sources.length, 2);
  assert.ok(priceExclusion.sources?.length === 2, 'the exclusion lists both sources');
  // Patch 3: a verdict whose link to the question is not confirmed, and evidence about a different product.
  assert.deepEqual([byId.get('q6')?.level, byId.get('q6')?.relevance], ['none', 'uncertain'], 'the model said "clear" but not how the quote relates to the question');
  assert.deepEqual([byId.get('c2')?.level, byId.get('c2')?.relevance, byId.get('c2')?.evidenceAbout], ['none', 'different_product', 'sunscreen'], 'a sunscreen quote does not answer a cleanser concern');
  assert.equal(byId.get('c2')?.quote, undefined, 'the unrelated quote is not shown as support');
  assert.deepEqual([byId.get('q1')?.level, byId.get('q1')?.relevance], ['partial', 'brand_wide']);
  // Patch 6: a question of fact ("how long does shipping take?") is not a claim question, so it is not marked as a brand claim.
  assert.equal(byId.get('c1')?.brandClaim, undefined);
  assert.equal(byId.get('q7')?.level, 'partial', 'q7 was clear before patch 6; "best clean or fragrance-free brands" asks for a claim');
  assert.equal(byId.get('q7')?.brandClaim, true);
  assert.ok(report.warnings.some((w) => w.includes('could not be tied to the question')), 'the uncertain item is reported');
  const loggedCoverage = JSON.parse(coverageLine) as { different: string; uncertain: string };
  assert.deepEqual([loggedCoverage.different, loggedCoverage.uncertain], ['c2', 'q6'], 'ids only, never page text');
  // Product range: three lines confirmed, one candidate that could not be, and the real page count.
  assert.deepEqual([g.detail.productRange?.status, g.detail.productRange?.linesIdentified, g.detail.productRange?.unverified, g.detail.productRange?.pagesRead], ['identified', 3, 1, 6]);
  // Left out of the score (q4: no verdict, q6: not tied to the question). Assessed: q1 q7 partial as brand claims (1),
  // c1 partial (0.5), q2 q3 c2 not addressed (3) -> 4.5 / 6 = 75. Same formula as before. (Before patch 6, q1 and q7 were
  // "clear" and this was 3.5 / 6 = 58; had the sunscreen quote been accepted as a clear answer, 2.5 / 6 = 42.)
  // Six pages across two sections is "medium"; two items were left out, so it drops to "low".
  assert.deepEqual(g.metric.status === 'scored' && [g.metric.score, g.metric.confidence], [75, 'low']);
  assert.ok(g.metric.status === 'scored' && g.metric.confidenceReason.includes('2 of the 8 checklist items could not be assessed'));
  assert.equal(g.detail.points, 4.5);
});

test('claims: a verdict stands only when its quote is found in the source', () => {
  assert.equal(report.claims.length, 3);
  assert.equal(report.claims[0].type, 'availability', 'the most checkable claim is checked first');
  assert.equal(report.claims[0].verdict, 'supported');
  assert.ok(report.claims[0].url);
  assert.equal(report.claims[1].verdict, 'unverified', 'a fabricated quote cannot contradict anything');
});

test('insights and fixes without traceable evidence are discarded', () => {
  assert.deepEqual(report.disconnect.disagreements.map((d) => [d.title, d.audienceSourceCount]), [['Shipping', 1]]);
  const checks = new Map(report.betweenTheLines.map((c) => [c.id, c]));
  assert.equal(report.betweenTheLines.length, 7);
  assert.equal(checks.get('signature_claim')?.status, 'observed', 'a competitor is named first for the signature claim');
  assert.equal(checks.get('signature_claim')?.strength, 'established');

  // Positioning against complaints: found by going through every complaint theme, then graded in code.
  const tension = checks.get('positioning_contradiction');
  assert.equal(tension?.status, 'observed');
  assert.deepEqual([tension?.strength, tension?.statusLabel], ['tentative', 'Potential tension, limited evidence'], 'two sources are not a verified contradiction');
  assert.ok(tension?.observed?.includes('potential tension, not a verified contradiction'));
  assert.ok(tension?.observed?.includes('2 customer or reviewer sources'));
  assert.deepEqual(tension?.evidence.map((e) => e.id), ['S1', 'D2', 'C2'], 'the statement page and the complaint evidence, nothing invented');
  assert.ok(tension?.evidence[0].label.startsWith('Brand site states: "'), 'the exact statement from the site is shown, not just a page title');
  assert.ok((tension?.evidence[0].quote ?? '') !== '', 'with the words found on the page');
  assert.ok(!tension?.observed?.includes('names no exact statement'), 'a reading that points at no exact statement is not used');
  assert.ok(!tension?.whyItMatters?.match(/trust|sales|conversion/i), 'no commercial claim in the interpretation');

  // Range recognition is counted from the product list Gemini gave when asked what the brand sells.
  // The simulated comparison step also proposed its own reading of this pattern: that reading is ignored.
  const range = checks.get('narrow_range');
  assert.deepEqual([range?.status, range?.basis, range?.statusLabel], ['not_observed', 'computed', undefined]);
  assert.ok(range?.observed?.includes("Gemini's list: asked what Glowwell sells, Gemini named 2 product types."));
  assert.ok(range?.observed?.includes("The site's range: 3 product lines were found on the pages read from glowwell.com"));
  assert.equal(range?.evidence[0].label, "Gemini's list (what the model says Glowwell sells; not checked against the site): Cleansers, Moisturisers");
  assert.deepEqual(range?.evidence.slice(1).map((e) => e.label), ['Found on glowwell.com: Cleansers', 'Found on glowwell.com: Moisturisers', 'Found on glowwell.com: Sunscreen']);
  assert.ok(!JSON.stringify(range).includes('Caps reach'), "the model's own reading of the range is not used");

  assert.equal(checks.get('complaint_as_fact')?.status, 'not_observed', 'an insight citing only the model is not accepted');
  assert.equal(checks.get('volume_vs_visibility')?.status, 'not_observed');

  // Presence in sources does not show which sources Gemini relies on.
  const footprint = checks.get('source_footprint');
  assert.equal(footprint?.status, 'cannot_assess');
  assert.ok(footprint?.reason?.includes('cannot tell which sources Gemini relies on'));
  assert.equal(footprint?.evidence.length, 3);
  assert.ok(footprint?.evidence.every((e) => e.label.startsWith('Measured: ')));
  for (const check of report.betweenTheLines) {
    if (check.status === 'observed') assert.ok(check.evidence.length >= 2, `${check.id} must show its evidence`);
  }
  assert.deepEqual(report.fixes.map((f) => f.priority), [1, 2]);
  assert.deepEqual(
    report.fixes.map((f) => f.evidenceBase),
    ["1 customer or reviewer source, 1 page of the brand's own site", '1 Gemini answer'],
    'the evidence behind each recommendation is counted in code',
  );
  // The model overclaimed on purpose in the simulated answers. None of it reaches the report.
  assert.ok(report.fixes[0].why.startsWith('The explanation written for this recommendation claimed more than the evidence shows'), 'a cause or outcome in "why" is not displayed');
  assert.ok(report.fixes[0].expectedImpact.startsWith('If this is done, a later audit could show'), 'a promised result becomes a neutral hypothesis');
  assert.ok(report.fixes[1].expectedImpact.startsWith('If the range is explained'), 'a properly worded hypothesis is kept as written');
  // The model's own counts of sources are removed: the report shows the count the code made.
  assert.equal(report.fixes[1].why, 'Gemini names one product.');
  assert.equal(report.disconnect.disagreements[0].audienceSays, 'Delivery is slow.');
  assert.equal(report.disconnect.disagreements[0].audienceSourceCount, 1, 'the model said three; the cited evidence comes from one source');
  assert.equal(report.disconnect.disagreements[0].implication, '', 'a predicted business outcome is removed');
  assert.ok(!/churn|trust|conversion|loyalty|sales/i.test(JSON.stringify([report.fixes, report.disconnect.disagreements])));
  assert.ok(report.fixesNote?.includes('Only 2'));
  assert.ok(!report.fixes.some((f) => f.action.includes('courier')), 'an action that asserts a cause or a business result is left out');
  assert.equal(report.disconnect.status, 'assessed');
  assert.equal(report.disconnect.direction, 'ai_under', 'perception 67 vs visibility 46: people rate it better than Gemini recommends it');
  assert.equal(report.disconnect.gap, 46 - 67);
  assert.equal(report.overallConfidence.status, 'stated');
});

test('competitors: visibility from the same questions; nothing invented', () => {
  const rows = report.competitors.rows;
  assert.deepEqual(rows.map((r) => r.name), ['Glowwell', 'Alba Dermics', 'Verano Labs', 'Mirelle']);
  for (const row of rows.slice(1)) {
    assert.equal(row.visibility.status, 'scored');
    assert.equal(row.contentCoverage.status, 'not_measured');
    assert.ok(row.sentiment.status === 'scored' || row.sentiment.status === 'insufficient');
  }
});

test('credits: every search is accounted for and unused credits are returned', async () => {
  const m = report.methodology;
  assert.equal(m.searches.length, 9);
  assert.equal(m.tavilyCreditsUsed, 9);
  assert.equal(state.tavilyCalls, 9, 'no search was repeated across retries');
  const resv = await reservationState(firstId);
  assert.deepEqual(resv, { reserved: 9, spent: 9, state: 'settled' });
  const monthKeys = (await shim.raw('KEYS', 'si:tavily:20*')) as string[];
  assert.equal(await getNumber(monthKeys[0]), 9);
  assert.equal(m.questions.failed, 1);
  assert.equal(m.youtube.videos, 2);
  assert.equal(m.youtube.comments, 6);
  assert.ok(m.youtube.note?.includes('turned off'));
});

test('keys travel only in headers and never reach the logs', () => {
  assert.ok(state.seenAuthHeaders.every((h) => h.length > 0));
  const allLogs = logged.join('\n');
  assert.ok(allLogs.includes('audit_complete'));
  for (const secret of [process.env.GEMINI_API_KEY, process.env.TAVILY_API_KEY, process.env.YOUTUBE_API_KEY, process.env.UPSTASH_REDIS_REST_TOKEN]) {
    assert.ok(secret && !allLogs.includes(secret), 'a secret appeared in the logs');
  }
  assert.ok(!allLogs.includes('Glowwell oat cleanser is the gentlest'), 'API response content must not be logged');
  // Key-shaped strings are assembled here so this file never contains anything that looks like a real key.
  const googleShaped = `${'AI'}${'za'}${'x'.repeat(35)}`;
  const tavilyShaped = `${'tv'}${'ly-'}${'y'.repeat(32)}`;
  assert.equal(
    redact(`a ${process.env.YOUTUBE_API_KEY} b ${googleShaped} c Bearer abc.def d ${tavilyShaped} e https://x.test/v?key=${'z'.repeat(20)}&part=id`),
    'a [redacted] b [redacted] c [redacted] d [redacted] e https://x.test/v?key=[redacted]&part=id',
  );
});

test('repeat requests are served from the cache; limits and duplicates are enforced', async () => {
  const again = await startAudit(input('glowwell'), '198.51.100.1');
  assert.deepEqual(again.body, { status: 'cached', id: firstId }, 'same brand + category within 7 days costs nothing');

  const sameVisitor = await startAudit(input('Brand Two'), '203.0.113.9');
  assert.deepEqual(sameVisitor.body, { status: 'error', code: 'visitor_limit', message: USER_MESSAGES.visitorLimit });

  const second = await startAudit(input('Brand Two'), '198.51.100.2');
  assert.equal(second.body.status, 'started');
  const duplicate = await startAudit(input('brand two'), '198.51.100.3');
  assert.equal(duplicate.body.status, 'in_progress', 'a second request for a brand already running joins it');
  if (second.body.status === 'started' && duplicate.body.status === 'in_progress') assert.equal(duplicate.body.id, second.body.id);

  // Tavily's own limit is hit during the second audit: it stops with a plain explanation.
  state.tavilyQuotaExhausted = true;
  if (second.body.status !== 'started') return;
  const stopped = await runToEnd(second.body.id);
  assert.equal(stopped.last.status, 'failed');
  assert.equal(stopped.last.error, USER_MESSAGES.monthlyLimit);
  const resv = await reservationState(second.body.id);
  assert.equal(resv?.state, 'settled');
  assert.equal(resv?.spent, 0, 'a search the provider refused is not charged to the budget');
  const blocked = await startAudit(input('Brand Three'), '198.51.100.4');
  assert.deepEqual(blocked.body, { status: 'error', code: 'monthly_limit', message: USER_MESSAGES.monthlyLimit });
});

test('YouTube being unavailable does not stop an audit', async () => {
  state.tavilyQuotaExhausted = false;
  await shim.raw('DEL', ...((await shim.raw('KEYS', 'si:tavily:exhausted:*')) as string[]));
  state.youtubeQuotaExhausted = true;
  state.failQuestionContaining = null;
  const started = await startAudit(input('Glowwell Two'), '198.51.100.5');
  assert.equal(started.body.status, 'started', JSON.stringify(started.body));
  if (started.body.status !== 'started') return;
  const { last } = await runToEnd(started.body.id);
  assert.equal(last.status, 'complete', last.error ?? 'the audit did not complete');
  assert.ok(last.warnings.some((w) => w.includes('YouTube')));
  const loaded = await loadReport(started.body.id);
  assert.equal(loaded?.methodology.youtube.status, 'unavailable');
  assert.ok(loaded?.methodology.unavailable.some((w) => w.includes('YouTube')));
});

test('the daily limit refuses the next audit with the agreed message', async () => {
  // Three slots were configured. Used so far: Glowwell, Glowwell Two (Brand Two was refunded: nothing was spent).
  const third = await startAudit(input('Brand Four'), '198.51.100.6');
  assert.equal(third.body.status, 'started');
  const fourth = await startAudit(input('Brand Five'), '198.51.100.7');
  assert.deepEqual(fourth.body, { status: 'error', code: 'daily_limit', message: USER_MESSAGES.dailyLimit });
  assert.equal(fourth.httpStatus, 429);
});
