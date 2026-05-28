/**
 * Zuri Connect Africa — useConnectivity React hook
 *
 * Single source of truth for network state across all components.
 * Combines:
 *   - navigator.onLine
 *   - Network Information API
 *   - Live RTT probe
 *   - Offline queue status
 *   - Low-data mode detection
 *
 * Usage:
 *   const { quality, isOffline, isLowData, queueStatus, retry } = useConnectivity();
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  detectConnectionQuality,
  detectConnectionQualityAsync,
  getQueueStatus,
  syncPendingActions,
  isLowDataMode,
  startConnectivityMonitor,
  ACTION_PRIORITY,
  CONNECTION_QUALITY,
} from '@/lib/offlineQueue';

export function useConnectivity() {
  const [quality,     setQuality]     = useState(() => detectConnectionQuality());
  const [queueStatus, setQueueStatus] = useState(() => getQueueStatus());
  const [syncing,     setSyncing]     = useState(false);
  const [lastSyncAt,  setLastSyncAt]  = useState(null);
  const mountedRef = useRef(true);

  const refreshStatus = useCallback(() => {
    if (!mountedRef.current) return;
    setQueueStatus(getQueueStatus());
  }, []);

  const triggerSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // Manual queue sync follows the same safety rule as auto-reconnect:
      // financial drafts require fresh server step-up from their payment UI.
      await syncPendingActions({ maxPriority: ACTION_PRIORITY.ACCOUNT });
      if (mountedRef.current) {
        setLastSyncAt(Date.now());
        refreshStatus();
      }
    } finally {
      if (mountedRef.current) setSyncing(false);
    }
  }, [syncing, refreshStatus]);

  useEffect(() => {
    mountedRef.current = true;

    // Async quality probe on mount
    detectConnectionQualityAsync().then(q => {
      if (mountedRef.current) setQuality(q);
    });

    // Adaptive monitor
    const stopMonitor = startConnectivityMonitor((q) => {
      if (mountedRef.current) setQuality(q);
    });

    // Queue status refresh
    const statusInterval = setInterval(refreshStatus, 4000);

    // Browser events
    const onOnline  = () => { setQuality(detectConnectionQuality()); refreshStatus(); };
    const onOffline = () => { setQuality(CONNECTION_QUALITY.OFFLINE); refreshStatus(); };
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      mountedRef.current = false;
      stopMonitor();
      clearInterval(statusInterval);
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshStatus]);

  return {
    quality,
    isOffline:      quality === CONNECTION_QUALITY.OFFLINE,
    isPoor:         quality === CONNECTION_QUALITY.POOR,
    isFair:         quality === CONNECTION_QUALITY.FAIR,
    isGood:         quality === CONNECTION_QUALITY.GOOD,
    isLowData:      isLowDataMode(),
    queueStatus,
    syncing,
    lastSyncAt,
    triggerSync,
    CONNECTION_QUALITY,
  };
}
