# report-format-7.json

A saved format 7 report, used only to test that format 7 reports still open exactly as saved
(`tests/legacy-reports.test.ts`).

Like the fixtures for formats 2 to 6, it is SYNTHETIC: real output of the audit engine of the release that
wrote format 7 (commit `6e66a65`, before format 8), run over the simulated services in
`tests/helpers/mock-apis.ts` (the invented brand "Glowwell", invented channels "Creator One" and
"Creator Two", example domains), then saved unchanged. It is not a real audit of any real brand, and it
contains no real people's names, handles, comments, video titles or URLs.

Produced by running the baseline code's `tests/pipeline.test.ts` with `SI_DUMP_REPORT` set to a file path
(the test writes the report it built to that path). The report object only: no audit status, job state,
keys, tokens, environment values or logs.
