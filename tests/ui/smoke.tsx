// UI smoke test: render every page to HTML on the server side with stand-ins for Next.js and
// Recharts. This catches runtime errors in the components. It is NOT a real Next.js build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '@/app/page';
import PrivacyPage from '@/app/privacy/page';
import NotFound from '@/app/not-found';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ReportView } from '@/components/report/ReportView';
import { EXAMPLE_REPORT } from '@/lib/report/example-report';
import type { Report } from '@/lib/types';

const out = process.argv[2] ?? '/tmp/si-ui';
mkdirSync(out, { recursive: true });

function page(name: string, body: ReactElement): string {
  const html = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="app.css" />
        {/* In the real site next/font sets these variables. Here the fonts fall back to system ones. */}
        <style>{':root{--font-archivo:"Archivo";--font-source-serif:"Source Serif 4"}'}</style>
      </head>
      <body className="min-h-screen antialiased">
        <SiteHeader />
        <main>{body}</main>
        <SiteFooter />
      </body>
    </html>,
  );
  writeFileSync(`${out}/${name}.html`, `<!DOCTYPE html>${html}`);
  return html;
}

// A report where nothing could be assessed: every "insufficient data" branch must render.
const empty: Report = {
  ...EXAMPLE_REPORT,
  illustrative: false,
  overallConfidence: { status: 'not_stated', reason: 'Not stated, because audience perception and content gap severity could not be assessed in this audit.' },
  visibility: { metric: { status: 'insufficient', reason: 'Only 3 of 8 questions could be counted.' }, detail: { ...EXAMPLE_REPORT.visibility.detail, counted: 3 } },
  brandProfile: null,
  signatureAnswer: null,
  perception: { ...EXAMPLE_REPORT.perception, metric: { status: 'insufficient', reason: 'No independent discussions were found.' }, praise: [], complaints: [], advocacy: [], concerns: [], creatorVsCustomer: '', detail: { ...EXAMPLE_REPORT.perception.detail, sponsoredItems: [] } },
  contentGap: { metric: { status: 'insufficient', reason: "The brand's official website could not be identified with confidence." }, detail: { ...EXAMPLE_REPORT.contentGap.detail, domain: null, checklist: [], excluded: [], productLines: [], positioning: [], signatureClaim: null } },
  claims: [],
  competitors: { rows: [EXAMPLE_REPORT.competitors.rows[0]], note: 'Gemini did not recommend other brands often enough to name competitors.' },
  disconnect: { status: 'cannot_assess', reason: 'The two scores cannot be compared.', disagreements: [] },
  betweenTheLines: EXAMPLE_REPORT.betweenTheLines.map((c) => ({ id: c.id, title: c.title, status: 'cannot_assess' as const, basis: c.basis, evidence: [], reason: 'Not enough evidence in this audit.' })),
  fixes: [],
  fixesNote: 'Recommendations could not be generated for this audit.',
  evidence: [],
  warnings: ['YouTube was not available.'],
  methodology: { ...EXAMPLE_REPORT.methodology, unavailable: ['YouTube was not available.'], searches: [] },
};

const checks: [string, string, string[]][] = [
  ['home', page('home', <HomePage />), ['Run audit', 'Brand name', 'Example report', 'Built by Adya Chakra']],
  ['privacy', page('privacy', <PrivacyPage />), ['human reviewers', 'Hobby plan', 'YouTube Terms of Service', 'Google Privacy Policy']],
  ['example', page('example', <ReportView report={EXAMPLE_REPORT} />), ['Illustrative example', 'Gemini API recommendation visibility', 'Between the lines', 'Prioritised fix list', 'Sources and methodology', 'Insufficient data']],
  ['empty', page('empty', <ReportView report={empty} />), ['Insufficient data', 'Could not be assessed', 'Overall confidence: Not stated']],
  ['notfound', page('notfound', <NotFound />), ['not found']],
];

// Optional: a report produced by the engine in tests/pipeline.test.ts (run with SI_DUMP_REPORT set),
// so the pages are also rendered from real engine output and not only from the hand-written example.
const dumpPath = process.env.SI_PIPELINE_REPORT;
if (dumpPath && existsSync(dumpPath)) {
  const fromEngine = JSON.parse(readFileSync(dumpPath, 'utf8')) as Report;
  checks.push(['pipeline', page('pipeline', <ReportView report={fromEngine} />), ['Could not be assessed', 'Hypothesis to test, not a measured result', 'How the sample breaks down', 'Why this model']]);
}

let failed = false;
for (const [name, html, needles] of checks) {
  for (const needle of needles) {
    if (!html.includes(needle)) {
      failed = true;
      console.error(`MISSING in ${name}: ${needle}`);
    }
  }
  console.log(`${name}: ${html.length} chars`);
}
if (EXAMPLE_REPORT.illustrative && /href="https:\/\/[a-z.-]*example/.test(checks[2][1])) {
  failed = true;
  console.error('The illustrative example must not contain outbound source links');
}
process.exit(failed ? 1 : 0);
