import { useEffect, useState, useCallback, useRef } from 'react';

/**
 * Safe async hook with automatic timeout, error handling, and loading state.
 * NEVER leaves the page in an infinite loading state.
 */
export function useAsyncSafe(asyncFn, deps = [], timeout = 8000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const execute = useCallback(async () => {
    if (!isMountedRef.current) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await Promise.race([
        (async () => asyncFn())(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Operation timeout (${timeout}ms)`)), timeout)
        ),
      ]);

      if (isMountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('[useAsyncSafe]', err);
        setError(err?.message || 'Unknown error');
        setData(null);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [asyncFn, timeout]);

  useEffect(() => {
    isMountedRef.current = true;
    execute();

    return () => {
      isMountedRef.current = false;
    };
  }, deps);

  return { data, loading, error, refetch: execute };
}

/**
 * Safe promise wrapper with timeout.
 */
export function promiseWithTimeout(promise, timeoutMs = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Safe array/object access.
 */
export function safeGet(obj, path, defaultValue = null) {
  try {
    return path.split('.').reduce((acc, part) => acc?.[part], obj) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Safe number conversion.
 */
export function safeNumber(val, defaultValue = 0) {
  const num = Number(val);
  return isNaN(num) ? defaultValue : num;
}