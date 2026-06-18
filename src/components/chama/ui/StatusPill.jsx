import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Obligation status badge for the Hesabu identity.
 *
 *   due             → muted (neutral, not yet actioned)
 *   pending_payment → brass (in flight, awaiting confirmation)
 *   settled         → emerald (confirmed, money in)
 *   waived          → muted (forgiven / written off)
 *   overdue         → danger (past due)
 *
 * Solid token colours only (no opacity modifiers) so it renders correctly with
 * the var()-based hesabu palette.
 */
const STATUS = {
  due: { label: 'Due', dot: 'bg-hesabu-muted', cls: 'text-hesabu-muted border-hesabu-line' },
  pending_payment: { label: 'Pending', dot: 'bg-hesabu-brass', cls: 'text-hesabu-brass border-hesabu-brass' },
  settled: { label: 'Settled', dot: 'bg-hesabu-emerald', cls: 'text-hesabu-emerald border-hesabu-emerald' },
  waived: { label: 'Waived', dot: 'bg-hesabu-muted', cls: 'text-hesabu-muted border-hesabu-line' },
  overdue: { label: 'Overdue', dot: 'bg-hesabu-danger', cls: 'text-hesabu-danger border-hesabu-danger' },
};

const StatusPill = React.forwardRef(
  ({ status = 'due', className, children, ...props }, ref) => {
    const s = STATUS[status] || STATUS.due;
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border bg-hesabu-surface',
          'px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
          s.cls,
          className,
        )}
        {...props}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden="true" />
        {children || s.label}
      </span>
    );
  },
);
StatusPill.displayName = 'StatusPill';

export default StatusPill;
