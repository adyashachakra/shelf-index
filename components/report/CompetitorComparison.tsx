import type { MetricOrSkipped, Report } from '@/lib/types';
import { CompetitorChart } from './CompetitorChart';
import { Section } from './parts';

function Cell({ metric }: { metric: MetricOrSkipped }) {
  if (metric.status === 'scored') {
    return (
      <>
        <span className="font-semibold tabular-nums">{metric.score}</span>
        <span className="text-ink-soft"> ({metric.confidence} confidence)</span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">{metric.status === 'insufficient' ? 'Insufficient data' : metric.status === 'not_recognised' ? 'Not compared' : 'Not measured'}</span>
      <span className="block text-ink-soft">{metric.reason}</span>
    </>
  );
}

/**
 * When the audited brand was not recognised in its category, the brands Gemini recommended are shown as exactly that:
 * a list with how often each was named. No chart, no sentiment, and no comparison with a brand that has no score.
 */
function RecommendedBrands({ report }: { report: Report }) {
  const others = report.competitors.rows.filter((row) => !row.isAuditedBrand);
  return (
    <Section id="competitors" title="Brands Gemini recommended" intro={report.competitors.note}>
      {others.length === 0 ? (
        <p className="text-ink-soft">Gemini did not name other brands often enough to list them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui w-full min-w-[420px] border-collapse text-left text-[0.93rem]">
            <thead>
              <tr className="border-b-2 border-ink">
                <th className="py-2 pr-4 font-semibold">Brand</th>
                <th className="py-2 font-semibold">How often Gemini named it</th>
              </tr>
            </thead>
            <tbody>
              {others.map((row) => (
                <tr key={row.name} className="border-b border-rule align-top">
                  <td className="py-2.5 pr-4">{row.name}</td>
                  <td className="py-2.5">Named in {row.appearances} counted answers</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function CompetitorComparison({ report }: { report: Report }) {
  if (report.competitors.kind === 'recommended_brands') return <RecommendedBrands report={report} />;
  const rows = report.competitors.rows;
  const chartRows = rows.map((row) => ({
    name: row.name,
    visibility: row.visibility.status === 'scored' ? row.visibility.score : null,
    sentiment: row.sentiment.status === 'scored' ? row.sentiment.score : null,
  }));
  return (
    <Section id="competitors" title="Compared with the brands Gemini recommends most" intro={report.competitors.note}>
      {rows.length <= 1 ? (
        <p className="text-ink-soft">No competitor comparison is available for this audit.</p>
      ) : (
        <>
          <div className="bg-surface p-4 sm:p-6">
            <CompetitorChart rows={chartRows} />
            <p className="ui mt-2 text-[0.88rem] text-ink-soft">
              Both measures run from 0 to 100. A missing bar means that measure was not scored for that brand. It is
              not a zero. The table below gives the same figures.
            </p>
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="ui w-full min-w-[640px] border-collapse text-left text-[0.93rem]">
              <thead>
                <tr className="border-b-2 border-ink">
                  <th className="py-2 pr-4 font-semibold">Brand</th>
                  <th className="py-2 pr-4 font-semibold">Gemini API recommendation visibility</th>
                  <th className="py-2 pr-4 font-semibold">Audience sentiment</th>
                  <th className="py-2 font-semibold">Content coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className="border-b border-rule align-top">
                    <td className="py-2.5 pr-4">
                      <span className={row.isAuditedBrand ? 'font-bold' : ''}>{row.name}</span>
                      {row.isAuditedBrand ? <span className="block text-ink-soft">Audited brand</span> : null}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Cell metric={row.visibility} />
                      <span className="block text-ink-soft">Named in {row.appearances} counted answers</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Cell metric={row.sentiment} />
                      {row.sentiment.status === 'scored' ? (
                        <span className="block text-ink-soft">{row.sentimentSample} counted opinions</span>
                      ) : null}
                    </td>
                    <td className="py-2.5">
                      {row.isAuditedBrand ? (
                        <a href="#content-gaps">See content gap</a>
                      ) : (
                        <Cell metric={row.contentCoverage} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}
