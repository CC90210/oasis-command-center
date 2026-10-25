"use client";

// The Schedule's crash screen. It used to print a hardcoded weekly routine under "Your
// schedule is still available", which was never the viewer's real schedule and went stale
// the moment the routine changed. A crash screen must not show invented data: it says what
// happened and offers the retry.
export default function ScheduleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-2xl border border-amber-300/20 bg-[#090d15] p-6">
      <h1 className="text-2xl font-semibold text-white">Your schedule could not load</h1>
      <p className="mt-2 text-sm text-slate-400">The calendar hit an error while drawing. No schedule data was changed.</p>
      <button type="button" onClick={reset} className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Try again</button>
    </div>
  );
}
