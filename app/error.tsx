'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 pt-12 sm:px-8">
      <h1 className="text-3xl font-bold">This page could not be loaded</h1>
      <p className="mt-3">Something went wrong on our side. Your audit progress, if any, is saved.</p>
      <button type="button" onClick={() => reset()} className="ui mt-5 cursor-pointer bg-ink px-5 py-2.5 font-semibold text-surface">
        Try again
      </button>
    </div>
  );
}
