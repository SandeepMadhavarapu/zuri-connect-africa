import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * A faint, STATIC version of the hash-chain motif used as decoration — three
 * blocks locked by chain links, low opacity, no animation. It echoes the
 * signature ribbon so an empty screen still tells the product's story.
 */
function ChainMotif() {
  return (
    <svg
      width="200"
      height="44"
      viewBox="0 0 200 44"
      fill="none"
      aria-hidden="true"
      className="opacity-30"
    >
      {[8, 78, 148].map((x) => (
        <rect
          key={x}
          x={x}
          y="8"
          width="44"
          height="28"
          rx="8"
          stroke="var(--hesabu-line)"
          strokeWidth="1.5"
          fill="var(--hesabu-surface)"
        />
      ))}
      {[60, 130].map((x) => (
        <g key={x} transform={`translate(${x},0)`}>
          <line
            x1="-8"
            y1="22"
            x2="26"
            y2="22"
            stroke="var(--hesabu-emerald-dim)"
            strokeWidth="1.5"
          />
          <rect x="2" y="16" width="9" height="12" rx="4.5" stroke="var(--hesabu-brass)" strokeWidth="1.5" fill="var(--hesabu-ink)" />
          <rect x="7" y="16" width="9" height="12" rx="4.5" stroke="var(--hesabu-brass)" strokeWidth="1.5" fill="none" />
        </g>
      ))}
    </svg>
  );
}

/**
 * The empty state is an invitation to act, not a sad line of text: a brief
 * value proposition, the same two primary actions, and the faint chain motif.
 */
export default function EmptyState({ onCreate, onJoin }) {
  return (
    <div className="hesabu-elevated flex flex-col items-center rounded-3xl border border-hesabu-line bg-hesabu-surface px-6 py-12 text-center">
      <ChainMotif />

      <h2 className="mt-6 font-display text-2xl font-bold text-hesabu-paper">
        No chamas yet
      </h2>
      <p className="mt-2 max-w-xs text-sm text-hesabu-muted">
        Start a savings group your members can actually audit.
      </p>

      <div className="mt-7 flex w-full max-w-xs flex-col gap-3 sm:flex-row sm:justify-center">
        <Button
          onClick={onCreate}
          className="bg-hesabu-emerald font-semibold text-hesabu-ink shadow-[0_4px_14px_-4px_rgba(31,157,107,0.45)] transition-shadow hover:bg-hesabu-emerald-dim hover:shadow-[0_8px_24px_-6px_rgba(31,157,107,0.6)]"
        >
          Create a chama
        </Button>
        <Button
          variant="outline"
          onClick={onJoin}
          className="border-hesabu-line bg-hesabu-surface-2 font-medium text-hesabu-paper hover:border-hesabu-emerald hover:bg-hesabu-surface-2 hover:text-hesabu-paper"
        >
          Join with code
        </Button>
      </div>
    </div>
  );
}
