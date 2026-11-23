# report-format-9.json

A saved format 9 report, used only to test that format 9 reports still open exactly as saved after the move to
format 10 (`tests/legacy-reports.test.ts`) and that they render as before (`tests/ui/smoke.tsx`).

Like the fixtures for formats 2 to 8, it is SYNTHETIC: real output of the audit engine of the release that wrote
format 9 (the evidence-quality code with the company-profile "ID:" fix, commit `8885362`), run over the simulated
services in `tests/helpers/mock-apis.ts` (the invented brand "Glowwell", invented channels, example domains), then
saved unchanged. It is not a real audit of any real brand, and it contains no real people's names, handles,
comments, video titles or URLs.

Produced by running that code's `tests/pipeline.test.ts` with `SI_DUMP_REPORT` set to a file path. The report
object only: no audit status, job state, keys, tokens, environment values or logs. Its `identity.setAside` list is
empty; a format 9 report with `matchedContext` entries is built in the tests from this fixture.
