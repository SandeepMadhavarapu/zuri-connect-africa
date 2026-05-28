/**
 * Zuri Connect Africa — Network Status Banner
 *
 * Upgraded to use useConnectivity hook for reactive quality tracking.
 * Shows offline / poor / slow connection state + pending queue count.
 * Adapts label for low-data mode vs pure offline vs poor signal.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { WifiOff, Wifi, RefreshCw, AlertTriangle } from 'lucide-react';
import { useConnectivity } from '@/lib/network/connectivityHook';
import { CONNECTION_QUALITY } from '@/lib/offlineQueue';

const QUALITY_CONFIG = {
  [CONNECTION_QUALITY.OFFLINE]: {
    icon:   WifiOff,
    color:  'text-red-400',
    border: 'border-red-400/20',
    bg:     'bg-red-400/8',
    label:  'No connection',
    show:   true,
  },
  [CONNECTION_QUALITY.POOR]: {
    icon:   AlertTriangle,
    color:  'text-amber-400',
    border: 'border-amber-400/20',
    bg:     'bg-amber-400/8',
    label:  'Weak signal',
    show:   true,
  },
  [CONNECTION_QUALITY.FAIR]: {
    icon:   Wifi,
    color:  'text-amber-400',
    border: 'border-amber-400/15',
    bg:     'bg-amber-400/5',
    label:  'Slow connection',
    show:   false,
  },
  [CONNECTION_QUALITY.GOOD]: {
    show: false,
  },
};

export default function NetworkBanner() {
  const { quality, queueStatus, syncing, triggerSync, isOffline, isLowData } = useConnectivity();

  const config     = QUALITY_CONFIG[quality] || {};
  const hasPending = (queueStatus.pending || 0) + (queueStatus.failed || 0) > 0;
  const show       = config.show || (hasPending && quality !== CONNECTION_QUALITY.GOOD);

  if (!show) return null;

  const Icon  = config.icon  || WifiOff;
  const label = isLowData && !isOffline ? 'Low-data mode' : (syncing ? 'Syncing transactions…' : config.label || 'No connection');

  return (
    <AnimatePresence>
      <motion.div
        key="network-banner"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 32 }}
        className="overflow-hidden"
      >
        <div className={`w-full px-4 py-2.5 flex items-center gap-3 glass-card border-b ${config.border || 'border-red-400/20'} ${config.bg || 'bg-red-400/8'}`}>
          <Icon size={13} className={config.color || 'text-red-400'} />

          <div className="flex-1 min-w-0">
            <p className={`text-[11px] font-semibold ${config.color || 'text-red-400'}`}>{label}</p>
            {hasPending && (
              <p className="text-[10px] text-muted-foreground">
                {queueStatus.pending + (queueStatus.failed || 0)} transaction{(queueStatus.pending + (queueStatus.failed || 0)) !== 1 ? 's' : ''} queued
              </p>
            )}
          </div>

          {syncing ? (
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
              <RefreshCw size={12} className="text-primary" />
            </motion.div>
          ) : hasPending && !isOffline ? (
            <button
              onClick={triggerSync}
              className="text-[10px] text-primary font-semibold px-2 py-1 rounded-lg bg-primary/10 border border-primary/20 shrink-0"
            >
              Sync
            </button>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}