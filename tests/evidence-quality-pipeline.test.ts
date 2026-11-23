// Evidence-quality changes (report format 9): whole audits over SIMULATED services.
//
// Redis and the Lua scripts are REAL (a local redis-server behind the Upstash REST shim). Gemini, Tavily and YouTube are
// simulated (tests/helpers/mock-apis.ts). Nothing here contacts a real service, so these tests prove the engine's rules
// only. Every page, title and comment is INVENTED.
//
// Covers: the pipeline parts of group D (title and snippet judged separately, in the web and YouTube stages), group H
// (the matched-context field on web, video and comment entries; none on reader and domain entries), and group I
// (the report carries format 9 and what the pipeline saves is read back with the field intact).
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { advanceJob, startAudit } from '../lib/audit/pipeline';
import { loadJob } from '../lib/cache/jobs';
import { loadReport } from '../lib/cache/reports';
import { resetGeminiFeatureMemory } from '../lib/clients/gemini';
import { REPORT_FORMAT_VERSION } from '../lib/config';
import type { JobSnapshot, Report } from '../lib/types';
import { validateAuditInput } from '../lib/validation/input';
import { installMockFetch, newMockState, type MockState, type Scenario } from './helpers/mock-apis';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
let state: MockState;
let restoreFetch: () => void;
const realLog = console.log;
let visitor = 0;

before(async () => {
  shim = await startShim(6399, 11);
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  process.env.GEMINI_API_KEY = 'made-up-gemini-value-for-tests-0001';
  process.env.TAVILY_API_KEY = 'made-up-tavily-value-for-tests-0002';
  process.env.YOUTUBE_API_KEY = 'made-up-youtube-value-for-tests-0003';
  process.env.DAILY_SCAN_LIMIT = '3';
  process.env.PER_VISITOR_DAILY_LIMIT = '50';
  delete process.env.GEMINI_RPM;
  delete process.env.GEMINI_RPD;
  state = newMockState();
  restoreFetch = installMockFetch(state, shim.url);
  console.log = () => undefined;
});
after(async () => {
  console.log = realLog;
  restoreFetch();
  await shim.close();
});
beforeEach(async () => {
  await shim.flush();
  resetGeminiFeatureMemory();
  Object.assign(state, newMockState());
});

async function runToEnd(id: string): Promise<JobSnapshot> {
  for (let calls = 1; calls <= 150; calls += 1) {
    const snapshot = await advanceJob(id);
    assert.ok(snapshot, 'the audit should exist');
    if (snapshot.waitSeconds) await shim.raw('DEL', 'si:gemini:cooldown');
    if (['complete', 'failed', 'identity_failed'].includes(snapshot.status)) return snapshot;
  }
  throw new Error('the audit did not finish');
}

async function audit(brand: string): Promise<{ id: string; report: Report }> {
  const parsed = validateAuditInput({ brand, category: 'fashion' });
  if (!parsed.ok) throw new Error(parsed.message);
  visitor += 1;
  const started = await startAudit(parsed.value, `203.0.117.${visitor}`);
  assert.equal(started.body.status, 'started');
  if (started.body.status !== 'started') throw new Error('not started');
  const last = await runToEnd(started.body.id);
  assert.equal(last.status, 'complete');
  return { id: started.body.id, report: (await loadReport(started.body.id)) as Report };
}

const REVIEW_AW = {
  title: 'COS A/W 2026: what is worth buying',
  url: 'https://styleblog.example.org/cos-aw-2026',
  content: 'I tried the COS A/W 2026 knitwear and the wool coat for a month, and the knitwear pilled a little while the coat kept its shape well.',
};
const REVIEW_PLAIN = {
  title: 'COS coats: an honest review',
  url: 'https://styleblog.example.org/cos-coat-review',
  content: 'I have worn my COS wool coat for three winters and it has kept its shape, although the sleeves are long and the price is not low at all.',
};
const REVIEW_CAPTION = {
  title: 'A capsule collection from a minimalist label | News | Example Journal',
  url: 'https://journal.example.org/news/capsule',
  content: 'The capsule reinterprets a classic chair in knitwear.\nImage © COS\nCOS designer Jane Doe shares the thinking behind the range and the fabrics that were chosen for it.',
};
const REVIEW_LOOKALIKE = {
  title: 'COS winter coat review',
  url: 'https://styleblog.example.org/cos-vs-cos-iq',
  content: 'We tested the coat for a month, and also tried a COS IQ serum from a different company, which has nothing to do with the clothing label at all.',
};
const OWN_PAGE = {
  title: 'COS: help and delivery',
  url: 'https://www.cos.com/en/help/delivery',
  content: 'COS delivery usually takes three to five working days, and COS accepts returns for thirty days after the order arrives, with details on this page.',
};

