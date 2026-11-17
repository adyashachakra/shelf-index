import type { ClaimCheck, Placement, Report, VisibilityRow } from '@/lib/types';
import { Section, SourceLink } from './parts';

function placementText(placement: Placement | undefined): string {
  if (!placement) return 'Not named';
  if (placement.kind === 'recommended') return `Recommended, position ${placement.position}`;
  if (placement.kind === 'mentioned') return 'Named, not recommended';
  if (placement.kind === 'cautioned') return 'Cautioned against';
  return 'Not named';
}

function rowState(row: VisibilityRow): string {
  if (row.state === 'no_answer') return 'No answer (missing data)';
  if (row.state === 'excluded') return "Not counted: outside the brand's range";
  return placementText(row.placement);
}

const VERDICT_TEXT: Record<ClaimCheck['verdict'], string> = {
  supported: 'Supported by a source',
  contradicted: 'Contradicted by a source',
  unverified: 'Could not be verified',
};

export function AiVisibility({ report }: { report: Report }) {
  const detail = report.visibility.detail;
  const profile = report.brandProfile;
  const notRecognised = report.visibility.metric.status === 'not_recognised';
  return (
    <Section
      id="ai-recommendations"
      title="What Gemini says"
      intro={`Eight shopper questions were put to ${report.model} through the Gemini API, one at a time, without naming ${report.brand} and without web search. This measures the Gemini API only. It does not reproduce the Gemini app, and it says nothing about other AI assistants.`}
    >
      {report.visibility.metric.status === 'not_recognised' ? (
        <p className="ui mb-4 max-w-3xl border-l-4 border-ink bg-surface px-4 py-3 text-[0.95rem]">
          <span className="font-semibold">Brand not recognised in this category. </span>
          {report.visibility.metric.reason} The table shows which brands Gemini recommended. The column for {report.brand} is not a measurement.
        </p>
      ) : null}
      <p className="ui text-[0.95rem]">
        {detail.counted} of {detail.planned} questions counted.
        {detail.failed > 0 ? ` ${detail.failed} had no answer from Gemini and are treated as missing data, not as zero.` : ''}
        {detail.excluded > 0 ? ` ${detail.excluded} left out as outside the brand's range, each with the evidence shown.` : ''}
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="ui w-full min-w-[640px] border-collapse text-left text-[0.93rem]">
          <thead>
            <tr className="border-b-2 border-ink">
              <th className="py-2 pr-4 font-semibold">Shopper question</th>
              <th className="py-2 pr-4 font-semibold">{report.brand}</th>
              <th className="py-2 pr-4 font-semibold">Credit</th>
              <th className="py-2 font-semibold">Brands Gemini recommended</th>
            </tr>
          </thead>
          <tbody>
            {detail.rows.map((row) => (
              <tr key={row.answerId} className="border-b border-rule align-top">
                <td className="py-2.5 pr-4">
                  <a href={`#answer-${row.answerId}`}>{row.question}</a>
                </td>
                <td className="py-2.5 pr-4">
                  {notRecognised && row.state === 'counted' ? 'Not compared' : rowState(row)}
                  {row.exclusionReason ? <span className="block text-ink-soft">{row.exclusionReason}</span> : null}
                  {row.failureReason ? <span className="block text-ink-soft">{row.failureReason}</span> : null}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">{row.state === 'counted' && row.credit !== undefined ? row.credit.toFixed(2) : 'n/a'}</td>
                <td className="py-2.5">{row.topBrands.length > 0 ? row.topBrands.join(', ') : 'None named'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div id="gemini-description" className="mt-10 scroll-mt-6">
        <h3 className="text-xl font-semibold">How Gemini describes {report.brand}</h3>
        {!profile ? (
          <p className="mt-2 text-ink-soft">Gemini&apos;s description could not be retrieved in this audit.</p>
        ) : !profile.recognized ? (
          <p className="mt-2">Gemini did not recognise {report.brand} in this category. It was asked not to guess.</p>
        ) : (
          <div className="mt-2 max-w-3xl">
            <p>{profile.description}</p>
            {profile.knownFor.length > 0 ? (
              <p className="ui mt-3 text-[0.95rem]">
                <span className="font-semibold">Known for: </span>
                {profile.knownFor.join('; ')}
              </p>
            ) : null}
            {profile.products.length > 0 ? (
              <p className="ui mt-1 text-[0.95rem]">
                <span className="font-semibold">Products Gemini listed when asked what the brand sells (the model&apos;s own account, not taken from the brand&apos;s site): </span>
                {profile.products.join('; ')}
              </p>
            ) : null}
            {profile.criticisms.length > 0 ? (
              <p className="ui mt-1 text-[0.95rem]">
                <span className="font-semibold">Criticisms it mentions: </span>
                {profile.criticisms.join('; ')}
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="mt-10">
        <h3 className="text-xl font-semibold">Gemini&apos;s statements, checked against sources</h3>
        {report.claims.length === 0 ? (
          <p className="mt-2 text-ink-soft">{report.claimsNote ?? 'There were no checkable statements in this audit.'}</p>
        ) : (
          <ul className="mt-3 max-w-3xl">
            {report.claims.map((claim) => (
              <li key={claim.id} className="border-b border-rule py-3">
                <p>{claim.text}</p>
                <p className="ui mt-1 text-[0.9rem]">
                  <span className="font-semibold">{VERDICT_TEXT[claim.verdict]}</span>
                  {claim.url ? (
                    <>
                      {': '}
                      <SourceLink url={claim.url} illustrative={report.illustrative}>
                        source
                      </SourceLink>
                    </>
                  ) : null}
                  {claim.note ? <span className="text-ink-soft"> {claim.note}</span> : null}
                </p>
                {claim.quote ? (
                  <p className="mt-1 text-[0.95rem] italic">
                    <span className="mark">&ldquo;{claim.quote}&rdquo;</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {report.claimsNote && report.claims.length > 0 ? <p className="ui mt-2 text-[0.9rem] text-ink-soft">{report.claimsNote}</p> : null}
      </div>

      <details className="mt-10">
        <summary className="ui cursor-pointer text-[1.05rem] font-semibold">Read Gemini&apos;s saved answers in full</summary>
        <div className="mt-4 space-y-6">
          {[...report.answers, ...(report.signatureAnswer ? [report.signatureAnswer] : [])].map((answer) => (
            <div key={answer.id} id={answer.id === 'GS' ? 'signature-answer' : `answer-${answer.id}`} className="scroll-mt-6 bg-surface p-4">
              <p className="ui font-semibold">{answer.question}</p>
              {answer.status === 'answered' ? (
                <p className="mt-2 text-[0.98rem]">{answer.answer}</p>
              ) : (
                <p className="mt-2 text-ink-soft">No answer: {answer.failureReason ?? 'Gemini did not respond'}.</p>
              )}
            </div>
          ))}
        </div>
      </details>
    </Section>
  );
}
