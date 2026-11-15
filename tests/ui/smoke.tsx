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

// A report saved before version 4 (format 3): none of the fields added in 4. It must still open.
const { priceSupport: _priceSupport, productRange: _productRange, ...legacyDetail } = EXAMPLE_REPORT.contentGap.detail;
const legacy: Report = {
  ...EXAMPLE_REPORT,
  version: 3,
  illustrative: false,
  contentGap: {
    ...EXAMPLE_REPORT.contentGap,
    detail: { ...legacyDetail, checklist: EXAMPLE_REPORT.contentGap.detail.checklist.map(({ relevance: _r, evidenceAbout: _e, relevanceNote: _n, ...item }) => item) },
  },
};

// REAL saved reports of the earlier formats (see tests/legacy-reports.test.ts): each must render, with the
// earlier-version notice, and without anything the old report never held.
function fixtureChecks(): [string, string, string[]][] {
  const out: [string, string, string[]][] = [];
  for (const version of [2, 3, 4]) {
    const report = JSON.parse(readFileSync(new URL(`../fixtures/report-format-${version}.json`, import.meta.url), 'utf8')) as Report;
    const html = page(`format${version}`, <ReportView report={report} />);
    const needles = ['saved before the latest changes', 'nothing missing from it has been filled in', 'Single-audit estimate', report.brand];
    if (version === 4) needles.push('Products identified in the pages read');
    if (version < 4) needles.push("Product lines found on the brand");
    out.push([`format${version}`, html, needles]);
    for (const absent of version < 4 ? ['Price position, supported by', 'Products identified in the pages read', 'Product range: partially assessed'] : []) {
      if (html.includes(absent)) {
        console.error(`FABRICATED in format${version}: ${absent}`);
        process.exitCode = 1;
      }
    }
  }
  return out;
}

const withSetAside: Report = {
  ...EXAMPLE_REPORT,
  illustrative: false,
  contentGap: {
    ...EXAMPLE_REPORT.contentGap,
    detail: {
      ...EXAMPLE_REPORT.contentGap.detail,
      priceSupport: {
        status: 'not_independent',
        tier: 'premium',
        sources: [],
        setAside: [{ domain: 'galderma.com', url: 'https://www.galderma.com/news/x', quote: 'Cetaphil Unveils Premium Product Line', tier: 'premium', reason: 'a press release or company announcement' }],
      },
    },
  },
};

const checks: [string, string, string[]][] = [
  ['home', page('home', <HomePage />), ['Run audit', 'Brand name', 'Example report', 'Built by Adya Chakra']],
  ['privacy', page('privacy', <PrivacyPage />), ['human reviewers', 'Hobby plan', 'YouTube Terms of Service', 'Google Privacy Policy']],
  ['example', page('example', <ReportView report={EXAMPLE_REPORT} />), ['Illustrative example', 'Gemini API recommendation visibility', 'Between the lines', 'Prioritised fix list', 'Sources and methodology', 'Insufficient data', 'Single-audit estimate', 'Based on', 'Products identified in the pages read', 'not a verified inventory', 'about the mineral sunscreen', 'does not show that the brand has changed']],
  ['legacy', page('legacy', <ReportView report={legacy} />), ['Product lines found on the brand', 'Single-audit estimate', 'Touched on', 'Not addressed', 'saved before the latest changes']],
  ...fixtureChecks(),
  ['setaside', page('setaside', <ReportView report={withSetAside} />), ['Price position: not established.', 'Found but not counted as independent evidence', 'a press release or company announcement', 'galderma.com']],
  ['empty', page('empty', <ReportView report={empty} />), ['Insufficient data', 'Could not be assessed', 'Overall confidence: Not stated']],
  ['notfound', page('notfound', <NotFound />), ['not found']],
];

// Optional: a report produced by the engine in tests/pipeline.test.ts (run with SI_DUMP_REPORT set),
// so the pages are also rendered from real engine output and not only from the hand-written example.
const dumpPath = process.env.SI_PIPELINE_REPORT;
if (dumpPath && existsSync(dumpPath)) {
  const fromEngine = JSON.parse(readFileSync(dumpPath, 'utf8')) as Report;
  checks.push(['pipeline', page('pipeline', <ReportView report={fromEngine} />), ['Could not be assessed', 'Hypothesis to test, not a measured result', 'How the sample breaks down', 'Why this model', 'Uncertain', 'about sunscreen', 'Products identified in the pages read', 'supported by independent sources']]);
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
if (checks[2][1].includes('saved before the latest changes')) {
  failed = true;
  console.error('A current report must not carry the earlier-version notice');
}
if (EXAMPLE_REPORT.illustrative && /href="https:\/\/[a-z.-]*example/.test(checks[2][1])) {
  failed = true;
  console.error('The illustrative example must not contain outbound source links');
}
process.exit(failed ? 1 : 0);
