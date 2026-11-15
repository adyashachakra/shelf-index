import Link from 'next/link';
import { AuditForm } from '@/components/AuditForm';

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-5 pb-10 pt-12 sm:px-8 sm:pt-16">
      <h1 className="max-w-4xl text-[2.6rem] font-bold leading-[1.02] sm:text-7xl">
        What do people say about your brand, what does AI say about it, and where is the gap?
      </h1>
      <p className="mt-6 max-w-2xl text-[1.2rem] leading-snug">
        Enter a brand and a category. Shelf Index asks Gemini the questions shoppers ask, reads what customers actually
        say, checks the brand&apos;s own site, and shows where the three disagree, with a source behind every finding.
      </p>

      <div className="mt-10">
        <AuditForm />
      </div>

      <p className="ui mt-4 text-[0.95rem] text-ink-soft">
        Not ready to run one? <Link href="/example">Read the example report</Link> first.
      </p>

      <section id="method" className="mt-20 scroll-mt-6">
        <h2 className="shelf pt-4 text-2xl font-bold sm:text-[1.75rem]">What an audit measures</h2>
        <div className="mt-6 grid gap-8 md:grid-cols-3">
          <div>
            <h3 className="text-[1.15rem] font-semibold">Gemini API recommendation visibility</h3>
            <p className="mt-2 text-[0.98rem]">
              Eight questions a shopper would ask in the category are put to Google&apos;s Gemini model, one at a time and
              without naming the brand. The score reflects how often and how early Gemini recommends it.
            </p>
          </div>
          <div>
            <h3 className="text-[1.15rem] font-semibold">Audience perception</h3>
            <p className="mt-2 text-[0.98rem]">
              Reddit threads found through web search, independent reviews and a sample of public YouTube comments are
              read for sentiment and for the praise and complaints that keep coming up.
            </p>
          </div>
          <div>
            <h3 className="text-[1.15rem] font-semibold">Content gap severity</h3>
            <p className="mt-2 text-[0.98rem]">
              The brand&apos;s own pages are checked against the questions shoppers ask. A higher score means more of
              those questions go unanswered.
            </p>
          </div>
        </div>

        <div className="mt-10 max-w-3xl space-y-4">
          <p>
            Then the report looks between the lines: a competitor credited with the brand&apos;s own signature claim, a
            complaint repeated as fact, an outdated product, a brand people discuss that Gemini barely mentions. Each
            pattern is reported only when the evidence supports it. When it does not, the report says so.
          </p>
          <p>
            The scores are calculated in code from labeled evidence, and each comes with a confidence level. If there is
            not enough data for a score, you will see &ldquo;insufficient data&rdquo; and the reason, never a guess.
          </p>
          <p className="ui text-[0.95rem] text-ink-soft">
            This measures the Gemini API only, not every AI assistant, and it works from samples of public information.
            The tool runs entirely on free quotas, so only a few new audits can run each day. Reports are kept for 7
            days. <Link href="/privacy">Privacy and data</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