const cosFashion = (extra: Partial<Scenario> = {}): Scenario => ({
  brand: 'COS',
  recognised: true,
  officialDomain: 'https://www.cos.com/',
  siteDomain: 'cos.com',
  reviews: [REVIEW_PLAIN, OWN_PAGE],
  recommends: ['COS', 'Arket', 'Uniqlo'],
  videoTitles: [],
  ...extra,
});

test('D3/H: web results: an "A/W" page and a caption-then-sentence page are evidence; a real look-alike page is set aside with its exact context', async () => {
  state.scenario = cosFashion({ reviews: [REVIEW_AW, REVIEW_PLAIN, REVIEW_CAPTION, REVIEW_LOOKALIKE, OWN_PAGE], fixIds: ['R1', 'R2'] });
  const { id, report } = await audit('COS');
  const job = await loadJob(id);
  assert.ok(job);
  const urls = report.evidence.map((e) => e.url);
  assert.ok(urls.includes(REVIEW_AW.url), 'the "A/W" page is counted');
  assert.ok(urls.includes(REVIEW_CAPTION.url), 'the caption page is counted');
  assert.ok(urls.includes(REVIEW_PLAIN.url));
  assert.ok(!urls.includes(REVIEW_LOOKALIKE.url), 'the page that names COS IQ is not counted');

  const aside = report.identity?.setAside ?? [];
  assert.ok(!aside.some((e) => e.url === REVIEW_AW.url || e.url === REVIEW_CAPTION.url), 'neither false positive is listed');
  const entry = aside.find((e) => e.url === REVIEW_LOOKALIKE.url);
  assert.ok(entry, 'listed under "Found but not counted"');
  assert.match(entry.reason, /Names both "COS" and "COS IQ"/);
  assert.ok(entry.matchedContext, 'carries the context that triggered it');
  assert.equal(entry.matchedContext.field, 'snippet');
  assert.equal(entry.matchedContext.rule, 'follower');
  assert.equal(entry.matchedContext.text.slice(entry.matchedContext.markFrom, entry.matchedContext.markTo), 'COS IQ');
  assert.ok(entry.matchedContext.text.length <= 160);
  assert.equal(report.version, 10);
  assert.equal(report.version, REPORT_FORMAT_VERSION);
});

test('D3/H10: YouTube: an "A/W" video is kept and its comments are read; a look-alike video and a look-alike comment are set aside with context', async () => {
  state.scenario = cosFashion({
    videoTitles: ['Skip COS A/W 2026 until you watch this', 'COS IQ vs COS winter coat', 'COS winter coat review'],
    videoComments: [
      'My COS wool coat has lasted three winters of daily wear and still looks new, which I did not expect.',
      'I switched from COS IQ to COS and the coat fit better than anything else I have tried before now.',
      'The COS knitwear is lovely but it does pill after a season, so I wash it very carefully by hand.',
    ],
  });
  const { id, report } = await audit('COS');
  const job = await loadJob(id);
  assert.ok(job?.data.youtube);
  const youtube = job.data.youtube;
  assert.deepEqual(youtube.videos.map((v) => v.title), ['Skip COS A/W 2026 until you watch this', 'COS winter coat review'], 'the A/W video is used; the COS IQ video is not');
  assert.ok(youtube.comments.some((c) => c.sourceUrl?.includes('sv0')), 'the comments of the "A/W" video were read');
  assert.ok(youtube.comments.every((c) => !c.sourceUrl?.includes('sv1')), 'the look-alike video was never opened');

  const aside = report.identity?.setAside ?? [];
  const video = aside.find((e) => e.title === 'COS IQ vs COS winter coat');
  assert.ok(video?.matchedContext, 'the look-alike video carries its context');
  assert.equal(video.matchedContext.field, 'title');
  assert.equal(video.matchedContext.text.slice(video.matchedContext.markFrom, video.matchedContext.markTo), 'COS IQ');
  const comment = aside.find((e) => e.title.startsWith('Comment on'));
  assert.ok(comment?.matchedContext, 'D5: the look-alike comment carries its context');
  assert.equal(comment.matchedContext.field, 'comment');
  assert.equal(comment.matchedContext.text.slice(comment.matchedContext.markFrom, comment.matchedContext.markTo), 'COS IQ');
  assert.ok(comment.matchedContext.text.includes('I switched from'), 'the words around the trigger are kept');
});

