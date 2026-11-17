'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BRAND_MAX_LENGTH, CATEGORIES, CUSTOM_CATEGORY_MAX_LENGTH } from '@/lib/categories';
import { reviewAuditDetails } from '@/lib/form-review';
import type { StartResponse } from '@/lib/types';

export function AuditForm() {
  const router = useRouter();
  const [brand, setBrand] = useState('');
  // No category is preselected: the visitor chooses one, so an audit is never run in a category by default.
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  // The audit starts only from the review step below, by a button that is not the form's submit button.
  const [reviewing, setReviewing] = useState(false);
  const changeButton = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  // Opening the review step moves focus to "Change details", so pressing Return there goes back rather than starting.
  useEffect(() => {
    if (reviewing) changeButton.current?.focus();
  }, [reviewing]);

  const details = reviewAuditDetails({ brand, category, customCategory });
  const categoryName = details.ok ? details.categoryName : '';

  function review() {
    if (busy) return;
    if (!details.ok) {
      setMessage(details.message);
      return;
    }
    setMessage(null);
    setReviewing(true);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setLimitReached(false);
    try {
      const response = await fetch('/api/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand, category, customCategory }),
      });
      const result = (await response.json()) as StartResponse;
      if (result.status === 'error') {
        setMessage(result.message);
        setLimitReached(['daily_limit', 'visitor_limit', 'monthly_limit', 'gemini_quota'].includes(result.code));
        setBusy(false);
        return;
      }
      // A cached audit opens as a finished report; a new or running one opens its progress page.
      router.push(result.status === 'cached' ? `/report/${result.id}` : `/audit/${result.id}`);
    } catch {
      setMessage('The audit could not be started. Check your connection and try again.');
      setBusy(false);
    }
  }

  const inputClass =
    'ui mt-1 block w-full rounded-none border-2 border-ink bg-surface px-3 py-2.5 text-[1.05rem] text-ink placeholder:text-ink-faint';

  return (
    <form
      className="shelf bg-surface p-5 sm:p-7"
      onSubmit={(event) => {
        // Return, or the button below, only opens the review step. It never starts an audit.
        event.preventDefault();
        review();
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="ui block text-[0.95rem] font-semibold">
          Brand name
          <input
            className={inputClass}
            name="brand"
            type="text"
            value={brand}
            disabled={reviewing}
            onChange={(event) => setBrand(event.target.value)}
            maxLength={BRAND_MAX_LENGTH}
            placeholder="A brand you want audited"
            autoComplete="off"
            required
          />
        </label>
        <label className="ui block text-[0.95rem] font-semibold">
          Category
          <select className={inputClass} name="category" value={category} disabled={reviewing} required onChange={(event) => setCategory(event.target.value)}>
            <option value="" disabled>
              Choose a category
            </option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {category === 'other' ? (
        <label className="ui mt-5 block text-[0.95rem] font-semibold">
          Describe the category
          <input
            className={inputClass}
            name="customCategory"
            type="text"
            value={customCategory}
            disabled={reviewing}
            onChange={(event) => setCustomCategory(event.target.value)}
            maxLength={CUSTOM_CATEGORY_MAX_LENGTH}
            placeholder="For example: running shoes"
            autoComplete="off"
            required
          />
        </label>
      ) : null}

      {reviewing ? (
        <div className="mt-6 border-2 border-ink bg-paper p-4 sm:p-5" role="group" aria-label="Check the audit details">
          <p className="ui text-[0.95rem] text-ink-soft">Check before starting</p>
          <p className="mt-2 text-[1.2rem] leading-snug">
            Audit <span className="font-bold">{brand.trim()}</span> as a brand in the category{' '}
            <span className="font-bold">{categoryName}</span>?
          </p>
          <p className="ui mt-2 text-[0.9rem] text-ink-soft">
            Nothing has been used yet. Changing the brand or the category here does not use one of the free daily audits or any
            search quota. The audit begins only when you press &ldquo;Start audit&rdquo;.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button
              type="button"
              ref={changeButton}
              disabled={busy}
              onClick={() => {
                setReviewing(false);
                setMessage(null);
              }}
              className="ui cursor-pointer border-2 border-ink bg-surface px-5 py-2.5 text-[1rem] font-semibold text-ink disabled:cursor-wait disabled:opacity-60"
            >
              Change brand or category
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="ui cursor-pointer bg-ink px-6 py-3 text-[1.05rem] font-semibold text-surface disabled:cursor-wait disabled:opacity-60"
            >
              {busy ? 'Starting the audit' : 'Start audit'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <button type="submit" className="ui cursor-pointer bg-ink px-6 py-3 text-[1.05rem] font-semibold text-surface">
            Review audit
          </button>
          <p className="ui text-[0.9rem] text-ink-soft">
            You will check the brand and category before anything starts. A new audit then usually takes one to three minutes. A brand audited in the
            last 7 days opens instantly.
          </p>
        </div>
      )}

      <div aria-live="polite">
        {message ? (
          <div className="ui mt-5 border-l-4 border-ink bg-paper px-4 py-3 text-[0.98rem]">
            <p className="font-semibold">{message}</p>
            {limitReached ? (
              <p className="mt-1 text-ink-soft">
                Free quotas keep this tool at $0 to run, so new audits are limited. You can still read the{' '}
                <Link href="/example">example report</Link>.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}
