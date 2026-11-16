import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="no-print mt-24 border-t border-rule bg-surface">
      <div className="ui mx-auto max-w-5xl px-5 py-10 text-[0.95rem] text-ink-soft sm:px-8">
        <p className="text-ink">
          Built by Adyasha Chakra.{' '}
          <a href="https://www.linkedin.com/in/adyashachakra" rel="noopener noreferrer" target="_blank">
            LinkedIn
          </a>{' '}
          and{' '}
          <a href="https://github.com/adyashachakra" rel="noopener noreferrer" target="_blank">
            GitHub
          </a>
          .
        </p>
        <p className="mt-3 max-w-3xl">
          Scores are estimates from a sample of public information, not verdicts. This is a free, non-commercial
          project: no ads, no accounts, no payments. Free quotas are limited, so only a few new audits can run each
          day.
        </p>
        <p className="mt-3 max-w-3xl">
          Video data comes from YouTube API Services. See <Link href="/privacy">Privacy and data</Link> for what is
          sent where.
        </p>
      </div>
    </footer>
  );
}
