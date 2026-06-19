import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The single eyebrow / section-label style for the Hesabu surface.
 *
 * One treatment, used identically everywhere a small uppercase label appears
 * (TOTAL POOLED, TAMPER-EVIDENT LEDGER, YOUR CHAMAS, NEXT CONTRIBUTION, and the
 * in-card micro-caps like POOLED / PAID). Consolidating it here keeps the
 * colour, letter-spacing, size, and weight from drifting across files.
 *
 * `tick` opts a label into the section-header treatment: a short emerald accent
 * mark precedes the text. It's opt-in so the tiny in-card micro-caps stay clean.
 */
const Eyebrow = React.forwardRef(
  ({ as: Tag = 'p', tick = false, className, children, ...props }, ref) => (
    <Tag
      ref={ref}
      className={cn(
        'text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-paper/75',
        tick && 'flex items-center gap-2',
        className,
      )}
      {...props}
    >
      {tick && (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-0.5 shrink-0 rounded-full bg-hesabu-emerald"
        />
      )}
      {children}
    </Tag>
  ),
);
Eyebrow.displayName = 'Eyebrow';

export default Eyebrow;
