import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy and data',
  description: 'What Shelf Index collects, which services process your query, and how long anything is kept.',
};

function External({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 pt-12 sm:px-8">
      <h1 className="text-4xl font-bold sm:text-5xl">Privacy and data</h1>
      <p className="mt-5 text-[1.15rem] leading-snug">
        Shelf Index analyses public information about brands. It has no accounts, no ads, no payments and no tracking
        cookies. This page says plainly what happens to what you type.
      </p>

      <h2 className="shelf mt-12 pt-4 text-2xl font-bold">The short version</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5">
        <li>You type a brand name and a category. Nothing else is asked for.</li>
        <li>
          That text is sent to Google, Tavily and YouTube to run the audit.{' '}
          <strong>Google may use it to improve its products, and human reviewers at Google may read it.</strong>
        </li>
        <li>Please do not type personal, confidential or sensitive information into the form.</li>
        <li>Reports are stored for 7 days and then deleted automatically.</li>
      </ul>

      <h2 className="shelf mt-12 pt-4 text-2xl font-bold">Who processes your query</h2>

      <h3 className="mt-6 text-xl font-semibold">Google Gemini API, free tier</h3>
      <p className="mt-2">
        The brand name, the category and the public evidence gathered about the brand are sent to Google&apos;s Gemini
        API. This site uses the free tier of that API. Under Google&apos;s terms for unpaid use:
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>Google uses the content sent to the API, and the responses, to provide, improve and develop its products, services and machine-learning technologies.</li>
        <li>Human reviewers may read, annotate and process that content. Google says it disconnects the data from the account and API key before reviewers see it.</li>
        <li>Google asks that sensitive, confidential or personal information is not submitted to the free tier. That is why this site asks you for a brand name and nothing else.</li>
      </ul>
      <p className="mt-3">
        Web search is not used through Gemini here: the model answers from what it already knows. Read the{' '}
        <External href="https://ai.google.dev/gemini-api/terms">Gemini API Additional Terms of Service</External> and the{' '}
        <External href="https://policies.google.com/privacy">Google Privacy Policy</External>.
      </p>

      <h3 className="mt-8 text-xl font-semibold">Tavily</h3>
      <p className="mt-2">
        Search queries containing the brand name and category are sent to <External href="https://www.tavily.com">Tavily</External>,
        a web search service, to find public discussions, reviews and pages from the brand&apos;s own site. Reddit
        content appears only as it is surfaced by that search. Reddit, Instagram and TikTok are never accessed directly
        by this site.
      </p>

      <h3 className="mt-8 text-xl font-semibold">YouTube API Services</h3>
      <p className="mt-2">
        This site uses YouTube API Services to find public videos about a brand and to read a small sample of public
        comments on them. Comment authors&apos; names are not kept. By using this site you agree to be bound by the{' '}
        <External href="https://www.youtube.com/t/terms">YouTube Terms of Service</External>. Google&apos;s handling of data is
        described in the <External href="https://policies.google.com/privacy">Google Privacy Policy</External>.
      </p>

      <h3 className="mt-8 text-xl font-semibold">Vercel, on the free Hobby plan</h3>
      <p className="mt-2">This site is hosted by Vercel on its free Hobby plan. That has three consequences worth knowing:</p>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>
          The Hobby plan is for personal, non-commercial use. This is a non-commercial portfolio project: it shows no
          ads, takes no payments and sells nothing.
        </li>
        <li>
          Vercel processes every request to this site and keeps its own traffic logs, which can include your IP
          address, under its <External href="https://vercel.com/legal/privacy-notice">privacy notice</External>.
        </li>
        <li>
          Vercel&apos;s <External href="https://vercel.com/legal/terms">Terms of Service</External> say that for Hobby-plan
          projects it may use content submitted to its services to train AI models, and may share it with third parties
          for that purpose, unless the account owner opts out.
        </li>
      </ul>
      <p className="mt-3">Vercel may also suspend or remove free projects at any time, so this site comes with no promise of availability.</p>

      <h3 className="mt-8 text-xl font-semibold">Upstash</h3>
      <p className="mt-2">
        Finished reports, audit progress and usage counters are stored in an <External href="https://upstash.com">Upstash</External>{' '}
        Redis database on its free plan.
      </p>

      <h2 className="shelf mt-12 pt-4 text-2xl font-bold">What this site itself keeps</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5">
        <li>
          <strong>Reports:</strong> the brand, the category, Gemini&apos;s answers and excerpts of the public sources
          cited. Kept for 7 days, then deleted automatically. Unfinished audits are kept for about a day.
        </li>
        <li>
          <strong>A one-way hash of your IP address:</strong> kept for up to three days, only to enforce the limit of
          one new audit per visitor per day. The address itself is not stored by this application.
        </li>
        <li>
          <strong>Counters:</strong> how many audits ran today and how many search credits were used this month.
        </li>
        <li>
          <strong>Operational logs:</strong> event names, status codes and timings. API keys, request contents and API
          responses are never written to logs.
        </li>
      </ul>
      <p className="mt-3">There are no accounts, no analytics trackers and no advertising cookies.</p>

      <h2 className="shelf mt-12 pt-4 text-2xl font-bold">What an audit analyses</h2>
      <p className="mt-4">
        Only information that is already public: what an AI model says, public discussions and reviews, public YouTube
        comments and the brand&apos;s own website. Short quotes are shown with a link to their source. Scores are
        estimates from a sample, and interpretations written by an AI model are labeled as such.
      </p>

      <h2 className="shelf mt-12 pt-4 text-2xl font-bold">Questions or removal requests</h2>
      <p className="mt-4">
        If a report quotes something you wrote and you would like it removed before it expires, or you have a question
        about this page, contact{' '}
        <External href="https://www.linkedin.com/in/adyashachakra">Adya Chakra on LinkedIn</External>.
      </p>
    </div>
  );
}
