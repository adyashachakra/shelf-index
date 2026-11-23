# report-format-8.json

A saved format 8 report, used only to test that format 8 reports still open exactly as saved
(`tests/legacy-reports.test.ts`) and that the set-aside rendering of a report without the later `matchedContext`
field is unchanged (`tests/evidence-quality-ui.test.ts`).

Like the fixtures for formats 2 to 7, it is SYNTHETIC: real output of the audit engine of the release that wrote
format 8 (the Stage 2 code, before format 9), run over the simulated services in `tests/helpers/mock-apis.ts`
(the invented brand "Glowwell", invented channels, example domains), then saved unchanged. It is not a real audit
of any real brand, and it contains no real people's names, handles, comments, video titles or URLs.

Produced by running the baseline code's `tests/pipeline.test.ts` with `SI_DUMP_REPORT` set to a file path (the
test writes the report it built to that path). The report object only: no audit status, job state, keys, tokens,
environment values or logs. Its `identity.setAside` list is empty, as in the format 7 fixture.
