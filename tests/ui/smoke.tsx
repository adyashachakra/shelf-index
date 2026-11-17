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
  for (const version of [2, 3, 4, 5, 6]) {
    const report = JSON.parse(readFileSync(new URL(`../fixtures/report-format-${version}.json`, import.meta.url), 'utf8')) as Report;
    const html = page(`format${version}`, <ReportView report={report} />);
    // Formats 2 to 5 carry both earlier-version notices; format 6 only the one about brand identity checks.
    const needles = ['saved before audits checked whether the brand is recognised', 'Single-audit estimate', report.brand];
    if (version < 6) needles.push('saved before the latest changes', 'nothing missing from it has been filled in');
    if (version >= 4) needles.push('Products identified in the pages read');
    if (version < 4) needles.push("Product lines found on the brand");
    out.push([`format${version}`, html, needles]);
    if (version === 6 && (html.includes('saved before the latest changes') || html.includes('Found but not counted') && html.includes('Who the brand was established to be'))) {
      console.error('FABRICATED in format6: an old notice or an identity section it never had');
      process.exitCode = 1;
    }
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

// The three new rules as a reader sees them: each note must be displayed next to its item.
const withNewRules: Report = {
  ...EXAMPLE_REPORT,
  illustrative: false,
  contentGap: {
    ...EXAMPLE_REPORT.contentGap,
    detail: {
      ...EXAMPLE_REPORT.contentGap.detail,
      checklist: [
        ...EXAMPLE_REPORT.contentGap.detail.checklist,
        { id: 'c8', source: 'customer_concern', text: 'Which cleanser is best for combination or oily skin types?', level: 'partial', url: 'https://brand.example/faq', quote: 'suitable for a wide range of skin types', relevance: 'indirect', relevanceNote: 'The words quoted say the product suits a range of types. They do not say it is the best choice for the need asked about, so this counts as touched on, not as a clear answer.' },
        { id: 'c9', source: 'customer_concern', text: 'Are certain products available outside the United States or in Europe?', level: 'none', url: 'https://brand.example/new', quote: 'we have detected that you are shopping from a different location', relevance: 'indirect', relevanceNote: "The words quoted do not say where products are available. A notice about the visitor's location is not availability information. It counts as not addressed unless a page states actual regional availability." },
        { id: 'q9', source: 'category_question', text: 'Which skincare brands do dermatologists recommend most?', level: 'partial', url: 'https://brand.example/about', quote: 'The #1 dermatologist-recommended brand', relevance: 'indirect', expertEvidence: 'brand_claim', relevanceNote: "The brand's own page says experts recommend or endorse it, but the words quoted name no expert or organisation, and this audit did not verify the claim. It is shown as the brand's claim and counts as touched on, not as a clear answer.", geminiNamedBrand: false },
        { id: 'q10', source: 'category_question', text: 'Which skincare brands do dermatologists recommend most?', level: 'partial', url: 'https://brand.example/about2', quote: 'Recommended by Dr. Jane Smith, dermatologist', relevance: 'brand_wide', expertEvidence: 'recommendation', brandClaim: true, relevanceNote: "A named expert or organisation is quoted, on the brand's own page. This is the brand's own statement on its website. It shows what the brand claims; it does not independently establish that experts recommend it. It counts as touched on, not as a clear answer." },
        { id: 'q11', source: 'category_question', text: 'What skincare brands are best for sensitive skin?', level: 'partial', url: 'https://brand.example/sensitive', quote: 'Our brand is a dermatologist recommended sensitive skincare brand.', relevance: 'brand_wide', brandClaim: true, relevanceNote: "This is the brand's own statement on its website. It shows what the brand claims; it does not independently establish that it is the best or a suitable choice. It counts as touched on, not as a clear answer." },
      ],
    },
  },
  fixes: [{ ...EXAMPLE_REPORT.fixes[0], evidenceBase: '1 customer or reviewer source (2 excerpts in total)' }],
};

const checks: [string, string, string[]][] = [
  ['home', page('home', <HomePage />), ['Review audit', 'Brand name', 'Choose a category', 'Example report', 'Built by Adyasha Chakra']],
  ['privacy', page('privacy', <PrivacyPage />), ['human reviewers', 'Hobby plan', 'YouTube Terms of Service', 'Google Privacy Policy']],
  ['example', page('example', <ReportView report={EXAMPLE_REPORT} />), ['Illustrative example', 'Gemini API recommendation visibility', 'Between the lines', 'Prioritised fix list', 'Sources and methodology', 'Insufficient data', 'Single-audit estimate', 'Based on', 'Products identified in the pages read', 'not a verified inventory', 'about the mineral sunscreen', 'does not show that the brand has changed']],
  ['legacy', page('legacy', <ReportView report={legacy} />), ['Product lines found on the brand', 'Single-audit estimate', 'Touched on', 'Not addressed', 'saved before the latest changes', 'saved before audits checked whether the brand is recognised']],
  ...fixtureChecks(),
  ['newrules', page('newrules', <ReportView report={withNewRules} />), ['suits a range of types', 'is not availability information', 'counts as touched on, not as a clear answer', 'It is shown as the brand', 'A named expert or organisation is quoted', 'Touched on \u2014 brand claim', 'does not independently establish that it is the best or a suitable choice', 'The pages read here are the brand', '1 customer or reviewer source (2 excerpts in total)']],
  ['setaside', page('setaside', <ReportView report={withSetAside} />), ['Price position: not established.', 'Found but not counted as independent evidence', 'a press release or company announcement', 'galderma.com']],
  ['empty', page('empty', <ReportView report={empty} />), ['Insufficient data', 'Could not be assessed', 'Overall confidence: Not stated']],
  ['notfound', page('notfound', <NotFound />), ['not found']],
];

// Optional: a report produced by the engine in tests/pipeline.test.ts (run with SI_DUMP_REPORT set),
// so the pages are also rendered from real engine output and not only from the hand-written example.
const dumpPath = process.env.SI_PIPELINE_REPORT;
const identityDump = process.env.SI_IDENTITY_REPORT;
if (identityDump && existsSync(identityDump)) {
  // A report from the engine for a brand Gemini did not recognise (tests/identity.test.ts, SI_DUMP_IDENTITY_REPORT).
  const notRecognised = JSON.parse(readFileSync(identityDump, 'utf8')) as Report;
  const html = page('not-recognised', <ReportView report={notRecognised} />);
  checks.push(['not-recognised', html, ['Brand not recognised in this category.', 'Brands Gemini recommended', 'Not compared', 'Who the brand was established to be', 'Found but not counted']]);
  if (html.includes('saved before audits checked')) {
    console.error('A current report must not carry the earlier-version notice');
    process.exitCode = 1;
  }
}
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
  // The builder credit is in the root layout, so it must be on every page, spelled correctly.
  if (!html.includes('Built by Adyasha Chakra')) {
    failed = true;
    console.error(`MISSING in ${name}: Built by Adyasha Chakra`);
  }
  if (/Adya\s+Chakra/.test(html)) {
    failed = true;
    console.error(`OLD SPELLING in ${name}`);
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
