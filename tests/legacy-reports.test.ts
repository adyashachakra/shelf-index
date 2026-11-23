// Saved reports across format changes: older reports stay readable exactly as they were saved, and an
// older cached report is never handed to a new audit. Redis is real (local); nothing else is involved.
//
// The fixtures in tests/fixtures are REAL engine output: each was produced by running the audit engine
// of the release that wrote that format (format 2: the first V1.1 preview; format 3: patch 2; format 4:
// patch 3; format 5: patches 4 and 5; format 6: patch 6b) over the simulated services, then saved unchanged. They are not hand-written.
// Format 7 (the identity release, commit 6e66a65) was produced the same way; see tests/fixtures/report-format-7.README.md.
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

test('J1: the report format is 10; formats 10, 9, 8, 7, 6, 5, 4, 3 and 2 can be opened', () => {
  assert.equal(REPORT_FORMAT_VERSION, 10);
  assert.deepEqual([...READABLE_REPORT_VERSIONS], [10, 9, 8, 7, 6, 5, 4, 3, 2]);
});

test('the fixtures are what they claim to be: saved reports of formats 2, 3, 4, 5, 6, 7, 8 and 9', () => {
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const report = fixture(version);
    assert.equal(report.version, version);
    assert.match(report.id, /^[0-9a-f]{24}$/);
    assert.ok(report.contentGap.detail.checklist.length > 0 && report.evidence.length > 0, 'a whole report, not a stub');
  }
});

