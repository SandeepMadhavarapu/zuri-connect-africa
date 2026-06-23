import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Wifi, RefreshCw, ShieldAlert, AlertTriangle, Calendar,
  TrendingUp, Undo2, ShieldCheck, X, CheckCircle2, ChevronRight,
} from 'lucide-react';
import { getActionConfig, executeAction } from '@/lib/ai/aiActions';

const ICON_MAP = {
  Wifi, RefreshCw, ShieldAlert, AlertTriangle, Calendar,
  TrendingUp, Undo2, ShieldCheck,
};

export default function AIActionModal({ actionType, params = {}, proposal = null, userId, onClose, onConfirmed }) {
  const navigate = useNavigate();
  const [state, setState] = useState('confirm'); // confirm | executing | done | error
  const [result, setResult] = useState(null);

  const config = getActionConfig(actionType);
  if (!config) {
    return (
      <div className="hesabu-theme fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="hesabu-card rounded-2xl p-4 text-center max-w-sm">
          <p className="text-sm text-hesabu-muted">Action configuration not found</p>
          <button onClick={onClose} className="text-xs text-hesabu-emerald mt-3 font-medium">Close</button>
        </div>
      </div>
    );
  }

  const Icon = ICON_MAP[config.icon] || ShieldCheck;

  const handleConfirm = async () => {
    setState('executing');
    try {
      const res = await Promise.race([
        executeAction(actionType, params, userId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Action timeout')), 10000)),
      ]);
      const safeRes = res && typeof res === 'object' ? res : { success: false, message: 'No response' };
      setResult(safeRes);
      setState(safeRes.success ? 'done' : 'error');
    } catch (e) {
      console.error('[AIActionModal] Execute error:', e);
      setResult({ success: false, message: e?.message || 'Action failed' });
      setState('error');
    }
  };

  const handleDone = () => {
    try {
      onConfirmed?.();
      if (result?.path) navigate(result.path);
    } catch (e) {
      console.error('[AIActionModal] Done handler error:', e);
    } finally {
      onClose?.();
    }
  };

  return (
    <div className="hesabu-theme fixed inset-0 z-50 flex items-end justify-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />

      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
        className="relative w-full max-w-[430px] bg-hesabu-surface rounded-t-3xl px-5 pt-5 pb-10 z-10"
        style={{ borderTop: '1px solid rgba(31,157,107,0.30)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 rounded-full bg-hesabu-line absolute left-1/2 -translate-x-1/2 top-3" />

        {/* Close */}
        <div className="flex justify-end mb-4">
          <button onClick={onClose} className="w-7 h-7 rounded-full bg-hesabu-surface-2 flex items-center justify-center">
            <X size={13} className="text-hesabu-muted" />
          </button>
        </div>

        <AnimatePresence mode="wait">
          {state === 'confirm' && (
            <motion.div key="confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="w-14 h-14 rounded-2xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center mb-4 mx-auto">
                <Icon size={24} className="text-hesabu-emerald" />
              </div>
              <h3 className="text-base font-bold text-hesabu-paper text-center font-grotesk mb-1">{config.label}</h3>
              <p className="text-[12px] text-hesabu-muted text-center mb-6 leading-relaxed">{config.description}</p>

              <div className="hesabu-card rounded-xl px-4 py-3 mb-5">
                <p className="text-[11px] text-hesabu-muted text-center">
                  This is an AI <span className="text-hesabu-paper font-semibold">proposal</span>. It will be logged to
                  your audit trail. No money moves from this screen — payments still require the normal secure flow
                  (biometric / PIN step-up).
                </p>
                {proposal && (
                  <div className="mt-3 space-y-1 text-[11px] text-hesabu-muted">
                    {proposal.amount && <p>Amount: KSh {Number(proposal.amount).toLocaleString()}</p>}
                    {proposal.recipient && <p>Recipient: {proposal.recipient}</p>}
                    {proposal.requires_step_up && <p>Verification will be required before completion.</p>}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleConfirm}
                aria-label={`Continue to ${config.label}`}
                className="w-full bg-hesabu-emerald/15 border border-hesabu-emerald/30 text-hesabu-emerald rounded-2xl py-3.5 font-bold text-sm mb-3 flex items-center justify-center gap-2"
              >
                Continue to {config.label}
                <ChevronRight size={15} />
              </button>
              <button onClick={onClose} className="w-full text-center text-[12px] text-hesabu-muted py-2">
                Cancel
              </button>
            </motion.div>
          )}

          {state === 'executing' && (
            <motion.div key="executing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center py-8">
              <div className="w-12 h-12 border-2 border-hesabu-emerald/30 border-t-hesabu-emerald rounded-full animate-spin mb-4" />
              <p className="text-[13px] text-hesabu-muted">Processing…</p>
            </motion.div>
          )}

          {state === 'done' && (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center py-6">
              <div className="w-16 h-16 rounded-full bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center mb-4">
                <CheckCircle2 size={28} className="text-hesabu-emerald" />
              </div>
              <h3 className="text-base font-bold text-hesabu-paper font-grotesk mb-1">Done</h3>
              <p className="text-[12px] text-hesabu-muted text-center mb-6">{result?.message || 'Action completed successfully'}</p>
              <button onClick={handleDone} className="bg-hesabu-emerald/15 border border-hesabu-emerald/30 text-hesabu-emerald rounded-2xl px-8 py-3 font-bold text-sm">
                {result?.path ? 'Continue' : 'Close'}
              </button>
            </motion.div>
          )}

          {state === 'error' && (
            <motion.div key="error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center py-6">
              <div className="w-12 h-12 rounded-full bg-hesabu-danger/15 border border-hesabu-danger/30 flex items-center justify-center mb-4">
                <AlertTriangle size={24} className="text-hesabu-danger" />
              </div>
              <h3 className="text-base font-bold text-hesabu-paper font-grotesk mb-1">Action Failed</h3>
              <p className="text-[12px] text-hesabu-muted text-center mb-6">{result?.message || 'Something went wrong'}</p>
              <button onClick={() => { setState('confirm'); setResult(null); }}
                className="text-sm text-hesabu-emerald font-medium">
                Try again
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
