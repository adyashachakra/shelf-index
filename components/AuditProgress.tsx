'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { JobSnapshot } from '@/lib/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: JobSnapshot }
  | { kind: 'missing' }
  | { kind: 'offline'; snapshot: JobSnapshot | null; gaveUp: boolean };

/**
 * Drives an audit: asks the server to run one stage, shows what happened, repeats.
 * All progress is saved on the server, so closing or refreshing this page only pauses the audit.
 */
export function AuditProgress({ id }: { id: string }) {
  const router = useRouter();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [countdown, setCountdown] = useState(0);
  const latest = useRef<JobSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function wait(seconds: number) {
      for (let remaining = Math.ceil(seconds); remaining > 0 && !cancelled; remaining -= 1) {
        setCountdown(remaining);
        await sleep(1000);
      }
      setCountdown(0);
    }

    async function run() {
      let failures = 0;
      while (!cancelled) {
        let snapshot: JobSnapshot | null = null;
        try {
          const response = await fetch(`/api/audits/${id}/advance`, { method: 'POST' });
          if (response.status === 404) {
            if (!cancelled) setView({ kind: 'missing' });
            return;
          }
          if (!response.ok) throw new Error('unavailable');
          snapshot = (await response.json()) as JobSnapshot;
          failures = 0;
        } catch {
          failures += 1;
          const gaveUp = failures >= 6;
          if (!cancelled) setView({ kind: 'offline', snapshot: latest.current, gaveUp });
          if (gaveUp) return;
          await wait(Math.min(20, 3 * failures));
          continue;
        }
        if (cancelled) return;
        latest.current = snapshot;
        setView({ kind: 'ready', snapshot });
        if (snapshot.status === 'complete') {
          router.replace(`/report/${id}`);
          return;
        }
        if (snapshot.status === 'failed') return;
        if (snapshot.waitSeconds && snapshot.waitSeconds > 0) await wait(snapshot.waitSeconds);
        else if (snapshot.busy) await sleep(2500);
        else await sleep(350);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  if (view.kind === 'loading') {
    return <p className="ui text-ink-soft">Starting the audit.</p>;
  }

  if (view.kind === 'missing') {
    return (
      <div className="shelf bg-surface p-6">
        <h1 className="text-2xl font-semibold">This audit was not found</h1>
        <p className="mt-3">It may have expired. Audits that are not finished are kept for about a day.</p>
        <p className="mt-4">
          <Link href="/">Start a new audit</Link>
        </p>
      </div>
    );
  }

  const snapshot = view.snapshot;
  if (!snapshot) {
    return (
      <p className="ui text-ink-soft">
        {view.kind === 'offline' && view.gaveUp
          ? 'The server is not responding. Reload this page to try again.'
          : 'Trying to reach the server.'}
      </p>
    );
  }

  const done = snapshot.stages.filter((s) => s.state === 'done').length;
  const total = snapshot.stages.length;

  return (
    <div>
      <p className="ui text-[0.95rem] text-ink-soft">{snapshot.categoryLabel}</p>
      <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Auditing {snapshot.brand}</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Each step is saved as it finishes. You can leave this page open; if you close it, the audit pauses and
        continues when this link is opened again.
      </p>

      <div className="ui mt-6" aria-live="polite">
        <p className="font-semibold">
          {snapshot.status === 'failed'
            ? 'The audit stopped'
            : snapshot.status === 'paused'
              ? 'Paused'
              : snapshot.status === 'complete'
                ? 'Finished. Opening the report.'
                : `Step ${Math.min(done + 1, total)} of ${total}`}
        </p>
        <div className="mt-2 h-2 w-full bg-rule" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="h-2 bg-ink transition-[width] duration-500" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      </div>

      {view.kind === 'offline' ? (
        <p className="ui mt-4 border-l-4 border-ink bg-surface px-4 py-3 text-[0.95rem]">
          {view.gaveUp
            ? 'The server is not responding, so this page has stopped trying. Reload the page to carry on. Progress so far is saved.'
            : `The server did not respond. Trying again${countdown > 0 ? ` in ${countdown}s` : ''}. Progress so far is saved.`}
        </p>
      ) : null}

      {snapshot.status === 'failed' ? (
        <div className="ui mt-4 border-l-4 border-ink bg-surface px-4 py-3">
          <p className="font-semibold">{snapshot.error ?? 'The audit could not be completed.'}</p>
          <p className="mt-2 text-[0.95rem]">
            <Link href="/">Back to the start</Link> or read the <Link href="/example">example report</Link>.
          </p>
        </div>
      ) : null}

      {snapshot.status !== 'failed' && snapshot.waitSeconds ? (
        <p className="ui mt-4 border-l-4 border-ink bg-surface px-4 py-3 text-[0.95rem]">
          {snapshot.waitReason ?? 'Waiting'}
          {countdown > 0 ? `. Continuing in ${countdown}s.` : '.'}
        </p>
      ) : null}

      <ol className="ui mt-8 border-t border-rule">
        {snapshot.stages.map((stage, index) => (
          <li key={stage.id} className="flex gap-4 border-b border-rule py-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-[0.8rem] font-bold ${
                stage.state === 'done' ? 'bg-ink text-surface' : stage.state === 'active' ? 'bg-mark text-ink' : 'border border-rule text-ink-faint'
              }`}
            >
              {stage.state === 'done' ? '✓' : index + 1}
            </span>
            <div className="min-w-0">
              <p className={stage.state === 'pending' ? 'text-ink-faint' : stage.state === 'active' ? 'font-semibold' : ''}>
                {stage.label}
                <span className="sr-only">
                  {stage.state === 'done' ? ' (done)' : stage.state === 'active' ? ' (in progress)' : ' (not started)'}
                </span>
              </p>
              {stage.note ? <p className="text-[0.9rem] text-ink-soft">{stage.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>

      {snapshot.warnings.length > 0 ? (
        <div className="ui mt-6 bg-surface p-4 text-[0.95rem]">
          <p className="font-semibold">Carrying on without some sources</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
            {snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