for (const version of [2, 3, 4, 5, 6, 7, 8, 9]) {
  test(`a saved format ${version} report opens, and what the API returns is exactly what was saved`, async () => {
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

test('the format 7 fixture is a synthetic format 7 report with its identity section, and uses only the invented or generic web addresses of the other fixtures', () => {
  const text = fixtureText(7);
  const report = fixture(7);
  assert.equal(report.version, 7);
  assert.equal(report.brand, 'Glowwell');
  assert.equal('identity' in report, true, 'a format 7 report has its identity section');
  assert.deepEqual(
    report.evidence.flatMap((item) => (item.channel ? [item.channel] : [])),
    ['Creator One', 'Creator Two'],
  );
  // Every web address is on an invented or generic domain, as in the other fixtures.
  const hosts = new Set([...text.matchAll(/https?:\/\/([^/\s"\\]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts].sort(), ['beautydesk.example.com', 'forum.example.org', 'shop.example.net', 'skinjournal.example.net', 'www.glowwell.com', 'www.reddit.com', 'www.youtube.com']);
});

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

test('a format 6 report is not given an identity section it never had', async () => {
  // Format 6 was saved before audits checked who the brand was. It must open exactly as saved: no identity
  // verdict, no set-aside list, and no competitor labelling invented for it.
  const saved = fixture(6);
  await cmd('SET', `si:report:v6:${saved.id}`, fixtureText(6));
  const loaded = (await loadReport(saved.id)) as Report;
  assert.equal(loaded.version, 6);
  assert.equal('identity' in loaded, false, 'no identity section invented');
  assert.equal('kind' in loaded.competitors, false, 'competitors are not relabelled');
  assert.ok(loaded.visibility.metric.status !== 'not_recognised');
  assert.equal(JSON.stringify(loaded), JSON.stringify(saved));
});

test('J2: a new report is stored under format 10 and found first; older cached reports (including 9) are not offered for a new audit, and are not touched', async () => {
  for (const version of [9, 8, 7, 6, 5, 4, 3, 2]) {
    await cmd('SET', `si:report:v${version}:dddddddddddddddddddddd0${version}`, fake(`dddddddddddddddddddddd0${version}`, version));
    await cmd('SET', `si:cache:v${version}:skincare:cetaphil`, `dddddddddddddddddddddd0${version}`);
  }
  assert.equal(await findCachedReportId('skincare:cetaphil'), null, 'a repeat audit must run again under the new rules, not reuse the format 9 report');

  await saveReport({ id: 'eeeeeeeeeeeeeeeeeeeeeeee', version: 10 } as unknown as Report, 'skincare:cetaphil');
  assert.equal(await cmd('EXISTS', 'si:report:v10:eeeeeeeeeeeeeeeeeeeeeeee'), 1);
  assert.equal(await cmd('EXISTS', 'si:cache:v10:skincare:cetaphil'), 1, 'the pointer is in its own format 10 namespace');
  assert.equal(await cmd('EXISTS', 'si:report:v9:eeeeeeeeeeeeeeeeeeeeeeee'), 0, 'nothing new is written under format 9');
  assert.equal(await findCachedReportId('skincare:cetaphil'), 'eeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal((await loadReport('eeeeeeeeeeeeeeeeeeeeeeee'))?.id, 'eeeeeeeeeeeeeeeeeeeeeeee');
  // The older reports and their pointers are still there, unchanged, and still readable alongside it.
  for (const version of [9, 8, 7, 6, 5, 4, 3, 2]) {
    assert.equal((await loadReport(`dddddddddddddddddddddd0${version}`))?.id, `dddddddddddddddddddddd0${version}`);
    assert.equal(await cmd('GET', `si:cache:v${version}:skincare:cetaphil`), `dddddddddddddddddddddd0${version}`, `the format ${version} pointer was not deleted or rewritten`);
    assert.equal(await cmd('GET', `si:report:v${version}:dddddddddddddddddddddd0${version}`), fake(`dddddddddddddddddddddd0${version}`, version), `the format ${version} report was not rewritten`);
  }
});

test('J3: a pointer in the format 10 namespace that leads to a report saved only under format 9 is not offered', async () => {
  await cmd('SET', 'si:report:v9:ffffffffffffffffffffffff', fake('ffffffffffffffffffffffff', 9));
  await cmd('SET', 'si:cache:v10:fashion:cos', 'ffffffffffffffffffffffff');
  assert.equal(await findCachedReportId('fashion:cos'), null);
  assert.equal((await loadReport('ffffffffffffffffffffffff'))?.version, 9, 'the format 9 report itself still opens by its id');
});

test('J4: a saved format 9 report with matchedContext entries is returned exactly as saved, field intact', async () => {
  const saved: Report = {
    ...fixture(9),
    id: 'abababababababababababab',
    identity: {
      ...(fixture(9).identity as NonNullable<Report['identity']>),
      setAside: [
        {
          title: 'COS',
          url: 'https://profiles.example.org/company/cos',
          domain: 'profiles.example.org',
          reason: 'Names both "COS" and "COS ID" (a different name), so what it says cannot be attributed to COS.',
          matchedContext: { text: '# COS ID: Ab12Cd34 Website: www.cos.example', markFrom: 2, markTo: 8, field: 'snippet', rule: 'follower' },
        },
      ],
      setAsideCount: 1,
    },
  };
  const text = JSON.stringify(saved);
  await cmd('SET', `si:report:v9:${saved.id}`, text);
  const loaded = (await loadReport(saved.id)) as Report;
  assert.equal(loaded.version, 9);
  assert.equal(JSON.stringify(loaded), text, 'not re-classified or rewritten under the new matcher');
  assert.deepEqual(loaded.identity?.setAside[0].matchedContext, saved.identity?.setAside[0].matchedContext);
});

test('H15: a saved format 8 report has no matchedContext on any set-aside entry and is returned exactly as saved', async () => {
  const saved = fixture(8);
  await cmd('SET', `si:report:v8:${saved.id}`, fixtureText(8));
  const loaded = (await loadReport(saved.id)) as Report;
  assert.equal(loaded.version, 8);
  for (const entry of loaded.identity?.setAside ?? []) assert.equal('matchedContext' in entry, false);
  assert.equal(JSON.stringify(loaded), JSON.stringify(saved));
});
