import * as React from 'react';
import { cn } from '@/lib/utils';
import CountUp from '@/components/chama/ui/CountUp';
import { formatKesFromCents } from '@/lib/branding/hesabu';

/**
 * The thesis of the screen: the pooled total across all of the user's chamas,
 * presented as a full-width treasury band. A soft emerald radial glow sits
 * behind the figure for depth (not a 3D effect). The number animates up via
 * CountUp (already reduced-motion-safe) and a small brass affordance hints at
 * the tamper-evidence the product is built on.
 */
export default function TreasuryHero({ totalCents = 0, chamaCount = 0, memberCount = 0, className }) {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-3xl border border-hesabu-line bg-hesabu-surface',
        'px-6 py-8',
        className,
      )}
    >
      {/* Soft radial emerald glow — depth/presence behind the number. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 18% 0%, rgba(31,157,107,0.22), rgba(31,157,107,0) 60%)',
        }}
      />

      <div className="relative">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-muted">
          Total pooled
        </p>

        <p className="mt-2 font-display font-bold leading-none text-hesabu-emerald">
          <CountUp
            value={totalCents}
            duration={1100}
            format={(n) => formatKesFromCents(Math.round(n))}
            className="font-mono text-[clamp(2.25rem,11vw,3.5rem)] tabular-nums tracking-tight"
          />
        </p>

        <p className="mt-3 text-sm text-hesabu-muted">
          across {chamaCount} {chamaCount === 1 ? 'chama' : 'chamas'} · {memberCount} members
        </p>

        <div className="mt-4 inline-flex items-center gap-1.5">
          <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true">
            <path
              d="M6.5 1 11.5 3v3.5c0 3-2.1 5.2-5 6.4C3.6 11.7 1.5 9.5 1.5 6.5V3L6.5 1Z"
              stroke="var(--hesabu-brass)"
              strokeWidth="1.2"
              fill="none"
              strokeLinejoin="round"
            />
            <path
              d="m4.4 7 1.6 1.6L9 5.4"
              stroke="var(--hesabu-brass)"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-mono text-[11px] uppercase tracking-wide text-hesabu-brass">
            Ledger verified
          </span>
        </div>
      </div>
    </section>
  );
}
