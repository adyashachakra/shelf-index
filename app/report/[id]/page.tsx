import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ReportView } from '@/components/report/ReportView';
import { getSnapshot } from '@/lib/audit/pipeline';
import { loadReport } from '@/lib/cache/reports';
import type { Report } from '@/lib/types';
import { isValidAuditId } from '@/lib/validation/input';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Brand audit report', robots: { index: false } };

type Loaded = { kind: 'report'; report: Report } | { kind: 'running' } | { kind: 'missing' } | { kind: 'unavailable' };

async function load(id: string): Promise<Loaded> {
  try {
    const report = await loadReport(id);
    if (report) return { kind: 'report', report };
    const snapshot = await getSnapshot(id);
    if (snapshot && snapshot.status !== 'complete') return { kind: 'running' };
    return { kind: 'missing' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidAuditId(id)) notFound();
  const loaded = await load(id);
  if (loaded.kind === 'running') redirect(`/audit/${id}`);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'unavailable') {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 pt-12 sm:px-8">
        <h1 className="text-3xl font-bold">The report store is not reachable right now</h1>
        <p className="mt-3">Please try again in a minute. Nothing has been lost.</p>
        <p className="mt-4">
          <Link href="/">Back to the start</Link>
        </p>
      </div>
    );
  }
  return <ReportView report={loaded.report} />;
}
