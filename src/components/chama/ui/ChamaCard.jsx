import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Surface card for the Hesabu identity: warm green-black surface, a single
 * hairline "ledger rule" border, and a subtle hover-lift (translateY + shadow).
 *
 * Motion is disabled under prefers-reduced-motion via the `motion-reduce:`
 * variants, so the lift never animates for users who opt out.
 */
const ChamaCard = React.forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-2xl border border-hesabu-line bg-hesabu-surface text-hesabu-paper',
      'shadow-[0_1px_2px_rgba(0,0,0,0.45)]',
      'transition-[transform,box-shadow,background-color] duration-200 ease-out',
      'hover:-translate-y-0.5 hover:bg-hesabu-surface-2 hover:shadow-[0_12px_30px_rgba(0,0,0,0.5)]',
      'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
      className,
    )}
    {...props}
  >
    {children}
  </div>
));
ChamaCard.displayName = 'ChamaCard';

export default ChamaCard;
