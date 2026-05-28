import { useState, useEffect } from 'react';
import RenderGuard from '@/components/system/RenderGuard';

export default function AISystemLoader({ name, loader, children, fallback }) {
  const [state, setState] = useState('loading');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    setState('loading');
    setError(null);

    try {
      Promise.race([
        loader(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), 8000)),
      ])
        .then(result => {
          if (isMounted) {
            setData(result);
            setState(result ? 'loaded' : 'empty');
          }
        })
        .catch(err => {
          if (isMounted) {
            console.error(`[AISystemLoader:${name}] Error:`, err?.message);
            setError(err?.message || 'Failed to load');
            setState('error');
          }
        });
    } catch (e) {
      if (isMounted) {
        console.error(`[AISystemLoader:${name}] Setup error:`, e);
        setError('Setup failed');
        setState('error');
      }
    }

    return () => { isMounted = false; };
  }, [name, loader]);

  if (state === 'loading') {
    return (
      <div className="glass-card rounded-2xl p-4 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-1/3 mb-3" />
        <div className="h-3 bg-white/5 rounded w-2/3" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="glass-card rounded-2xl p-4">
        <p className="text-sm text-muted-foreground">{error || `Unable to load ${name}`}</p>
      </div>
    );
  }

  if (state === 'empty') {
    return fallback || (
      <div className="glass-card rounded-2xl p-4">
        <p className="text-sm text-muted-foreground">No {name} data available</p>
      </div>
    );
  }

  return (
    <RenderGuard name={name}>
      {children(data)}
    </RenderGuard>
  );
}