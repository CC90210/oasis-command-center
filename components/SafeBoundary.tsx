"use client";

import { Component, type ReactNode } from "react";

/**
 * SafeBoundary — a per-card React error boundary so a single mis-
 * behaving client component doesn't blow up the whole page.
 *
 * Usage:
 *   <SafeBoundary label="Integration keys">
 *     <IntegrationKeysPanel ... />
 *   </SafeBoundary>
 *
 * When a child throws during render, the boundary catches it, logs to
 * the browser console (Vercel function logs already capture server-
 * side throws), and renders a small inline fallback so the rest of
 * the page keeps working. Operators see "X couldn't load" instead of
 * the full-page error.tsx screen.
 */

type Props = {
  label: string;
  children: ReactNode;
  /** Optional fallback override. Receives the error message. */
  fallback?: (error: string) => ReactNode;
};

type State = { error: Error | null };

export class SafeBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[SafeBoundary:${this.props.label}]`, error);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || "unknown error";
      if (this.props.fallback) return this.props.fallback(msg);
      return (
        <div className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-200">
          <div className="font-semibold mb-0.5">
            {this.props.label} couldn&apos;t load
          </div>
          <div className="font-mono text-[10.5px] text-amber-200/80 break-all">
            {msg}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
