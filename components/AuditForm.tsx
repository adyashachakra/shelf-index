'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BRAND_MAX_LENGTH, CATEGORIES, CUSTOM_CATEGORY_MAX_LENGTH } from '@/lib/categories';
import type { StartResponse } from '@/lib/types';

export function AuditForm() {
  const router = useRouter();
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('skincare');
  const [customCategory, setCustomCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

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
        event.preventDefault();
        void submit();
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
            onChange={(event) => setBrand(event.target.value)}
            maxLength={BRAND_MAX_LENGTH}
            placeholder="A brand you want audited"
            autoComplete="off"
            required
          />
        </label>
        <label className="ui block text-[0.95rem] font-semibold">
          Category
          <select className={inputClass} name="category" value={category} onChange={(event) => setCategory(event.target.value)}>
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
            onChange={(event) => setCustomCategory(event.target.value)}
            maxLength={CUSTOM_CATEGORY_MAX_LENGTH}
            placeholder="For example: running shoes"
            autoComplete="off"
            required
          />
        </label>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="submit"
          disabled={busy}
          className="ui cursor-pointer bg-ink px-6 py-3 text-[1.05rem] font-semibold text-surface disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Starting the audit' : 'Run audit'}
        </button>
        <p className="ui text-[0.9rem] text-ink-soft">A new audit usually takes one to three minutes. A brand audited in the last 7 days opens instantly.</p>
      </div>

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
