import type { Report, Theme } from '@/lib/types';
import { EvidenceRefs, Quote, Section, SourceLink } from './parts';

function ThemeList({ title, themes, report, empty }: { title: string; themes: Theme[]; report: Report; empty: string }) {
  return (
    <div>
      <h3 className="text-xl font-semibold">{title}</h3>
      {themes.length === 0 ? (
        <p className="mt-2 text-ink-soft">{empty}</p>
      ) : (
        <ul className="mt-2">
          {themes.map((theme) => (
            <li key={theme.label} className="border-b border-rule py-4">
              <p className="ui font-semibold">{theme.label}</p>
              <p className="mt-1">{theme.summary}</p>
              {theme.quote ? <Quote text={theme.quote.text} /> : null}
              <EvidenceRefs ids={theme.evidenceIds} report={report} label={`Seen in ${theme.evidenceIds.length} sources`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
      intro="Drawn from Reddit threads surfaced by web search, independent reviews and publications, and a sample of public YouTube comments. Customers count fully; creators and publications count half."
    >
      <div className="grid gap-10 md:grid-cols-2">
        <ThemeList
          title="Recurring praise"
          themes={perception.praise}
          report={report}
          empty="No theme of praise appeared in at least two separate sources."
        />
        <ThemeList
          title="Recurring complaints"
          themes={perception.complaints}
          report={report}
          empty="No complaint appeared in at least two separate sources."
        />
      </div>
      {perception.themesNote ? <p className="ui mt-4 text-[0.9rem] text-ink-soft">{perception.themesNote}</p> : null}

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        <div>
          <h3 className="text-xl font-semibold">Who is speaking</h3>
          <table className="ui mt-3 w-full border-collapse text-left text-[0.93rem]">
            <thead>
              <tr className="border-b-2 border-ink">
                <th className="py-2 pr-3 font-semibold">Source type</th>
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
            the score: {d.weighted.positive} positive, {d.weighted.mixed} mixed, {d.weighted.negative} negative. Set aside:{' '}
            {d.raw.neutral} neutral, {d.raw.irrelevant} not about the brand, {d.raw.brandCreated} written by the brand.
          </p>
          <p className="ui mt-2 text-[0.9rem] text-ink-soft">
            {d.uniqueSources} distinct sources across {d.uniqueDomains.length} unique domain{d.uniqueDomains.length === 1 ? '' : 's'}
            {d.uniqueDomains.length > 0 ? ` (${d.uniqueDomains.join(', ')})` : ''}.
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
