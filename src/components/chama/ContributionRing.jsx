import * as React from 'react';
import { cn } from '@/lib/utils';
import usePrefersReducedMotion from '@/components/chama/usePrefersReducedMotion';

/**
 * Small SVG progress ring showing how many members have paid this cycle.
 *
 * Track is the hesabu hairline; the arc is emerald and animates from empty to
 * `paid / total` on mount via a stroke-dashoffset transition. Under
 * prefers-reduced-motion the arc is drawn at its final length immediately with
 * no transition. The centre shows `paid/total` in mono.
 */
const ContributionRing = React.forwardRef(
  ({ paid = 0, total = 0, size = 56, stroke = 5, className, ...props }, ref) => {
    const reduced = usePrefersReducedMotion();
    const safeTotal = Math.max(0, total);
    const pct = safeTotal > 0 ? Math.min(1, Math.max(0, paid / safeTotal)) : 0;

    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const targetOffset = circumference * (1 - pct);

    // Start empty (full offset), then flip to the target so the transition runs.
    const [offset, setOffset] = React.useState(
      reduced ? targetOffset : circumference,
    );

    React.useEffect(() => {
      if (reduced) {
        setOffset(targetOffset);
        return undefined;
      }
      setOffset(circumference);
      const id = requestAnimationFrame(() => setOffset(targetOffset));
      return () => cancelAnimationFrame(id);
    }, [reduced, targetOffset, circumference]);

    const complete = safeTotal > 0 && paid >= safeTotal;

    return (
      <div
        ref={ref}
        className={cn('relative shrink-0', className)}
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${paid} of ${safeTotal} members have contributed this cycle`}
        {...props}
      >
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--hesabu-line)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={complete ? 'var(--hesabu-brass)' : 'var(--hesabu-emerald)'}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{
              transition: reduced
                ? 'none'
                : 'stroke-dashoffset 1100ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[11px] font-semibold tabular-nums text-hesabu-paper">
            {paid}/{safeTotal}
          </span>
        </span>
      </div>
    );
  },
);
ContributionRing.displayName = 'ContributionRing';

export default ContributionRing;
