import type { Report, SampleCounts, Theme } from '@/lib/types';
import { EvidenceRefs, Quote, Section, SourceLink } from './parts';

/** How far a theme reaches, said plainly, so two reports are never read as a finding about every customer. */
function reachNote(theme: Theme, kind: 'praise' | 'complaint'): string {
  if (theme.sourceCount <= 3) {
    return kind === 'complaint'
      ? 'A small number of individual reports. They do not show a brand-wide problem or a safety issue.'
      : 'A small number of individual accounts.';
  }
  if (theme.sourceCount <= 7) return 'Several separate sources say this. It is still a sample of what people post.';
  return 'Raised across many of the sources read.';
}

function scopeNote(theme: Theme): string | null {
  if (theme.scope === 'product') return `About one product: ${theme.product ?? 'named in the sources'}. Not about the whole range.`;
  if (theme.scope === 'brand') return 'About the brand in general, according to these sources.';
  return null;
}

function ThemeList({
  title,
  themes,
  report,
  empty,
  kind,
}: {
  title: string;
  themes: Theme[];
  report: Report;
  empty: string;
  kind: 'praise' | 'complaint';
}) {
  const sourcesAboutBrand = report.perception.detail.sourcesAboutBrand;
  return (
    <div>
      <h3 className="text-xl font-semibold">{title}</h3>
      {themes.length === 0 ? (
        <p className="mt-2 text-ink-soft">{empty}</p>
      ) : (
        <ul className="mt-2">
          {themes.map((theme) => {
            const scope = scopeNote(theme);
            return (
              <li key={theme.label} className="border-b border-rule py-4">
                <p className="ui font-semibold">{theme.label}</p>
                <p className="mt-1">{theme.summary}</p>
                {theme.quote ? <Quote text={theme.quote.text} /> : null}
                <p className="ui mt-2 text-[0.88rem]">
                  <span className="font-semibold">
                    Reported in {theme.sourceCount} of the {sourcesAboutBrand} sources about the brand
                  </span>
                  <span className="text-ink-soft">
                    {' '}
                    ({theme.itemCount} individual {theme.itemCount === 1 ? 'excerpt or comment' : 'excerpts or comments'}). {reachNote(theme, kind)}
                  </span>
                </p>
                {scope ? <p className="ui mt-1 text-[0.88rem] text-ink-soft">{scope}</p> : null}
                <EvidenceRefs ids={theme.evidenceIds} report={report} label="Sources" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const SAMPLE_ROWS: { key: keyof SampleCounts; label: string }[] = [
  { key: 'discussions', label: 'Reddit thread excerpts' },
  { key: 'reviews', label: 'Review and article pages' },
  { key: 'videos', label: 'YouTube videos (title and description)' },
  { key: 'comments', label: 'Individual YouTube comments' },
];

function total(counts: SampleCounts): number {
  return counts.discussions + counts.reviews + counts.videos + counts.comments;
}

export function AudiencePerception({ report }: { report: Report }) {
  const { perception } = report;
  const d = perception.detail;
  const byId = new Map(report.evidence.map((e) => [e.id, e]));
  const voice = (score: number | null) => (score === null ? 'not enough to score' : String(score));
  return (
    <Section
      id="audience-perception"
      title="What people say"
      intro="Drawn from Reddit threads surfaced by web search, independent reviews and publications, and a sample of public YouTube comments. Customers count fully; creators and publications count half. These are the views of people who chose to post, not a survey of all customers."
    >
      <div className="grid gap-10 md:grid-cols-2">
        <ThemeList
          title="What people praise"
          themes={perception.praise}
          report={report}
          kind="praise"
          empty="No point of praise appeared in at least two separate items of evidence."
        />
        <ThemeList
          title="What people complain about"
          themes={perception.complaints}
          report={report}
          kind="complaint"
          empty="No complaint appeared in at least two separate items of evidence."
        />
      </div>
      {perception.themesNote ? <p className="ui mt-4 text-[0.9rem] text-ink-soft">{perception.themesNote}</p> : null}

      <div className="mt-10">
        <h3 className="text-xl font-semibold">How the sample breaks down</h3>
        <p className="ui mt-2 max-w-3xl text-[0.9rem] text-ink-soft">
          Three different things are counted. An <span className="font-semibold text-ink">opinion</span> is one excerpt
          or comment that takes a view on the brand. A <span className="font-semibold text-ink">source</span> is the
          thread, page or video it came from, so several comments can share one source. A{' '}
          <span className="font-semibold text-ink">website</span> is where that source lives.
        </p>
        {/* No minimum width: on a phone all four columns must stay on screen, so headers wrap. */}
        <table className="ui mt-3 w-full max-w-3xl border-collapse text-left text-[0.93rem]">
          <thead>
            <tr className="border-b-2 border-ink align-bottom">
              <th className="py-2 pr-3 font-semibold">Material</th>
              <th className="w-[4.5rem] py-2 pr-3 text-right font-semibold sm:w-24">Read</th>
              <th className="w-[4.5rem] py-2 pr-3 text-right font-semibold sm:w-36">About the brand</th>
              <th className="w-[5rem] py-2 text-right font-semibold sm:w-44">Counted as opinions</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ROWS.map((row) => (
              <tr key={row.key} className="border-b border-rule">
                <td className="py-2 pr-3">{row.label}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{d.sample.read[row.key]}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{d.sample.aboutBrand[row.key]}</td>
                <td className="py-2 text-right tabular-nums">{d.sample.counted[row.key]}</td>
              </tr>
            ))}
            <tr className="border-b border-rule font-semibold">
              <td className="py-2 pr-3">Total</td>
              <td className="py-2 pr-3 text-right tabular-nums">{total(d.sample.read)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{total(d.sample.aboutBrand)}</td>
              <td className="py-2 text-right tabular-nums">{total(d.sample.counted)}</td>
            </tr>
          </tbody>
        </table>
        <p className="ui mt-3 max-w-3xl text-[0.9rem] text-ink-soft">
          The {d.raw.counted} counted opinions come from {d.uniqueSources} unique source{d.uniqueSources === 1 ? '' : 's'} on{' '}
          {d.uniqueDomains.length} website{d.uniqueDomains.length === 1 ? '' : 's'}
          {d.uniqueDomains.length > 0 ? ` (${d.uniqueDomains.join(', ')})` : ''}. Not counted: {d.raw.neutral} about the
          brand but neutral, {d.raw.irrelevant} not about the brand, {d.raw.brandCreated} written by the brand.
        </p>
      </div>

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        <div>
          <h3 className="text-xl font-semibold">Who is speaking</h3>
          <table className="ui mt-3 w-full border-collapse text-left text-[0.93rem]">
            <thead>
              <tr className="border-b-2 border-ink">
                <th className="py-2 pr-3 font-semibold">Voice</th>
                <th className="py-2 pr-3 font-semibold">Counted opinions</th>
                <th className="py-2 font-semibold">Sentiment on its own</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule">
                <td className="py-2 pr-3">Customers</td>
                <td className="py-2 pr-3 tabular-nums">{d.byVoice.customer}</td>
                <td className="py-2">{voice(d.voiceScores.customer)}</td>
              </tr>
              <tr className="border-b border-rule">
                <td className="py-2 pr-3">Creators</td>
                <td className="py-2 pr-3 tabular-nums">{d.byVoice.creator}</td>
                <td className="py-2">{voice(d.voiceScores.creator)}</td>
              </tr>
              <tr className="border-b border-rule">
                <td className="py-2 pr-3">Publications</td>
                <td className="py-2 pr-3 tabular-nums">{d.byVoice.publication}</td>
                <td className="py-2">{voice(d.voiceScores.publication)}</td>
              </tr>
              <tr className="border-b border-rule">
                <td className="py-2 pr-3">Unclear</td>
                <td className="py-2 pr-3 tabular-nums">{d.byVoice.unclear}</td>
                <td className="py-2">n/a</td>
              </tr>
            </tbody>
          </table>
          <p className="ui mt-3 text-[0.9rem] text-ink-soft">
            Raw counts: {d.raw.positive} positive, {d.raw.mixed} mixed, {d.raw.negative} negative. Weighted counts used in
            the score: {d.weighted.positive} positive, {d.weighted.mixed} mixed, {d.weighted.negative} negative.
          </p>
          {perception.creatorVsCustomer ? (
            <p className="mt-4 text-[0.98rem]">
              <span className="ui text-[0.85rem] font-semibold">AI-written reading of the evidence: </span>
              {perception.creatorVsCustomer}
            </p>
          ) : (
            <p className="ui mt-4 text-[0.9rem] text-ink-soft">
              There was not enough creator and customer evidence side by side to describe a difference between them.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-xl font-semibold">Customer advocacy</h3>
          {perception.advocacy.length === 0 ? (
            <p className="mt-2 text-ink-soft">No customer was found recommending the brand from their own experience in this sample.</p>
          ) : (
            <ul className="mt-2">
              {perception.advocacy.map((note) => {
                const item = byId.get(note.evidenceId);
                return (
                  <li key={note.evidenceId} className="border-b border-rule py-3">
                    <p>{note.note}</p>
                    {item ? (
                      <p className="ui mt-1 text-[0.88rem]">
                        <SourceLink url={item.url} illustrative={report.illustrative}>
                          {item.kind === 'youtube_comment' ? 'YouTube comment' : item.domain}
                        </SourceLink>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="mt-8 text-xl font-semibold">Sponsored content</h3>
          {d.sponsoredItems.length === 0 ? (
            <p className="mt-2 text-ink-soft">
              No sponsorship disclosure was found in the sources read. Undisclosed sponsorship cannot be detected.
            </p>
          ) : (
            <ul className="mt-2">
              {d.sponsoredItems.map((entry) => {
                const item = byId.get(entry.evidenceId);
                return (
                  <li key={entry.evidenceId} className="border-b border-rule py-3 text-[0.98rem]">
                    {item ? (
                      <SourceLink url={item.url} illustrative={report.illustrative}>
                        {item.title}
                      </SourceLink>
                    ) : (
                      entry.evidenceId
                    )}
                    <span className="ui block text-[0.88rem] text-ink-soft">Disclosure found: {entry.signals.join(', ')}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}
