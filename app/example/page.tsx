import type { Metadata } from 'next';
import { ReportView } from '@/components/report/ReportView';
import { EXAMPLE_REPORT } from '@/lib/report/example-report';

export const metadata: Metadata = {
  title: 'Example report',
  description: 'An illustrative Shelf Index report for a fictional brand, showing every section of a real audit.',
};

// Rendered from bundled data: opening this page uses no API quota at all.
export default function ExamplePage() {
  return <ReportView report={EXAMPLE_REPORT} />;
}
