import type { EvidenceItem, EvidenceKind, MatchedContext, Report } from '@/lib/types';
import { formatDateTime, Section, SourceLink } from './parts';

const KIND_HEADINGS: { kind: EvidenceKind; title: string }[] = [
  { kind: 'discussion', title: 'Community discussions' },
  { kind: 'review', title: 'Independent reviews and publications' },
  { kind: 'youtube_video', title: 'YouTube videos' },
  { kind: 'youtube_comment', title: 'YouTube comments' },
  { kind: 'site_page', title: "The brand's own pages" },
  { kind: 'claim_source', title: 'Sources used to check statements' },
];

const CONTEXT_RULE_TEXT: Record<MatchedContext['rule'], string> = {
  follower: 'a short capitalised word after the name',
  particle: 'the name followed by a name particle',
  joined: 'the name joined by a hyphen',
  prefix: 'joined to an earlier word by a hyphen',
  'run-together': 'the name with letters written straight on',
};
const CONTEXT_FIELDS = new Set(['title', 'snippet', 'description', 'page text', 'comment']);

/**
 * The text that triggered a "Found but not counted" entry, with the triggering part highlighted. Reports saved before
 * format 9 have no such field, and a field that is not well formed is ignored, so those entries show exactly as before.
 * React renders the text as plain text, so nothing in it can act as markup.
 */
function matchedContextOf(entry: { matchedContext?: unknown }): MatchedContext | null {
  const c = entry.matchedContext as Partial<MatchedContext> | null | undefined;
  if (!c || typeof c !== 'object') return null;
  if (typeof c.text !== 'string' || !Number.isInteger(c.markFrom) || !Number.isInteger(c.markTo)) return null;
  const from = c.markFrom as number;
  const to = c.markTo as number;
  if (from < 0 || to <= from || to > c.text.length) return null;
  if (typeof c.field !== 'string' || !CONTEXT_FIELDS.has(c.field)) return null;
  if (typeof c.rule !== 'string' || !(c.rule in CONTEXT_RULE_TEXT)) return null;
  return c as MatchedContext;
}

const TIER_TEXT = {
  full: 'Full: every search in the plan',
  reduced: 'Reduced: competitor sentiment skipped to protect the monthly budget',
  minimal: 'Minimal: only the essential searches, to protect the monthly budget',
};

