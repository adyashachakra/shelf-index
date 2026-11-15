import type { BetweenLinesCheck, Report } from '@/lib/types';
import { Section, SourceLink } from './parts';

const STATUS_TEXT: Record<BetweenLinesCheck['status'], string> = {
  observed: 'Observed',
  not_observed: 'Checked, not observed',
  cannot_assess: 'Could not be assessed',
};

function Check({ check, report }: { check: BetweenLinesCheck; report: Report }) {
  const observed = check.status === 'observed';
  const tentative = observed && check.strength === 'tentative';
  const statusText = check.statusLabel ?? STATUS_TEXT[check.status];
  return (
    <li className={`border-b border-rule py-5 ${observed ? '' : 'text-ink-soft'}`}>
      <p className="ui text-[0.85rem] font-semibold">
        <span className={observed && !tentative ? 'mark text-ink' : observed ? 'text-ink underline' : ''}>{statusText}</span>
        <span className="font-normal text-ink-faint">
          {' '}
          {check.basis === 'computed' ? 'Decided by calculation' : "An AI model's reading of verified evidence"}
        </span>
      </p>
      <h3 className={`mt-1 text-xl font-semibold ${observed ? 'text-ink' : ''}`}>{check.title}</h3>
      {check.observed ? <p className="mt-2 max-w-3xl">{check.observed}</p> : null}
      {check.reason ? <p className="mt-2 max-w-3xl">{check.reason}</p> : null}

      {check.evidence.length > 0 ? (
        <div className="mt-3 max-w-3xl">
          <p className="ui text-[0.9rem] font-semibold text-ink">{check.status === 'cannot_assess' ? 'What was measured' : 'Verified evidence'}</p>
          <ul className="ui mt-1 list-disc space-y-1 pl-5 text-[0.92rem]">
            {check.evidence.map((entry, index) => (
              <li key={`${entry.id}-${index}`}>
                {entry.url ? (
                  <SourceLink url={entry.url} illustrative={report.illustrative}>
                    {entry.label}
                  </SourceLink>
                ) : (
                  entry.label
                )}
                {entry.quote ? <span className="block italic">&ldquo;{entry.quote}&rdquo;</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {observed && (check.whyItMatters || check.implication) ? (
        <div className="mt-3 max-w-3xl text-ink">
          <p className="ui text-[0.9rem] font-semibold">{check.basis === 'computed' ? 'Interpretation' : 'AI-generated interpretation'}</p>
          {check.whyItMatters ? (
            <p className="mt-1">
              <span className="font-semibold">Why it matters: </span>
              {check.whyItMatters}
            </p>
          ) : null}
          {check.implication ? (
            <p className="mt-1">
              <span className="font-semibold">Possible implication, not tested: </span>
              {check.implication}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function BetweenTheLines({ report }: { report: Report }) {
  const established = report.betweenTheLines.filter((c) => c.status === 'observed' && c.strength !== 'tentative').length;
  const tentative = report.betweenTheLines.filter((c) => c.status === 'observed' && c.strength === 'tentative').length;
  const notObserved = report.betweenTheLines.filter((c) => c.status === 'not_observed').length;
  const unassessed = report.betweenTheLines.filter((c) => c.status === 'cannot_assess').length;
  const summary = `${established} ${established === 1 ? 'was' : 'were'} observed, ${tentative} ${tentative === 1 ? 'is' : 'are'} possible on limited evidence, ${notObserved} ${notObserved === 1 ? 'was' : 'were'} checked and not observed, and ${unassessed} could not be assessed.`;
  return (
    <Section
      id="between-the-lines"
      title="Between the lines"
      intro={`Seven patterns are checked in every audit. Here ${summary} A pattern is reported as observed only when this audit holds the evidence to establish it. Where it does not, the report says so and offers no explanation.`}
    >
      <ul>
        {report.betweenTheLines.map((check) => (
          <Check key={check.id} check={check} report={report} />
        ))}
      </ul>
    </Section>
  );
}
