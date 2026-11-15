import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 pt-12 sm:px-8">
      <h1 className="text-3xl font-bold">That page was not found</h1>
      <p className="mt-3">
        Reports are kept for 7 days, so an older link may have expired. You can run the audit again or read the example
        report.
      </p>
      <p className="mt-4">
        <Link href="/">Run an audit</Link> or <Link href="/example">read the example report</Link>.
      </p>
    </div>
  );
}
