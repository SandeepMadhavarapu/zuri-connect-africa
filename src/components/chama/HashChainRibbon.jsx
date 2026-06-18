import * as React from 'react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import Money from '@/components/chama/ui/Money';
import usePrefersReducedMotion from '@/components/chama/usePrefersReducedMotion';

/** "a3f97c2..." → "a3f9…7c2" */
function shortHash(hash) {
  const h = String(hash || '').replace(/^0x/, '');
  if (h.length <= 9) return h;
  return `${h.slice(0, 4)}…${h.slice(-3)}`;
}

const STEP = 320; // ms between successive blocks locking in

/**
 * The signature moment of the Hesabu home: the last few SETTLED contributions
 * rendered as blocks that are visually LOCKED together by chain-link
 * connectors. On mount the chain draws left-to-right and each link "snaps"
 * locked, staggered — a literal picture of the tamper-evident hash chain.
 *
 * Every animation is gated on prefers-reduced-motion: when the user opts out,
 * blocks and links render in their final state instantly with no draw.
 */
export default function HashChainRibbon({ blocks = [], className }) {
  const reduced = usePrefersReducedMotion();
  const animate = !reduced && blocks.length > 0;

  return (
    <section className={cn('space-y-3', className)}>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-muted">
          Tamper-evident ledger
        </p>
        <p className="mt-1 text-sm text-hesabu-muted">
          Each contribution is chained to the last — history can&apos;t be rewritten.
        </p>
      </div>

      {/* Negative margin + padding lets the row bleed to the screen edges and
          scroll on mobile without breaking the page layout at 360px. */}
      <div className="hcr-scroll -mx-5 overflow-x-auto px-5 pb-2">
        <ol className="flex w-max items-stretch">
          {blocks.map((b, i) => {
            const last = i === blocks.length - 1;
            const blockDelay = i * STEP;
            const drawDelay = i * STEP + 200;
            const lockDelay = i * STEP + 440;
            return (
              <li key={b.hash || i} className="flex items-stretch">
                {/* Contribution block */}
                <div
                  className={cn(
                    'flex w-[120px] shrink-0 flex-col items-center gap-2 rounded-2xl',
                    'border border-hesabu-line bg-hesabu-surface px-3 py-3 text-center',
                    'shadow-[0_1px_2px_rgba(0,0,0,0.45)]',
                    animate && 'hcr-block',
                  )}
                  style={animate ? { animationDelay: `${blockDelay}ms` } : undefined}
                >
                  <Avatar className="h-9 w-9">
                    <AvatarFallback className="bg-hesabu-surface-2 font-display text-sm font-semibold text-hesabu-paper">
                      {b.initial}
                    </AvatarFallback>
                  </Avatar>
                  <Money
                    cents={b.amountCents}
                    settled
                    withSymbol={false}
                    className="text-sm font-semibold"
                  />
                  <span className="font-mono text-[11px] tracking-tight text-hesabu-brass">
                    {shortHash(b.hash)}
                  </span>
                </div>

                {/* Connector — the chain link locking two blocks together */}
                {!last && (
                  <div
                    className="flex w-12 shrink-0 items-center justify-center self-center"
                    aria-hidden="true"
                  >
                    <svg width="48" height="28" viewBox="0 0 48 28" fill="none">
                      {/* drawn connecting line */}
                      <line
                        x1="2"
                        y1="14"
                        x2="46"
                        y2="14"
                        stroke="var(--hesabu-emerald-dim)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeDasharray="44"
                        strokeDashoffset={animate ? 44 : 0}
                        className={animate ? 'hcr-draw' : undefined}
                        style={animate ? { animationDelay: `${drawDelay}ms` } : undefined}
                      />
                      {/* interlocking chain-link glyph (the "lock") */}
                      <g
                        className={animate ? 'hcr-lock' : undefined}
                        style={
                          animate
                            ? { animationDelay: `${lockDelay}ms`, transformOrigin: '24px 14px' }
                            : undefined
                        }
                      >
                        <rect
                          x="16.5"
                          y="8"
                          width="13"
                          height="12"
                          rx="6"
                          stroke="var(--hesabu-brass)"
                          strokeWidth="2"
                          fill="var(--hesabu-ink)"
                        />
                        <rect
                          x="22.5"
                          y="8"
                          width="13"
                          height="12"
                          rx="6"
                          stroke="var(--hesabu-brass)"
                          strokeWidth="2"
                          fill="none"
                        />
                      </g>
                    </svg>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Scoped styles: keyframes + the locked-in animations. Hidden→final, with
          animation-fill-mode both so the start frame holds before the delay.
          Reduced-motion users never get the `hcr-*` classes (gated above), and
          the media query is a belt-and-braces reset. */}
      <style>{`
        .hcr-scroll { scrollbar-width: thin; scrollbar-color: var(--hesabu-line) transparent; }
        .hcr-scroll::-webkit-scrollbar { height: 6px; }
        .hcr-scroll::-webkit-scrollbar-thumb { background: var(--hesabu-line); border-radius: 9999px; }
        .hcr-scroll::-webkit-scrollbar-track { background: transparent; }

        @keyframes hcr-block-in {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes hcr-draw-in {
          to { stroke-dashoffset: 0; }
        }
        @keyframes hcr-lock-in {
          0%   { opacity: 0; transform: scale(0.5); }
          70%  { opacity: 1; transform: scale(1.14); }
          100% { opacity: 1; transform: scale(1); }
        }
        .hcr-block { opacity: 0; animation: hcr-block-in 460ms cubic-bezier(0.22,1,0.36,1) both; }
        .hcr-draw  { animation: hcr-draw-in 300ms ease-out both; }
        .hcr-lock  { opacity: 0; animation: hcr-lock-in 360ms cubic-bezier(0.34,1.56,0.64,1) both; }

        @media (prefers-reduced-motion: reduce) {
          .hcr-block, .hcr-draw, .hcr-lock { animation: none !important; opacity: 1 !important; transform: none !important; }
        }
      `}</style>
    </section>
  );
}
