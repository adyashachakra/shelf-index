// Saved reports across a format change: older reports stay readable, and an older cached
// report is never handed to a new audit. Redis is real (local); nothing else is involved.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { findCachedReportId, loadReport, saveReport } from '../lib/cache/reports';
import { cmd } from '../lib/clients/redis';
import { READABLE_REPORT_VERSIONS, REPORT_FORMAT_VERSION } from '../lib/config';
import type { Report } from '../lib/types';
import { startShim, type Shim } from './helpers/upstash-shim';

let shim: Shim;

before(async () => {
  shim = await startShim(6399, 4);
  await shim.flush();
  process.env.UPSTASH_REDIS_REST_URL = shim.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = shim.token;
});
after(async () => {
  await shim.close();
});

const fake = (id: string, version: number) => JSON.stringify({ id, version, brand: 'Cetaphil' });

test('the report format is 4, and version 3 reports can still be read', () => {
  assert.equal(REPORT_FORMAT_VERSION, 4);
  assert.deepEqual([...READABLE_REPORT_VERSIONS], [4, 3]);
});

test('a report saved in format 3 still opens; formats 2 (first V1.1 preview) and 1 (V1.0) are not read', async () => {
  await cmd('SET', 'si:report:v3:aaaaaaaaaaaaaaaaaaaaaaaa', fake('aaaaaaaaaaaaaaaaaaaaaaaa', 3));
  await cmd('SET', 'si:report:v2:bbbbbbbbbbbbbbbbbbbbbbbb', fake('bbbbbbbbbbbbbbbbbbbbbbbb', 2));
  await cmd('SET', 'si:report:v1:ffffffffffffffffffffffff', fake('ffffffffffffffffffffffff', 1));
  const old = await loadReport('aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(old?.id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(await loadReport('bbbbbbbbbbbbbbbbbbbbbbbb'), null);
  assert.equal(await loadReport('ffffffffffffffffffffffff'), null);
  assert.equal(await loadReport('cccccccccccccccccccccccc'), null);
});

test('a new report is stored under format 4 and found first; an old cached report is not offered for a new audit', async () => {
  await cmd('SET', 'si:report:v3:dddddddddddddddddddddddd', fake('dddddddddddddddddddddddd', 3));
  await cmd('SET', 'si:cache:v3:skincare:cetaphil', 'dddddddddddddddddddddddd');
  assert.equal(await findCachedReportId('skincare:cetaphil'), null, 'a repeat audit must run again under the new rules');

  await saveReport({ id: 'eeeeeeeeeeeeeeeeeeeeeeee', version: 4 } as unknown as Report, 'skincare:cetaphil');
  assert.equal(await cmd('EXISTS', 'si:report:v4:eeeeeeeeeeeeeeeeeeeeeeee'), 1);
  assert.equal(await findCachedReportId('skincare:cetaphil'), 'eeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal((await loadReport('eeeeeeeeeeeeeeeeeeeeeeee'))?.id, 'eeeeeeeeeeeeeeeeeeeeeeee');
});
