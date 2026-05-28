/**
 * Zuri Connect Africa — Offline Queue Indicator
 *
 * Compact floating badge that shows pending offline transactions.
 * Only renders when there are pending/failed items in the queue.
 * Tapping opens a detail sheet with retry controls.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CloudOff, RefreshCw, CheckCircle2, AlertCircle, Clock, X } from 'lucide-react';
import { useConnectivity } from '@/lib/network/connectivityHook';

const STATUS_CONFIG = {
  pending: { icon: Clock,         color: 'text-amber-400',  label: 'Pending'  },
  syncing: { icon: RefreshCw,     color: 'text-primary',    label: 'Syncing'  },
  synced:  { icon: CheckCircle2,  color: 'text-primary',    label: 'Synced'   },
  failed:  { icon: AlertCircle,   color: 'text-red-400',    label: 'Failed'   },
  dead:    { icon: AlertCircle,   color: 'text-red-400',    label: 'Dead'     },
};

export default function OfflineQueueIndicator() {
  const { queueStatus, syncing, triggerSync, isOffline, isPoor } = useConnectivity();
  const [expanded, setExpanded] = useState(false);

  const pendingCount = (queueStatus.pending || 0) + (queueStatus.failed || 0);

  return (
    <>
      {/* Floating badge — only visible when pending or syncing */}
      {(pendingCount > 0 || syncing) && (
        <motion.button
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        onClick={() => setExpanded(true)}
        className="fixed bottom-24 right-4 z-30 w-10 h-10 rounded-2xl glass-card border border-amber-400/25 flex items-center justify-center shadow-lg"
        style={{ boxShadow: '0 4px 24px rgba(240,165,0,0.12)' }}
      >
        {syncing ? (
          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
            <RefreshCw size={15} className="text-primary" />
          </motion.div>
        ) : (
          <CloudOff size={15} className="text-amber-400" />
        )}
        {pendingCount > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 text-black text-[9px] font-bold flex items-center justify-center">
            {pendingCount > 9 ? '9+' : pendingCount}
          </span>
        )}
      </motion.button>
      )}

      {/* Detail sheet */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center"
            onClick={() => setExpanded(false)}
          >
            <motion.div
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
              className="w-full max-w-[430px] glass-card rounded-t-3xl border border-white/8 p-5 pb-8"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-bold text-foreground font-grotesk">Offline Queue</p>
                  <p className="text-[11px] text-muted-foreground">{pendingCount} action{pendingCount !== 1 ? 's' : ''} awaiting sync</p>
                </div>
                <button onClick={() => setExpanded(false)} className="w-7 h-7 rounded-xl bg-white/6 flex items-center justify-center">
                  <X size={13} className="text-muted-foreground" />
                </button>
              </div>

              <div className="space-y-2 mb-4">
                {Object.entries(queueStatus).filter(([k]) => ['pending','syncing','failed','dead'].includes(k) && queueStatus[k] > 0).map(([k, v]) => {
                  const cfg = STATUS_CONFIG[k];
                  if (!cfg) return null;
                  const Icon = cfg.icon;
                  return (
                    <div key={k} className="flex items-center gap-3 glass-card rounded-xl px-3 py-2.5 border border-white/5">
                      <Icon size={13} className={cfg.color + (k === 'syncing' ? ' animate-spin' : '')} />
                      <span className="text-[12px] text-foreground flex-1">{cfg.label}</span>
                      <span className="text-[12px] font-bold text-foreground">{v}</span>
                    </div>
                  );
                })}
              </div>

              {!isOffline && !isPoor && (
                <button
                  onClick={triggerSync}
                  disabled={syncing}
                  className="w-full py-3 rounded-2xl gradient-green text-black text-sm font-bold disabled:opacity-40"
                >
                  {syncing ? 'Syncing…' : 'Sync Now'}
                </button>
              )}
              {(isOffline || isPoor) && (
                <p className="text-center text-[11px] text-muted-foreground">
                  {isOffline
                    ? 'No connection - non-financial actions sync on reconnect. Payments need fresh verification.'
                    : 'Connection is unstable - non-financial actions retry automatically. Payments need fresh verification.'}
                </p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
