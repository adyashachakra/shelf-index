import { evidenceClass } from '@/lib/evidence/relevance';
import type { Metric, Report } from '@/lib/types';
import { ConfidenceTag, MetricValue } from './parts';

function ScoreTag({ name, metric, reading, basis, footnote }: { name: string; metric: Metric; reading: string; basis: string; footnote: string }) {
  const scored = metric.status === 'scored';
  return (
    <div className={`shelf flex flex-col bg-surface p-5 ${scored ? '' : 'no-data'}`}>
      <h3 className="text-[1.05rem] font-semibold md:min-h-[2.6rem]">{name}</h3>
      <div className="mt-4 flex min-h-[5.5rem] items-end">
        <MetricValue metric={metric} size="lg" />
        {scored ? <span className="ui mb-2 ml-2 text-ink-faint">/ 100</span> : null}
      </div>
      {scored ? <p className="ui mt-1 text-[0.82rem] font-semibold text-ink-soft">Single-audit estimate</p> : null}
      <p className="ui mt-3 text-[0.9rem] text-ink-soft">{footnote}</p>
      <div className="mt-4">
        {metric.status === 'scored' ? <ConfidenceTag level={metric.confidence} /> : null}
        {metric.status === 'scored' ? <p className="ui mt-2 text-[0.88rem] font-semibold">{basis}</p> : null}
        <p className="mt-2 text-[0.95rem]">{metric.status === 'scored' ? reading : metric.reason}</p>
        {metric.status === 'scored' ? <p className="ui mt-2 text-[0.85rem] text-ink-faint">{metric.confidenceReason}</p> : null}
      </div>
    </div>
  );
}

function assessedItems(checklist: Report['contentGap']['detail']['checklist']): number {
  return checklist.filter((item) => evidenceClass(item) !== 'uncertain').length;
}

function contentGapBasis(checklist: Report['contentGap']['detail']['checklist'], pagesRead: number): string {
  const assessed = assessedItems(checklist);
  const pages = `${pagesRead} page${pagesRead === 1 ? '' : 's'} read`;
  return assessed === checklist.length
    ? `Based on ${checklist.length} checklist item${checklist.length === 1 ? '' : 's'} and ${pages}.`
    : `Based on ${assessed} of ${checklist.length} checklist items (the rest could not be assessed) and ${pages}.`;
}

function contentGapReading(checklist: Report['contentGap']['detail']['checklist'], domain: string | null): string {
  const classes = checklist.map((item) => evidenceClass(item));
  const leftOut = classes.filter((c) => c === 'uncertain').length;
  const assessed = checklist.length - leftOut;
  const notAddressed = classes.filter((c) => c === 'not_addressed').length;
  const where = `on the pages read from ${domain ?? 'the site'}`;
  const base = `${notAddressed} of ${assessed} assessed checklist items are not addressed ${where}`;
  return leftOut > 0 ? `${base}. ${leftOut} more could not be assessed and ${leftOut === 1 ? 'is' : 'are'} left out of the score.` : `${base}.`;
}

export function ScoreCards({ report }: { report: Report }) {
  const v = report.visibility.detail;
  const p = report.perception.detail;
  const g = report.contentGap.detail;
  return (
    <div>
      <div className="grid gap-5 md:grid-cols-3">
        <ScoreTag
          name="Gemini API recommendation visibility"
          metric={report.visibility.metric}
          footnote="Higher means Gemini recommends the brand more often and earlier."
          basis={`Based on ${v.counted} counted question${v.counted === 1 ? '' : 's'}${v.excluded > 0 ? `, ${v.excluded} left out` : ''}${v.failed > 0 ? `, ${v.failed} without an answer` : ''}.`}
          reading={`Named in ${v.appearances} of ${v.counted} counted answers${v.averagePosition !== null ? `, at average position ${v.averagePosition} when recommended` : ''}.`}
        />
        <ScoreTag
          name="Audience perception"
          metric={report.perception.metric}
          footnote="Higher means more positive sentiment in what people say."
          basis={`Based on ${p.raw.counted} counted opinion${p.raw.counted === 1 ? '' : 's'} from ${p.uniqueSources} source${p.uniqueSources === 1 ? '' : 's'} on ${p.uniqueDomains.length} website${p.uniqueDomains.length === 1 ? '' : 's'}.`}
          reading={`${p.raw.counted} counted opinions: ${p.raw.positive} positive, ${p.raw.mixed} mixed and ${p.raw.negative} negative.`}
        />
        <ScoreTag
          name="Content gap severity"
          metric={report.contentGap.metric}
          footnote="Higher means a more severe gap. Lower is better."
          basis={contentGapBasis(g.checklist, g.pagesRead)}
          reading={contentGapReading(g.checklist, g.domain)}
        />
      </div>
      <p className="ui mt-4 text-[0.92rem] text-ink-soft">
        {report.overallConfidence.status === 'stated'
          ? `Overall confidence: ${report.overallConfidence.level}, limited by ${report.overallConfidence.limitedBy}. `
          : `Overall confidence: ${report.overallConfidence.reason} `}
        These are three separate measurements. They are not averaged into one score.
      </p>
      <p className="ui mt-2 max-w-3xl text-[0.92rem] text-ink-soft">
        Each score is an estimate from a single audit. Running the same audit again can give different scores, because the
        sources found and the AI&apos;s reading of them can change. A difference of a few points between two audits
        does not show that the brand has changed.
      </p>
    </div>
  );
}