function SourceGroup({
  title,
  items,
  read,
  illustrative,
}: {
  title: string;
  items: EvidenceItem[];
  /** How many of this kind were read in total, when that differs from the number listed. */
  read?: number;
  illustrative?: boolean;
}) {
  if (items.length === 0) return null;
  const count = read !== undefined && read !== items.length ? `${items.length} listed of ${read} read` : String(items.length);
  return (
    <div className="mt-5">
      <h4 className="ui text-[0.98rem] font-semibold">
        {title} ({count})
      </h4>
      <ul className="ui mt-1 space-y-1 text-[0.9rem]">
        {items.map((item) => (
          <li key={item.id}>
            <SourceLink url={item.url} illustrative={illustrative}>
              {item.title || item.url}
            </SourceLink>
            <span className="text-ink-faint"> {item.domain}</span>
            {item.sponsored && item.sponsored.length > 0 ? <span className="text-ink-soft"> (disclosure: {item.sponsored.join(', ')})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SourcesAndMethod({ report }: { report: Report }) {
  const m = report.methodology;
  const read = report.perception.detail.sample.read;
  const readByKind: Partial<Record<EvidenceKind, number>> = {
    discussion: read.discussions,
    review: read.reviews,
    youtube_video: read.videos,
    youtube_comment: read.comments,
  };
  return (
    <Section
      id="method"
      title="Sources and methodology"
      intro="Scores are single-audit estimates based on a sample of public information. The same audit run again can give different scores, because the sources retrieved and the AI's interpretation of them can change. Everything below is what this particular audit actually did."
    >
      <dl className="ui grid max-w-3xl grid-cols-1 gap-x-8 gap-y-2 text-[0.95rem] sm:grid-cols-2">
        <div>
          <dt className="font-semibold">Audited</dt>
          <dd>{formatDateTime(m.auditedAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold">Gemini model</dt>
          <dd>
            {m.model} (Gemini API, no web search)
            {m.modelConfigured !== m.model ? `. Requested as ${m.modelConfigured}` : ''}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Questions</dt>
          <dd>
            {m.questions.planned} asked, {m.questions.answered} answered, {m.questions.failed} without an answer,{' '}
            {m.questions.excluded} outside the brand&apos;s range, {m.questions.counted} counted
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Question set version</dt>
          <dd>{m.questionBankVersion}</dd>
        </div>
        <div>
          <dt className="font-semibold">YouTube sample</dt>
          <dd>
            {m.youtube.status === 'unavailable' || m.youtube.status === 'skipped'
              ? `Not available${m.youtube.note ? `: ${m.youtube.note}` : ''}`
              : `${m.youtube.videos} videos and ${m.youtube.comments} comments read${m.youtube.note ? `. ${m.youtube.note}` : ''}`}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Brand site</dt>
          <dd>{m.sitePages} readable pages</dd>
        </div>
        <div>
          <dt className="font-semibold">Research depth</dt>
          <dd>{TIER_TEXT[m.tier]}</dd>
        </div>
        <div>
          <dt className="font-semibold">Requests used</dt>
          <dd>
            {m.geminiRequests} Gemini requests, {m.tavilyCreditsUsed} search credits
          </dd>
        </div>
      </dl>

      <p className="ui mt-4 max-w-3xl text-[0.92rem] text-ink-soft">
        <span className="font-semibold text-ink">Why this model. </span>
        {m.modelNote} The visibility score describes this model only.
      </p>

      {m.unavailable.length > 0 ? (
        <div className="mt-8 max-w-3xl bg-surface p-4">
          <h3 className="text-lg font-semibold">What was missing from this audit</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.98rem]">
            {m.unavailable.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.identity ? (
        <div className="mt-8 max-w-3xl">
          <h3 className="text-lg font-semibold">Who the brand was established to be</h3>
          <p className="ui mt-2 text-[0.95rem]">{report.identity.summary}</p>
          {report.identity.setAsideCount > 0 ? (
            <div className="mt-4">
              <h4 className="ui text-[0.98rem] font-semibold">
                Found but not counted ({report.identity.setAside.length === report.identity.setAsideCount ? report.identity.setAsideCount : `${report.identity.setAside.length} listed of ${report.identity.setAsideCount}`})
              </h4>
              <p className="ui mt-1 text-[0.9rem] text-ink-soft">
                These results used a name or web address similar to {report.brand} but were not shown to be about it, so they are not in any score, theme, comparison or recommendation.
              </p>
              <ul className="ui mt-2 space-y-2 text-[0.9rem]">
                {report.identity.setAside.map((entry) => (
                  <li key={entry.url}>
                    <SourceLink url={entry.url} illustrative={report.illustrative}>
                      {entry.title || entry.url}
                    </SourceLink>
                    <span className="text-ink-faint"> {entry.domain}</span>
                    <span className="block text-ink-soft">{entry.reason}</span>
                    {(() => {
                      const matched = matchedContextOf(entry);
                      if (!matched) return null;
                      return (
                        <span className="block text-ink-soft">
                          Text that triggered this ({matched.field}, {CONTEXT_RULE_TEXT[matched.rule]}): {matched.text.slice(0, matched.markFrom)}
                          <mark className="bg-yellow-200 text-ink">{matched.text.slice(matched.markFrom, matched.markTo)}</mark>
                          {matched.text.slice(matched.markTo)}
                        </span>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <h3 className="mt-10 text-xl font-semibold">How the scores are calculated</h3>
      <div className="mt-3 max-w-3xl space-y-4 text-[0.98rem]">
        <p>
          <span className="font-semibold">Gemini API recommendation visibility. </span>
          For each counted question the brand earns credit for where Gemini placed it: 1.00 for first recommendation,
          0.85 second, 0.70 third, 0.55 fourth, 0.45 fifth, 0.35 lower, 0.20 if named but not recommended, 0 if absent
          or cautioned against. The score is 100 times the total credit divided by the counted questions. A question
          Gemini failed to answer is missing data and is left out. A question is left out as outside the brand&apos;s
          range in two cases only, the same in every category: the brand&apos;s own site shows it sells nothing of that
          kind, or the question asks about a price tier (luxury, or low-priced) and a retrieved source says in words
          that the brand sits in the other tier. In both cases Gemini must also not have named the brand for that
          question. Fewer than 5 counted questions gives no score.
        </p>
        <p>
          <span className="font-semibold">Audience perception. </span>
          Each excerpt or comment is labeled as about the brand or not, by voice and by sentiment. Those that are about
          the brand, take a side and were not written by the brand are counted as opinions: customers at full weight,
          creators, publications and unclear voices at half. The score is 100 times (positive plus half of mixed)
          divided by all counted opinions, using the weighted counts. Fewer than 8 counted opinions or fewer than 3
          unique sources gives no score. A theme of praise or complaint is listed when two or more items show it, and
          the report states how many sources the analysis cited for it. That number is a count of this sample. It is
          not a measure of how common the experience is among all customers.
        </p>
        <p>
          <span className="font-semibold">Content gap severity. </span>
          The checklist is the category questions that fit the brand&apos;s range plus customer concerns raised in the evidence. Each
          is labeled clear, partial or none against the brand&apos;s own pages, and a clear or partial label must quote a
          page that was retrieved. The score is 100 times (none plus half of partial) divided by the checklist size, so
          higher is worse. An unidentified site, fewer than 3 readable pages or fewer than 4 checklist items gives no
          score.
        </p>
        <p>
          <span className="font-semibold">Between the lines. </span>
          A pattern is called observed only when this audit holds the evidence for it. A pattern that depends on
          customer complaints needs five or more separate sources reporting the complaint. With fewer it is shown as
          a possibility on limited evidence. Whether Gemini describes the brand through a single product is counted
          from two separate lists that are never merged: the products Gemini names when asked what the brand sells
          (the model&apos;s own account), and the product lines found on the brand&apos;s own pages (each confirmed by
          a quote from a page, and only a sample of the site). Where the audit has no evidence either way, for example
          about which sources Gemini relies on, the pattern is marked as not assessable and no explanation is offered.
        </p>
        <p>
          <span className="font-semibold">Wording screen. </span>
          What the AI model writes about complaints, implications and recommendations is checked against a list of
          phrasings that state a cause, generalise from a few reports or promise a business result. Matches are
          replaced by a plain statement, and a cause is kept only where the sentence attributes it to the customers
          who said it. This is a screen for known phrasings. It is not a detector of every unsupported causal claim.
        </p>
        <p>
          <span className="font-semibold">Confidence </span>
          reflects sample size and diversity for each metric. No overall score is produced, and overall confidence is
          stated only when all three metrics could be assessed.
        </p>
      </div>

      <h3 className="mt-10 text-xl font-semibold">Limits of this audit</h3>
      <ul className="mt-3 max-w-3xl list-disc space-y-2 pl-5 text-[0.98rem]">
        {m.limitations.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>

      <h3 className="mt-10 text-xl font-semibold">Searches run</h3>
      {m.searches.length === 0 ? (
        <p className="mt-2 text-ink-soft">No searches were recorded.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="ui w-full min-w-[640px] border-collapse text-left text-[0.9rem]">
            <thead>
              <tr className="border-b-2 border-ink">
                <th className="py-2 pr-4 font-semibold">Purpose</th>
                <th className="py-2 pr-4 font-semibold">Where</th>
                <th className="py-2 pr-4 font-semibold">Results kept</th>
                <th className="py-2 font-semibold">Credits</th>
              </tr>
            </thead>
            <tbody>
              {m.searches.map((search, index) => (
                <tr key={`${search.purpose}-${index}`} className="border-b border-rule align-top">
                  <td className="py-2 pr-4">
                    {search.purpose}
                    {search.note ? <span className="block text-ink-soft">{search.note}</span> : null}
                  </td>
                  <td className="py-2 pr-4">{search.scope}</td>
                  <td className="py-2 pr-4 tabular-nums">{search.ok ? `${search.kept} of ${search.results}` : 'Search did not complete'}</td>
                  <td className="py-2 tabular-nums">{search.credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-10 text-xl font-semibold">Sources consulted</h3>
      {report.evidence.length === 0 ? <p className="mt-2 text-ink-soft">No external sources were retrieved.</p> : null}
      {KIND_HEADINGS.map(({ kind, title }) => (
        <SourceGroup
          key={kind}
          title={title}
          items={report.evidence.filter((e) => e.kind === kind)}
          read={readByKind[kind]}
          illustrative={report.illustrative}
        />
      ))}
    </Section>
  );
}
