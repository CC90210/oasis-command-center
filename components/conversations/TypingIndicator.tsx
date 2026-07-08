/**
 * TypingIndicator — three-dot bounce, left-aligned like an inbound bubble.
 * Not wired to any live signal in Phase 1 (no typing-presence channel yet);
 * exported now so ThreadPane/MessageList have a stable slot to render it
 * from once realtime presence lands (Phase 3).
 */
export function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-2xl rounded-bl-sm border border-bg-border bg-bg-elev/60 px-3.5 py-2.5 flex items-center gap-1.5">
        {label && <span className="text-[10px] text-fg-dim mr-1">{label}</span>}
        <span className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-fg-dim animate-pulse-slow"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
