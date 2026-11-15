import type { Metric, Report } from '@/lib/types';
import { ConfidenceTag, MetricValue } from './parts';

function ScoreTag({ name, metric, reading, footnote }: { name: string; metric: Metric; reading: string; footnote: string }) {
  const scored = metric.status === 'scored';
  return (
    <div className={`shelf flex flex-col bg-surface p-5 ${scored ? '' : 'no-data'}`}>
      <h3 className="text-[1.05rem] font-semibold md:min-h-[2.6rem]">{name}</h3>
      <div className="mt-4 flex min-h-[5.5rem] items-end">
        <MetricValue metric={metric} size="lg" />
        {scored ? <span className="ui mb-2 ml-2 text-ink-faint">/ 100</span> : null}
      </div>
      <p className="ui mt-3 text-[0.9rem] text-ink-soft">{footnote}</p>
      <div className="mt-4">
        {metric.status === 'scored' ? <ConfidenceTag level={metric.confidence} /> : null}
        <p className="mt-2 text-[0.95rem]">{metric.status === 'scored' ? reading : metric.reason}</p>
        {metric.status === 'scored' ? <p className="ui mt-2 text-[0.85rem] text-ink-faint">{metric.confidenceReason}</p> : null}
      </div>
    </div>
  );
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
          reading={`Named in ${v.appearances} of ${v.counted} counted answers${v.averagePosition !== null ? `, at average position ${v.averagePosition} when recommended` : ''}.`}
        />
        <ScoreTag
          name="Audience perception"
          metric={report.perception.metric}
          footnote="Higher means more positive sentiment in what people say."
          reading={`${p.raw.counted} counted opinions: ${p.raw.positive} positive, ${p.raw.mixed} mixed and ${p.raw.negative} negative.`}
        />
        <ScoreTag
          name="Content gap severity"
          metric={report.contentGap.metric}
          footnote="Higher means a more severe gap. Lower is better."
          reading={`${g.checklist.filter((c) => c.level === 'none').length} of ${g.checklist.length} checklist questions are not addressed on the pages read from ${g.domain ?? 'the site'}.`}
        />
      </div>
      <p className="ui mt-4 text-[0.92rem] text-ink-soft">
        {report.overallConfidence.status === 'stated'
          ? `Overall confidence: ${report.overallConfidence.level}, limited by ${report.overallConfidence.limitedBy}. `
          : `Overall confidence: ${report.overallConfidence.reason} `}
        These are three separate measurements. They are not averaged into one score.
      </p>
    </div>
  );
}
