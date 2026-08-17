"use client";

const fallback = `# Weekly schedule

## Monday – Friday
- 6:30 AM Wake up
- 7:00 AM Praying
- 7:30 AM Run
- 8:15 AM Abs
- 8:45 AM Breakfast
- 9:30 AM Eating
- 10:00 AM–5:00 PM Work
  - Client fulfillment
  - Internal systems
  - Agent training / R&D

## Shabbat · immutable
- Friday: sundown placeholder (6:00 PM) onward
- Saturday: through sundown placeholder (7:00 PM)`;

export default function ScheduleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-2xl border border-amber-300/20 bg-[#090d15] p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">Read-only fallback</p>
      <h1 className="mt-2 text-2xl font-semibold text-white">Your schedule is still available</h1>
      <p className="mt-2 text-sm text-slate-400">The interactive calendar could not render. No schedule data was changed.</p>
      <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-5 text-sm leading-7 text-slate-300">{fallback}</pre>
      <button type="button" onClick={reset} className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Try interactive view again</button>
    </div>
  );
}
