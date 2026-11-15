import type { BetweenLinesCheck, Report } from '@/lib/types';
import { Section, SourceLink } from './parts';

const STATUS_TEXT: Record<BetweenLinesCheck['status'], string> = {
  observed: 'Observed',
  not_observed: 'Checked, not observed',
  cannot_assess: 'Could not be assessed',
};

function Check({ check, report }: { check: BetweenLinesCheck; report: Report }) {
  const observed = check.status === 'observed';
  return (
    <li className={`border-b border-rule py-5 ${observed ? '' : 'text-ink-soft'}`}>
      <p className="ui text-[0.85rem] font-semibold">
        <span className={observed ? 'mark text-ink' : ''}>{STATUS_TEXT[check.status]}</span>
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
          <p className="ui text-[0.9rem] font-semibold text-ink">Verified evidence</p>
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
              <span className="font-semibold">Strategic implication: </span>
              {check.implication}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function BetweenTheLines({ report }: { report: Report }) {
  const observed = report.betweenTheLines.filter((c) => c.status === 'observed').length;
  return (
    <Section
      id="between-the-lines"
      title="Between the lines"
      intro={`Seven patterns are checked in every audit. ${observed} ${observed === 1 ? 'was' : 'were'} observed here. A pattern is reported only when it can be tied to evidence from this audit. Where the connection could not be made, the report says so and does not offer an explanation.`}
    >
      <ul>
        {report.betweenTheLines.map((check) => (
          <Check key={check.id} check={check} report={report} />
        ))}
      </ul>
    </Section>
  );
}
