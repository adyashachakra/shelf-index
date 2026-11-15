import type { Report } from '@/lib/types';
import { EvidenceRefs, Section } from './parts';

export function FixList({ report }: { report: Report }) {
  return (
    <Section
      id="fix-list"
      title="Prioritised fix list"
      intro="Written by an AI model from this audit's findings. A recommendation appears only if it cites evidence that exists in this audit."
    >
      {report.fixes.length === 0 ? (
        <p className="text-ink-soft">{report.fixesNote ?? 'No recommendation could be tied to evidence in this audit.'}</p>
      ) : (
        <ol>
          {report.fixes.map((fix, index) => (
            <li key={fix.action} className="flex gap-5 border-b border-rule py-5">
              <span className="numeral text-4xl" aria-hidden="true">
                {index + 1}
              </span>
              <div className="min-w-0 max-w-3xl">
                <h3 className="text-[1.15rem] font-semibold">{fix.action}</h3>
                {fix.why ? (
                  <p className="mt-2">
                    <span className="font-semibold">Why it matters: </span>
                    {fix.why}
                  </p>
                ) : null}
                {fix.expectedImpact ? (
                  <p className="mt-1">
                    <span className="font-semibold">Expected impact: </span>
                    {fix.expectedImpact}
                  </p>
                ) : null}
                <p className="ui mt-2 text-[0.9rem]">
                  <span className="font-semibold">Priority {fix.priority}</span>
                  <span className="text-ink-soft"> of 5 (1 is first). </span>
                  <span className="font-semibold">Effort: {fix.effort}.</span>
                </p>
                <EvidenceRefs ids={fix.evidenceIds} report={report} label="Supporting evidence" />
              </div>
            </li>
          ))}
        </ol>
      )}
      {report.fixesNote && report.fixes.length > 0 ? <p className="ui mt-4 text-[0.9rem] text-ink-soft">{report.fixesNote}</p> : null}
    </Section>
  );
}
