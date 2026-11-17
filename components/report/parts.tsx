import type { ReactNode } from 'react';
import type { ConfidenceLevel, EvidenceItem, Metric, MetricOrSkipped, Report } from '@/lib/types';

// Small building blocks shared by the report sections.

export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mt-16 scroll-mt-6">
      <h2 className="shelf pt-4 text-2xl font-bold sm:text-[1.75rem]">{title}</h2>
      {intro ? <p className="mt-3 max-w-3xl text-ink-soft">{intro}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

const CONFIDENCE_TEXT: Record<ConfidenceLevel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export function ConfidenceTag({ level }: { level: ConfidenceLevel }) {
  return <span className="ui inline-block border border-ink px-2 py-0.5 text-[0.8rem] font-semibold">{CONFIDENCE_TEXT[level]}</span>;
}

/** A score, or an explicit statement that there is no score. Never a placeholder number. */
export function MetricValue({ metric, size = 'md' }: { metric: MetricOrSkipped; size?: 'md' | 'lg' }) {
  if (metric.status === 'scored') {
    return <span className={`numeral ${size === 'lg' ? 'text-7xl sm:text-8xl' : 'text-2xl'}`}>{metric.score}</span>;
  }
  return (
    <span className={`ui font-semibold ${size === 'lg' ? 'text-xl' : 'text-[0.95rem]'}`}>
      {metric.status === 'insufficient' ? 'Insufficient data' : metric.status === 'not_recognised' ? 'Brand not recognised in this category.' : 'Not measured'}
    </span>
  );
}

export function metricReason(metric: MetricOrSkipped): string {
  return metric.status === 'scored' ? metric.confidenceReason : metric.reason;
}

export function isScored(metric: Metric | MetricOrSkipped): metric is Extract<Metric, { status: 'scored' }> {
  return metric.status === 'scored';
}

function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** An outbound source link. In the illustrative example, sources are shown as plain text. */
export function SourceLink({ url, children, illustrative }: { url?: string; children: ReactNode; illustrative?: boolean }) {
  const href = safeHref(url);
  if (!href || illustrative) return <span className="text-ink-soft">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

function refLabel(item: EvidenceItem): string {
  if (item.kind === 'youtube_comment') return 'YouTube comment';
  if (item.kind === 'youtube_video') return `YouTube: ${item.channel || 'video'}`;
  return item.domain;
}

/** The sources behind a statement, as a compact list of links. */
export function EvidenceRefs({ ids, report, label = 'Evidence' }: { ids: string[]; report: Report; label?: string }) {
  const byId = new Map(report.evidence.map((item) => [item.id, item]));
  const answerIds = new Set(report.answers.map((a) => a.id));
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  return (
    <p className="ui mt-2 text-[0.88rem] text-ink-soft">
      <span className="font-semibold text-ink">{label}: </span>
      {unique.map((id, index) => {
        const item = byId.get(id);
        let node: ReactNode;
        if (item) {
          node = (
            <SourceLink url={item.url} illustrative={report.illustrative}>
              {refLabel(item)}
            </SourceLink>
          );
        } else if (answerIds.has(id)) {
          node = <a href={`#answer-${id}`}>Gemini answer {id.replace('G', '')}</a>;
        } else if (id === 'GP') {
          node = <a href="#gemini-description">Gemini&apos;s description</a>;
        } else if (id === 'GS') {
          node = <a href="#signature-answer">Gemini&apos;s signature-claim answer</a>;
        } else {
          node = <span>{id}</span>;
        }
        return (
          <span key={id}>
            {index > 0 ? ', ' : ''}
            {node}
          </span>
        );
      })}
    </p>
  );
}

export function Quote({ text }: { text: string }) {
  return (
    <blockquote className="mt-2 text-[1.02rem] italic">
      <span className="mark">&ldquo;{text}&rdquo;</span>
    </blockquote>
  );
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}
