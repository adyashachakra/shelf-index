import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuditProgress } from '@/components/AuditProgress';
import { isValidAuditId } from '@/lib/validation/input';

export const metadata: Metadata = { title: 'Audit in progress', robots: { index: false } };

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidAuditId(id)) notFound();
  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 pt-12 sm:px-8">
      <AuditProgress id={id} />
    </div>
  );
}
