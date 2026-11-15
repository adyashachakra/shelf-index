import Link from 'next/link';

export function SiteHeader() {
  return (
    <header className="no-print border-b border-rule bg-surface">
      <div className="ui mx-auto flex max-w-5xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 py-4 sm:px-8">
        <Link href="/" className="text-xl font-bold tracking-tight text-ink no-underline">
          Shelf Index
        </Link>
        <nav aria-label="Main" className="flex flex-wrap gap-x-6 gap-y-1 text-[0.95rem]">
          <Link href="/example">Example report</Link>
          <Link href="/#method">How it works</Link>
          <Link href="/privacy">Privacy and data</Link>
        </nav>
      </div>
    </header>
  );
}
