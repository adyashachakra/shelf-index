import { evidenceClass } from '@/lib/evidence/relevance';
import type { ChecklistItem, EvidenceClass, Report } from '@/lib/types';
import { Section, SourceLink } from './parts';

const CLASS_TEXT: Record<EvidenceClass, string> = {
  clear: 'Answered clearly',
  touched_on: 'Touched on',
  not_addressed: 'Not addressed',
  uncertain: 'Uncertain',
};

/** Why the page evidence was or was not accepted, when the relevance check had something to say. */
function relevanceNote(item: ChecklistItem): string | null {
  if (item.relevance === 'different_product') {
    return `A page was found, but it is about ${item.evidenceAbout ?? 'a different product'}, not what this item asks about, so it does not count as an answer.`;
  }
  if (item.relevance === 'uncertain') {
    return `${item.relevanceNote ?? 'The evidence could not be tied to the question.'} It is left out of the score, and the score's confidence is lowered.`;
  }
  if (item.relevance === 'indirect') return item.relevanceNote ?? 'The page is about a related product or point, not a direct answer.';
  if ((item.expertEvidence || item.brandClaim) && item.relevanceNote) return item.relevanceNote;
  return null;
}

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
                    <span className={item.level === 'none' ? 'font-semibold' : ''}>
                      {CLASS_TEXT[evidenceClass(item)]}
                      {item.brandClaim && evidenceClass(item) === 'touched_on' ? ' \u2014 brand claim' : ''}
                    </span>
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
                    {relevanceNote(item) ? <span className="block text-ink-soft">{relevanceNote(item)}</span> : null}
                    {item.unanswered ? (
                      <span className="block text-ink-soft">No verdict came back for this item. It is left out of the score, and the score's confidence is lowered.</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ui mt-3 max-w-3xl text-[0.88rem] text-ink-soft">
            A page counts as an answer only when it is about what the item asks: the same product, or a fact about the
            whole brand. A statement about a different product, even from the same brand, does not. The pages read here
            are the brand&apos;s own. For a question of fact, such as where products are sold, a page can answer clearly.
            For a question about effectiveness, suitability, clinical performance or what experts recommend, the
            brand&apos;s own words show what the brand claims. They do not independently establish it, so the item counts
            as touched on and is labelled as a brand claim, even when the page names an expert or a study. A page saying
            experts only helped develop or test the products counts as touched on as well.
          </p>
        </div>
      )}

      {d.excluded.length > 0 ? (
        <div className="mt-6 max-w-3xl">
          <h3 className="text-lg font-semibold">Questions left out because they are outside the brand&apos;s range</h3>
          <p className="ui mt-1 text-[0.9rem] text-ink-soft">
            A question is left out only when the brand&apos;s own pages show it does not sell that kind of product, or when
            at least two websites describe it as sitting in a different price tier, at least one of them independent of the
            brand (a press release or other company material does not count), and Gemini did not name the brand when
            answering it.
          </p>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-[0.98rem]">
            {d.excluded.map((entry) => (
              <li key={entry.questionId}>
                {entry.question}
                <span className="ui block text-[0.9rem] text-ink-soft">
                  {entry.kind === 'price_tier' ? 'Different price tier. ' : 'Different kind of product. '}
                  {entry.reason}
                  {entry.sources && entry.sources.length > 0 ? (
                    entry.sources.map((source) => (
                      <span key={source.url}>
                        {' '}
                        <SourceLink url={source.url} illustrative={report.illustrative}>
                          {source.domain}
                        </SourceLink>
                      </span>
                    ))
                  ) : entry.sourceUrl ? (
                    <>
                      {' '}
                      <SourceLink url={entry.sourceUrl} illustrative={report.illustrative}>
                        source
                      </SourceLink>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.positioning.length > 0 || d.productLines.length > 0 || (d.productRange !== undefined && d.domain !== null) ? (
        <div className="mt-8 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="text-lg font-semibold">How the brand positions itself</h3>
            <PriceSupportNote report={report} />
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
          <ProductRange report={report} />
        </div>
      ) : null}
    </Section>
  );
}

function tierText(tier: 'budget' | 'premium' | null): string {
  return tier === 'budget' ? 'lower-priced' : 'premium';
}

/** How well the brand's price tier is supported. Reports saved before version 4 carry only the established position. */
function PriceSupportNote({ report }: { report: Report }) {
  const d = report.contentGap.detail;
  const support = d.priceSupport;
  if (!support) {
    // A report saved before the two-source rule: show what it recorded.
    return d.pricePosition ? (
      <p className="ui mt-2 text-[0.92rem]">
        <span className="font-semibold">Price position found in a source: </span>
        {tierText(d.pricePosition.tier)}.{' '}
        <SourceLink url={d.pricePosition.url} illustrative={report.illustrative}>
          {d.pricePosition.origin === 'brand_site' ? "the brand's own site" : d.pricePosition.domain}
        </SourceLink>
        <span className="italic text-ink-soft"> &ldquo;{d.pricePosition.quote}&rdquo;</span>
      </p>
    ) : (
      <p className="ui mt-2 text-[0.92rem] text-ink-soft">
        No retrieved source states the brand&apos;s price position in words, so no question was left out on price.
      </p>
    );
  }
  if (support.status === 'none') {
    return (
      <p className="ui mt-2 text-[0.92rem] text-ink-soft">
        No retrieved source states the brand&apos;s price position in words, so no question was left out on price.
      </p>
    );
  }
  if (support.status === 'not_independent') {
    return (
      <div className="ui mt-2 text-[0.92rem] text-ink-soft">
        <p>
          <span className="font-semibold text-ink">Price position: not established. </span>
          No source independent of the brand states it. The brand&apos;s own site and company material such as press
          releases do not count as independent evidence, so no question was left out on price.
        </p>
        <SetAside support={support} illustrative={report.illustrative} />
      </div>
    );
  }
  if (support.status === 'conflicting') {
    return (
      <p className="ui mt-2 text-[0.92rem] text-ink-soft">
        <span className="font-semibold text-ink">Price position: not established. </span>
        The sources found do not agree about the brand&apos;s price tier, so no question was left out on price.
      </p>
    );
  }
  const where = (s: (typeof support.sources)[number]) => (s.origin === 'brand_site' ? "the brand's own site" : s.domain);
  return (
    <div className="ui mt-2 text-[0.92rem]">
      <p>
        <span className="font-semibold">
          {support.status === 'established' ? 'Price position, supported by independent sources: ' : 'Price position, insufficiently supported: '}
        </span>
        {tierText(support.tier)}.
        {support.status === 'insufficient'
          ? ' Only one source states it. That is not enough to leave a question out, so price-tier questions stay counted.'
          : ''}
      </p>
      <ul className="mt-1">
        {support.sources.map((s) => (
          <li key={s.evidenceId + s.domain}>
            <SourceLink url={s.url} illustrative={report.illustrative}>
              {where(s)}
            </SourceLink>
            <span className="italic text-ink-soft"> &ldquo;{s.quote}&rdquo;</span>
          </li>
        ))}
      </ul>
      <SetAside support={support} illustrative={report.illustrative} />
    </div>
  );
}

/** Sources that were found but not counted, with the reason (press releases and other company material). */
function SetAside({ support, illustrative }: { support: NonNullable<Report["contentGap"]["detail"]["priceSupport"]>; illustrative?: boolean }) {
  if (!support.setAside || support.setAside.length === 0) return null;
  return (
    <div className="ui mt-2 text-[0.88rem] text-ink-soft">
      <p>Found but not counted as independent evidence:</p>
      <ul className="mt-1 list-disc pl-5">
        {support.setAside.map((entry) => (
          <li key={entry.url}>
            <SourceLink url={entry.url} illustrative={illustrative}>
              {entry.domain}
            </SourceLink>{' '}
            ({entry.reason}) <span className="italic">&ldquo;{entry.quote}&rdquo;</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const RANGE_HEADING: Record<'identified' | 'partial' | 'not_assessed', string> = {
  identified: 'Products identified in the pages read',
  partial: 'Product range: partially assessed',
  not_assessed: 'Product range: could not be assessed',
};

function ProductRange({ report }: { report: Report }) {
  const d = report.contentGap.detail;
  const range = d.productRange;
  return (
    <div>
      <h3 className="text-lg font-semibold">{range ? RANGE_HEADING[range.status] : "Product lines found on the brand's own site"}</h3>
      {range ? (
        <p className="ui mt-1 text-[0.88rem] text-ink-soft">{range.note}</p>
      ) : (
        <p className="ui mt-1 text-[0.88rem] text-ink-soft">
          Read from the pages this audit retrieved, each confirmed by a quote from a page. A sample of the site, and
          separate from the products Gemini lists.
        </p>
      )}
      {d.productLines.length === 0 ? (
        range ? null : <p className="mt-2 text-ink-soft">No product line could be verified on the pages read.</p>
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
  );
}
