import * as React from 'react';

/**
 * Animates a number from 0 up to `value` once on mount (easeOutCubic).
 * Under prefers-reduced-motion the value is rendered instantly with no tween.
 *
 * @param {number} value     target number
 * @param {number} duration  ms (default 900); <=0 renders instantly
 * @param {(n:number)=>React.ReactNode} [format]  custom formatter for the
 *        in-flight value; defaults to `Math.round(n).toLocaleString('en-KE')`
 */
const CountUp = React.forwardRef(
  ({ value = 0, duration = 900, format, className, ...props }, ref) => {
    const [display, setDisplay] = React.useState(0);
    const rafRef = React.useRef(0);

    React.useEffect(() => {
      const target = Number(value) || 0;
      const prefersReduced =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (prefersReduced || duration <= 0) {
        setDisplay(target);
        return undefined;
      }

      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        setDisplay(target * eased);
        if (t < 1) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setDisplay(target);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }, [value, duration]);

    const out = format
      ? format(display)
      : Math.round(display).toLocaleString('en-KE');

    return (
      <span ref={ref} className={className} {...props}>
        {out}
      </span>
    );
  },
);
CountUp.displayName = 'CountUp';

export default CountUp;
