// Saved reports across format changes: older reports stay readable exactly as they were saved, and an
// older cached report is never handed to a new audit. Redis is real (local); nothing else is involved.
//
// The fixtures in tests/fixtures are REAL engine output: each was produced by running the audit engine
// of the release that wrote that format (format 2: the first V1.1 preview; format 3: patch 2; format 4:
// patch 3; format 5: patches 4 and 5) over the simulated services, then saved unchanged. They are not hand-written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { GET as status } from '../app/api/audits/[id]/route';
import { findCachedReportId, loadReport, saveReport } from '../lib/cache/reports';
import { cmd } from '../lib/clients/redis';
import { READABLE_REPORT_VERSIONS, REPORT_FORMAT_VERSION } from '../lib/config';
import type { Report } from '../lib/types';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;
const realLog = console.log;

before(async () => {
  shim = await startShim(6399, 4);
  await shim.flush();
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
  console.log = () => undefined;
});
after(async () => {
  console.log = realLog;
  await shim.close();
});

const fixtureText = (version: number) => readFileSync(new URL(`./fixtures/report-format-${version}.json`, import.meta.url), 'utf8');
const fixture = (version: number) => JSON.parse(fixtureText(version)) as Report;
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const fake = (id: string, version: number) => JSON.stringify({ id, version, brand: 'Cetaphil' });

test('the report format is 6; formats 6, 5, 4, 3 and 2 can be opened', () => {
  assert.equal(REPORT_FORMAT_VERSION, 6);
  assert.deepEqual([...READABLE_REPORT_VERSIONS], [6, 5, 4, 3, 2]);
});

test('the fixtures are what they claim to be: real saved reports of formats 2, 3, 4 and 5', () => {
  for (const version of [2, 3, 4, 5]) {
    const report = fixture(version);
    assert.equal(report.version, version);
    assert.match(report.id, /^[0-9a-f]{24}$/);
    assert.ok(report.contentGap.detail.checklist.length > 0 && report.evidence.length > 0, 'a whole report, not a stub');
  }
});

for (const version of [2, 3, 4, 5]) {
  test(`a real format ${version} report opens, and what the API returns is exactly what was saved`, async () => {
    const saved = fixture(version);
    await cmd('SET', `si:report:v${version}:${saved.id}`, fixtureText(version));
    const loaded = await loadReport(saved.id);
    assert.deepEqual(loaded, saved, 'nothing added, nothing removed, nothing rewritten');

    const response = await status(new Request('https://shelf-index.test/api/audits/x'), idContext(saved.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = (await response.json()) as { status: string; report: Report };
    assert.equal(body.status, 'complete');
    assert.deepEqual(Object.keys(body).sort(), ['report', 'status']);
    assert.deepEqual(body.report, saved);
    assert.equal(body.report.version, version);
  });
}

test('format 2 and 3 reports are not given evidence they never had', async () => {
  for (const version of [2, 3]) {
    const saved = fixture(version);
    await cmd('SET', `si:report:v${version}:${saved.id}`, fixtureText(version));
    const loaded = (await loadReport(saved.id)) as Report;
    const detail = loaded.contentGap.detail;
    assert.equal('priceSupport' in detail, false, `format ${version}: no price-source count invented`);
    assert.equal('productRange' in detail, false, `format ${version}: no product-range status invented`);
    assert.ok(
      detail.checklist.every((item) => !('relevance' in item) && !('expertEvidence' in item) && !('evidenceAbout' in item)),
      `format ${version}: no relevance check invented for items that never had one`,
    );
    // What the old report did record is shown as recorded, not upgraded.
    assert.deepEqual(detail.pricePosition, saved.contentGap.detail.pricePosition);
    assert.deepEqual(detail.excluded, saved.contentGap.detail.excluded);
    assert.equal(JSON.stringify(loaded), JSON.stringify(saved));
  }
});

test('a format 5 report is not given a brand-claim reading it never had', async () => {
  // Format 5 (patches 4 and 5) marked unnamed expert claims but had no general "brand claim" rule: an item it
  // recorded as "clear" for a question about what is best stays "clear" when the report is opened.
  const saved = fixture(5);
  await cmd('SET', `si:report:v5:${saved.id}`, fixtureText(5));
  const loaded = (await loadReport(saved.id)) as Report;
  assert.ok(loaded.contentGap.detail.checklist.some((item) => item.level === 'clear'), 'the fixture records clear verdicts');
  assert.ok(loaded.contentGap.detail.checklist.every((item) => !('brandClaim' in item)), 'no brand-claim marking invented');
  assert.equal(JSON.stringify(loaded), JSON.stringify(saved));
});

test('format 1 (V1.0) reports are not read here, and the API says not found', async () => {
  await cmd('SET', 'si:report:v1:ffffffffffffffffffffffff', fake('ffffffffffffffffffffffff', 1));
  assert.equal(await loadReport('ffffffffffffffffffffffff'), null);
  const response = await status(new Request('https://shelf-index.test/api/audits/x'), idContext('ffffffffffffffffffffffff'));
  assert.equal(response.status, 404);
  assert.equal(await loadReport('cccccccccccccccccccccccc'), null, 'an unknown id');
});

test('a new report is stored under format 6 and found first; older cached reports are not offered for a new audit', async () => {
  for (const version of [5, 4, 3, 2]) {
    await cmd('SET', `si:report:v${version}:dddddddddddddddddddddd0${version}`, fake(`dddddddddddddddddddddd0${version}`, version));
    await cmd('SET', `si:cache:v${version}:skincare:cetaphil`, `dddddddddddddddddddddd0${version}`);
  }
  assert.equal(await findCachedReportId('skincare:cetaphil'), null, 'a repeat audit must run again under the new rules');

  await saveReport({ id: 'eeeeeeeeeeeeeeeeeeeeeeee', version: 6 } as unknown as Report, 'skincare:cetaphil');
  assert.equal(await cmd('EXISTS', 'si:report:v6:eeeeeeeeeeeeeeeeeeeeeeee'), 1);
  assert.equal(await findCachedReportId('skincare:cetaphil'), 'eeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal((await loadReport('eeeeeeeeeeeeeeeeeeeeeeee'))?.id, 'eeeeeeeeeeeeeeeeeeeeeeee');
  // The older reports are still readable alongside it.
  assert.equal((await loadReport('dddddddddddddddddddddd05'))?.id, 'dddddddddddddddddddddd05');
  assert.equal((await loadReport('dddddddddddddddddddddd04'))?.id, 'dddddddddddddddddddddd04');
  assert.equal((await loadReport('dddddddddddddddddddddd02'))?.id, 'dddddddddddddddddddddd02');
});
