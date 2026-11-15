import type { Disagreement, Report } from '@/lib/types';
import { EvidenceRefs, Section } from './parts';

const KIND_TEXT: Record<Disagreement['kind'], string> = {
  disagreement: 'Disagreement',
  opportunity: 'Opportunity',
  risk: 'Risk',
};

export function Disconnect({ report }: { report: Report }) {
  const d = report.disconnect;
  return (
    <Section id="disconnect" title="The disconnect">
      {d.status === 'assessed' ? (
        <p className="max-w-3xl text-[1.3rem] leading-snug">
          <span className="mark">{d.headline}</span>
        </p>
      ) : (
        <p className="max-w-3xl text-[1.1rem]">{d.reason}</p>
      )}
      <p className="ui mt-3 max-w-3xl text-[0.9rem] text-ink-soft">
        The headline compares the two scores and is calculated. The points below are an AI model&apos;s reading of the
        evidence: each one is shown only because it cites a real Gemini answer and real audience evidence from this audit.
        The number of sources behind each point is counted and shown, because a point resting on two reports is not a
        finding about all customers.
      </p>

      {d.disagreements.length === 0 ? (
        <p className="mt-6 text-ink-soft">
          {d.note ?? 'No specific point of difference could be tied to evidence on both sides, so none is shown.'}
        </p>
      ) : (
        <ul className="mt-6">
          {d.disagreements.map((item) => (
            <li key={item.title} className="border-b border-rule py-5">
              <p className="ui text-[0.85rem] font-semibold text-ink-soft">{KIND_TEXT[item.kind]}</p>
              <h3 className="mt-1 text-xl font-semibold">{item.title}</h3>
              <div className="mt-3 grid gap-6 md:grid-cols-2">
                <div>
                  <p className="ui text-[0.9rem] font-semibold">
                    Reported by {item.audienceSourceCount} {item.audienceSourceCount === 1 ? 'source' : 'sources'}
                  </p>
                  <p className="mt-1">{item.audienceSays}</p>
                  <EvidenceRefs ids={item.audienceEvidenceIds} report={report} />
                </div>
                <div>
                  <p className="ui text-[0.9rem] font-semibold">Gemini says</p>
                  <p className="mt-1">{item.geminiSays}</p>
                  <EvidenceRefs ids={item.geminiEvidenceIds} report={report} />
                </div>
              </div>
              {item.implication ? (
                <p className="mt-3 max-w-3xl">
                  <span className="ui text-[0.9rem] font-semibold">Possible implication, not measured: </span>
                  {item.implication}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
