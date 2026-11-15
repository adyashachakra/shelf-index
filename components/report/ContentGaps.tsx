import type { ChecklistItem, CoverageLevel, Report } from '@/lib/types';
import { Section, SourceLink } from './parts';

const LEVEL_TEXT: Record<CoverageLevel, string> = {
  clear: 'Answered clearly',
  partial: 'Touched on',
  none: 'Not addressed',
};

function geminiColumn(item: ChecklistItem): string {
  if (item.source !== 'category_question') return 'n/a';
  if (item.geminiNamedBrand === null || item.geminiNamedBrand === undefined) return 'No answer';
  return item.geminiNamedBrand ? 'Answered, naming the brand' : 'Answered, without the brand';
}

export function ContentGaps({ report }: { report: Report }) {
  const d = report.contentGap.detail;
  return (
    <Section
      id="content-gaps"
      title="Does the brand's own site answer what shoppers ask?"
      intro={
        d.domain
          ? `${d.pagesRead} pages from ${d.domain} were read (found by search, not a full crawl). Each question is compared three ways: shoppers ask it, Gemini answers it, and the site does or does not address it.`
          : "The brand's own site could not be assessed in this audit."
      }
    >
      {d.checklist.length === 0 ? (
        <p className="text-ink-soft">{report.contentGap.metric.status === 'insufficient' ? report.contentGap.metric.reason : 'No checklist could be built.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui w-full min-w-[680px] border-collapse text-left text-[0.93rem]">
            <thead>
              <tr className="border-b-2 border-ink">
                <th className="py-2 pr-4 font-semibold">What shoppers ask</th>
                <th className="py-2 pr-4 font-semibold">Gemini</th>
                <th className="py-2 font-semibold">The brand&apos;s site</th>
              </tr>
            </thead>
            <tbody>
              {d.checklist.map((item) => (
                <tr key={item.id} className="border-b border-rule align-top">
                  <td className="py-2.5 pr-4">
                    {item.text}
                    {item.source === 'customer_concern' ? <span className="block text-ink-soft">Raised by customers in the evidence</span> : null}
                  </td>
                  <td className="py-2.5 pr-4">{geminiColumn(item)}</td>
                  <td className="py-2.5">
                    <span className={item.level === 'none' ? 'font-semibold' : ''}>{LEVEL_TEXT[item.level]}</span>
                    {item.url ? (
                      <>
                        {': '}
                        <SourceLink url={item.url} illustrative={report.illustrative}>
                          page
                        </SourceLink>
                      </>
                    ) : null}
                    {item.quote ? <span className="block italic text-ink-soft">&ldquo;{item.quote}&rdquo;</span> : null}
                    {item.downgraded ? <span className="block text-ink-soft">Lowered one level: the supporting quote could not be found on the page.</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.excluded.length > 0 ? (
        <div className="mt-6 max-w-3xl">
          <h3 className="text-lg font-semibold">Questions left out because they are outside the product range</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-[0.98rem]">
            {d.excluded.map((entry) => (
              <li key={entry.questionId}>
                {entry.question}
                <span className="ui block text-[0.9rem] text-ink-soft">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.positioning.length > 0 || d.productLines.length > 0 ? (
        <div className="mt-8 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="text-lg font-semibold">How the brand positions itself</h3>
            {d.positioning.length === 0 ? (
              <p className="mt-2 text-ink-soft">No positioning statement could be verified on the pages read.</p>
            ) : (
              <ul className="mt-2">
                {d.positioning.map((entry) => (
                  <li key={entry.statement} className="border-b border-rule py-3">
                    <p>{entry.statement}</p>
                    <p className="ui mt-1 text-[0.88rem]">
                      <SourceLink url={entry.ref.url} illustrative={report.illustrative}>
                        source page
                      </SourceLink>
                      <span className="italic text-ink-soft"> &ldquo;{entry.ref.quote}&rdquo;</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-lg font-semibold">Product lines found on the site</h3>
            {d.productLines.length === 0 ? (
              <p className="mt-2 text-ink-soft">No product line could be verified on the pages read.</p>
            ) : (
              <ul className="ui mt-2 text-[0.95rem]">
                {d.productLines.map((line) => (
                  <li key={line.name} className="border-b border-rule py-2">
                    <SourceLink url={line.ref.url} illustrative={report.illustrative}>
                      {line.name}
                    </SourceLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Section>
  );
}
