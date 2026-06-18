import * as React from 'react';
import { cn } from '@/lib/utils';
import { formatKesFromCents } from '@/lib/branding/hesabu';

/**
 * <Money cents={123456} />            → KES 1,234.56 (emerald)
 * <Money cents={123456} settled />    → KES 1,234.56 (brass, confirmed)
 *
 * Renders a KES figure in JetBrains Mono with tabular numerals so columns of
 * money line up. Emerald by default (money / trust); brass only when `settled`.
 * Mono comes from the `.hesabu-theme .font-mono` scoped rule in index.css, so it
 * only applies inside the Hesabu subtree.
 */
const Money = React.forwardRef(
  ({ cents, settled = false, withSymbol = true, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'font-mono tabular-nums tracking-tight',
        settled ? 'text-hesabu-brass' : 'text-hesabu-emerald',
        className,
      )}
      {...props}
    >
      {formatKesFromCents(cents, { withSymbol })}
    </span>
  ),
);
Money.displayName = 'Money';

export default Money;
