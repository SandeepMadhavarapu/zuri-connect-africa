import * as React from 'react';

/**
 * Returns true when the user has requested reduced motion. Mirrors the
 * matchMedia guard already used in CountUp, but reactive: it updates if the
 * preference changes while mounted. SSR-safe (defaults to false).
 *
 * Animated Hesabu components use this to render their final state instantly
 * instead of tweening / drawing.
 */
export default function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const getInitial = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches;

  const [reduced, setReduced] = React.useState(getInitial);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia(query);
    const onChange = (e) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
