import type { Report } from '@/lib/types';
import { AiVisibility } from './AiVisibility';
import { AudiencePerception } from './AudiencePerception';
import { BetweenTheLines } from './BetweenTheLines';
import { CompetitorComparison } from './CompetitorComparison';
import { ContentGaps } from './ContentGaps';
import { Disconnect } from './Disconnect';
import { FixList } from './FixList';
import { formatDateTime } from './parts';
import { ScoreCards } from './ScoreCards';
import { SourcesAndMethod } from './SourcesAndMethod';

const CONTENTS = [
  { href: '#disconnect', label: 'The disconnect' },
  { href: '#competitors', label: 'Competitors' },
  { href: '#ai-recommendations', label: 'What Gemini says' },
  { href: '#audience-perception', label: 'What people say' },
  { href: '#content-gaps', label: 'Content gaps' },
  { href: '#between-the-lines', label: 'Between the lines' },
  { href: '#fix-list', label: 'Fix list' },
  { href: '#method', label: 'Sources and methodology' },
];

export function ReportView({ report }: { report: Report }) {
  return (
    <article className="mx-auto max-w-5xl px-5 pb-10 pt-10 sm:px-8">
      {report.illustrative ? (
        <p className="ui mb-8 border-2 border-ink bg-mark px-4 py-3 text-[0.98rem] font-semibold">
          Illustrative example. {report.brand} and every competitor, quote and number on this page are invented to show
          what a report looks like. This is not a real audit.
        </p>
      ) : null}

      {!report.illustrative && report.version < 6 ? (
        <p className="ui mb-8 border-2 border-ink px-4 py-3 text-[0.95rem]">
          This report was saved before the latest changes to the audit rules. It is shown as it was produced, and nothing
          missing from it has been filled in. Later versions require an independent source for a price tier, check that
          evidence is about the product or question asked, treat experts who only helped make or test a product as
          different from experts who recommend it, show the product-range status, and treat a brand&apos;s own claims about
          effectiveness, suitability or expert recommendation as claims, never as a clear answer. An older report may lack
          some of these checks, and its content gap score may count items with no usable answer as not addressed. Run a new audit
          to see them.
        </p>
      ) : null}

      {!report.illustrative && report.version < 7 ? (
        <p className="ui mb-8 border-2 border-ink px-4 py-3 text-[0.95rem]">
          This report was saved before audits checked whether the brand is recognised in the category chosen. If the
          brand and category do not match, parts of it may describe other businesses with a similar name. It is shown
          as it was produced. Run a new audit to have the check applied.
        </p>
      ) : null}

      {report.identity && report.identity.status !== 'recognised' ? (
        <div className="ui mb-8 border-2 border-ink bg-mark px-4 py-3 text-[0.98rem]">
          <p className="font-semibold">
            {report.identity.status === 'domain_verified' ? 'Brand not recognised in this category.' : 'Brand identity was not checked.'}
          </p>
          <p className="mt-1">{report.identity.summary}</p>
        </div>
      ) : null}

      <header>
        <p className="ui text-[0.95rem] text-ink-soft">
          Brand audit, {report.category.label}. {formatDateTime(report.createdAt)}
        </p>
        <h1 className="mt-2 text-5xl font-bold sm:text-6xl">{report.brand}</h1>
        <p className="mt-4 max-w-3xl text-[1.2rem] leading-snug">
          What people say about {report.brand}, what Gemini says about it, and where the two part ways.
        </p>
      </header>

      <div className="mt-10">
        <ScoreCards report={report} />
      </div>

      <nav aria-label="Report sections" className="ui no-print mt-8 flex flex-wrap gap-x-5 gap-y-1 text-[0.92rem]">
        {CONTENTS.map((entry) => (
          <a key={entry.href} href={entry.href}>
            {entry.label}
          </a>
        ))}
      </nav>

      <Disconnect report={report} />
      <CompetitorComparison report={report} />
      <AiVisibility report={report} />
      <AudiencePerception report={report} />
      <ContentGaps report={report} />
      <BetweenTheLines report={report} />
      <FixList report={report} />
      <SourcesAndMethod report={report} />
    </article>
  );
}