test('H11: an entry that comes from the reader\'s "mixed" answer, or from a web address that resembles the name, has no matchedContext', async () => {
  state.scenario = cosFashion({
    reviews: [REVIEW_PLAIN, REVIEW_AW, OWN_PAGE, { title: 'Cosgram shop picks', url: 'https://cosgramusa.example.com/picks', content: 'Our picks of the season from the shop, with details of delivery, sizing and returns for each of the items listed here today.' }],
    sameBusiness: (idOfItem) => (idOfItem === 'R1' ? 'mixed' : 'yes'),
    fixIds: ['R2', 'R3'],
  });
  const { report } = await audit('COS');
  const aside = report.identity?.setAside ?? [];
  assert.ok(aside.length >= 1, 'something was set aside');
  for (const entry of aside) assert.equal('matchedContext' in entry && entry.matchedContext !== undefined, false, `${entry.reason} has no matched text`);
  assert.ok(aside.some((e) => /discuss both COS and a different business/.test(e.reason)), 'the reader\'s "mixed" entry is listed');
});

test('I4: the report the pipeline builds carries the shared format constant, and the field survives being saved and loaded', async () => {
  state.scenario = cosFashion({ reviews: [REVIEW_PLAIN, REVIEW_LOOKALIKE, OWN_PAGE] });
  const { id, report } = await audit('COS');
  assert.equal(report.version, REPORT_FORMAT_VERSION);
  assert.equal(await shim.raw('EXISTS', `si:report:v${REPORT_FORMAT_VERSION}:${id}`), 1);
  const reloaded = (await loadReport(id)) as Report;
  assert.deepEqual(reloaded.identity?.setAside, report.identity?.setAside);
  assert.ok(reloaded.identity?.setAside.some((e) => e.matchedContext !== undefined));
});

test('H16: entries the real pipeline sets aside from long snippets keep their context within 160 characters and about 260 bytes each', async () => {
  const filler = 'the fabric and the cut of the coat were discussed at length by several people over many weeks, ';
  const long = (n: number) => ({
    title: `COS winter coat review ${n}`,
    url: `https://styleblog.example.org/long-${n}`,
    content: `${filler.repeat(4)}We also tried a COS IQ serum from a different company, which has nothing to do with the label. ${filler.repeat(4)}`,
  });
  state.scenario = cosFashion({ reviews: [REVIEW_PLAIN, long(1), long(2), long(3), OWN_PAGE] });
  const { report } = await audit('COS');
  const entries = (report.identity?.setAside ?? []).filter((e) => e.url.includes('/long-'));
  assert.equal(entries.length, 3, 'all three long pages were set aside');
  for (const entry of entries) {
    const c = entry.matchedContext;
    assert.ok(c, 'each carries its context');
    assert.ok(c.text.length <= 160, `context is ${c.text.length} characters`);
    assert.ok(c.text.startsWith('…') && c.text.endsWith('…'), 'cut on both sides, marked');
    assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS IQ');
    assert.ok(Buffer.byteLength(JSON.stringify(c)) < 260, `the field is ${Buffer.byteLength(JSON.stringify(c))} bytes`);
  }
});

test('J5: a format 9 COS report in the cache is not reused; the new audit runs under format 10 and counts the company-profile page the format 9 matcher set aside', async () => {
  const PROFILE = {
    title: 'COS',
    url: 'https://profiles.example.org/company/cos',
    content: '# COS ID: Ab12Cd34 Website: www.cos.com Headquarters: London. Industry: clothing and fashion retail, with stores in many cities.',
  };
  // What a format 9 deployment left behind: a cached COS report that set this page aside, and its pointer.
  const oldId = 'c9c9c9c9c9c9c9c9c9c9c9c9';
  const oldReport = JSON.stringify({ id: oldId, version: 9, brand: 'COS', identity: { setAside: [{ title: 'COS', url: PROFILE.url, domain: 'profiles.example.org', reason: 'Names both "COS" and "COS ID" (a different name), so what it says cannot be attributed to COS.' }] } });
  await shim.raw('SET', `si:report:v9:${oldId}`, oldReport);
  await shim.raw('SET', 'si:cache:v9:fashion:cos', oldId);

  state.scenario = cosFashion({ reviews: [REVIEW_PLAIN, PROFILE, OWN_PAGE] });
  const { id, report } = await audit('COS');
  assert.notEqual(id, oldId, 'a new audit ran instead of the cached format 9 report being served');
  assert.equal(report.version, 10);
  assert.equal(await shim.raw('EXISTS', `si:report:v10:${id}`), 1);
  assert.equal(await shim.raw('GET', 'si:cache:v10:fashion:cos'), id);
  assert.ok(report.evidence.some((e) => e.url === PROFILE.url), 'the profile page is counted under the updated matcher');
  assert.ok(!(report.identity?.setAside ?? []).some((e) => e.url === PROFILE.url), 'and is not listed as set aside');
  // The format 9 report and its pointer are untouched and the old report still opens by its id.
  assert.equal(await shim.raw('GET', `si:report:v9:${oldId}`), oldReport);
  assert.equal(await shim.raw('GET', 'si:cache:v9:fashion:cos'), oldId);
  assert.equal((await loadReport(oldId))?.version, 9);
});
