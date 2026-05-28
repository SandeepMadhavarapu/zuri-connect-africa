/**
 * Zuri Connect Africa — Scam Shield Alert
 * Intercepts transactions with contextual fraud warnings.
 * Matches existing glass-card / dark design language exactly.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, ShieldAlert, ShieldOff, AlertTriangle,
  XCircle, CheckCircle2, Phone, ChevronRight
} from 'lucide-react';
import AuthGate from './AuthGate';

// ── Animation variants matching AuthGate.jsx ─────────────────────────────────

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const sheetVariants = {
  hidden: { y: '100%', opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  exit: { y: '100%', opacity: 0, transition: { duration: 0.22, ease: 'easeIn' } },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function SwahiliRow({ text }) {
  if (!text) return null;
  return (
    <div className="glass-card rounded-xl px-3 py-2.5 flex items-start gap-2 mt-2"
      style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
      <span className="text-base leading-none mt-0.5">🇰🇪</span>
      <p className="text-[11px] text-muted-foreground leading-relaxed italic">{text}</p>
    </div>
  );
}

function EducationCard({ tip }) {
  if (!tip) return null;
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5 mt-2">
      <Shield size={12} className="text-muted-foreground shrink-0 mt-0.5" />
      <p className="text-[11px] text-muted-foreground leading-relaxed">{tip}</p>
    </div>
  );
}

// ── Warning Modal (amber) ─────────────────────────────────────────────────────

function WarningModal({ analysis, onCancel, onProceed }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {/* Icon + title */}
      <div className="flex flex-col items-center pt-2 pb-1">
        <div className="w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-3">
          <AlertTriangle size={26} className="text-amber-400" />
        </div>
        <h3 className="text-base font-bold text-foreground font-grotesk text-center">
          {analysis.warningTitle}
        </h3>
      </div>

      {/* Message */}
      <p className="text-[13px] text-foreground/80 leading-relaxed text-center px-1">
        {analysis.warningMessage}
      </p>

      <SwahiliRow text={analysis.swahiliMessage} />

      {/* Recommendation */}
      {analysis.recommendation && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-400/6 border border-amber-400/15">
          <ChevronRight size={12} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300 leading-relaxed">{analysis.recommendation}</p>
        </div>
      )}

      <EducationCard tip={analysis.educationTip} />

      {/* Confirm checkbox */}
      <label className="flex items-start gap-2.5 glass-card rounded-xl px-3 py-2.5 cursor-pointer"
        style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div onClick={() => setConfirmed(c => !c)}
          className={`w-4 h-4 rounded-md border shrink-0 mt-0.5 flex items-center justify-center transition-all ${
            confirmed ? 'bg-primary border-primary' : 'border-white/20'
          }`}>
          {confirmed && <CheckCircle2 size={10} className="text-black" />}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed select-none">
          I have independently verified this recipient and confirm I am sending this money willingly.
        </p>
      </label>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel}
          className="flex-1 py-3 rounded-xl bg-white/5 border border-white/8 text-sm font-semibold text-muted-foreground">
          Cancel
        </button>
        <button
          disabled={!confirmed}
          onClick={onProceed}
          className="flex-1 py-3 rounded-xl bg-amber-400/15 border border-amber-400/25 text-sm font-semibold text-amber-300 disabled:opacity-30 transition-all">
          I've Verified — Continue
        </button>
      </div>
    </div>
  );
}

// ── Auth Escalation Modal (red-tinted) ────────────────────────────────────────

function AuthEscalationModal({ analysis, amount, recipientName, onCancel, onAuthSuccess }) {
  const [showAuth, setShowAuth] = useState(false);

  const authType = analysis.requiresVoiceAuth ? 'voice'
    : analysis.requiresFaceAuth ? 'face'
    : 'pin';

  if (showAuth) {
    return (
      <AuthGate
        type={authType}
        amount={amount}
        recipient={recipientName}
        actionType="send"
        onSuccess={onAuthSuccess}
        onFailure={() => setShowAuth(false)}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center pt-2 pb-1">
        <div className="w-14 h-14 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mb-3">
          <ShieldAlert size={26} className="text-red-400" />
        </div>
        <h3 className="text-base font-bold text-foreground font-grotesk text-center">
          {analysis.warningTitle || 'Additional Verification Required'}
        </h3>
      </div>

      <p className="text-[13px] text-foreground/80 leading-relaxed text-center px-1">
        {analysis.warningMessage}
      </p>

      <SwahiliRow text={analysis.swahiliMessage} />

      {analysis.recommendation && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-red-400/6 border border-red-400/15">
          <ChevronRight size={12} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-300 leading-relaxed">{analysis.recommendation}</p>
        </div>
      )}

      <EducationCard tip={analysis.educationTip} />

      {/* Auth required notice */}
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/8 border border-primary/15">
        <Shield size={12} className="text-primary shrink-0" />
        <p className="text-[11px] text-primary font-medium">
          {analysis.requiresVoiceAuth
            ? 'Voice biometric required to proceed'
            : analysis.requiresFaceAuth
              ? 'Face authentication required to proceed'
              : 'PIN verification required to proceed'}
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel}
          className="flex-1 py-3 rounded-xl bg-white/5 border border-white/8 text-sm font-semibold text-muted-foreground">
          Cancel Transaction
        </button>
        <button onClick={() => setShowAuth(true)}
          className="flex-1 py-3 rounded-xl bg-red-400/12 border border-red-400/20 text-sm font-semibold text-red-300">
          Verify Identity
        </button>
      </div>
    </div>
  );
}

// ── Blocked Modal (full block — no proceed button) ────────────────────────────

function BlockedModal({ analysis, onCancel, onReport }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center pt-2 pb-1">
        <div className="w-16 h-16 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mb-3">
          <ShieldOff size={30} className="text-red-400" />
        </div>
        <h3 className="text-xl font-bold text-foreground font-grotesk text-center">
          Transaction Paused
        </h3>
        <p className="text-[11px] text-red-400 font-semibold mt-1">Scam Shield Protection Active</p>
      </div>

      <p className="text-[13px] text-foreground/80 leading-relaxed text-center px-1">
        {analysis.warningMessage}
      </p>

      <SwahiliRow text={analysis.swahiliMessage} />

      {analysis.recommendation && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-red-400/8 border border-red-400/20">
          <XCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-300 leading-relaxed">{analysis.recommendation}</p>
        </div>
      )}

      <EducationCard tip={analysis.educationTip} />

      {/* Triggered signals (natural language only) */}
      {analysis.triggeredSignals?.length > 0 && (
        <div className="glass-card rounded-xl px-3 py-2.5" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1.5">Why this was flagged</p>
          {analysis.triggeredSignals.slice(0, 4).map((sig, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5">
              <div className="w-1 h-1 rounded-full bg-red-400/60 shrink-0 mt-1.5" />
              <p className="text-[11px] text-muted-foreground">{sig}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onReport}
          className="flex-1 py-3 rounded-xl bg-red-400/10 border border-red-400/20 text-sm font-semibold text-red-400 flex items-center justify-center gap-1.5">
          <Phone size={13} /> Report Number
        </button>
        <button onClick={onCancel}
          className="flex-1 py-3 rounded-xl bg-white/5 border border-white/8 text-sm font-semibold text-muted-foreground">
          Cancel Transaction
        </button>
      </div>

      <p className="text-center text-[10px] text-muted-foreground/50 pb-1">
        If you believe this is an error, contact Safaricom Support on 100.
      </p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ScamShieldAlert({
  analysis,
  amount,
  recipientName,
  onCancel,
  onProceed,
  onAuthSuccess,
}) {
  const handleReport = () => {
    // Could wire to a reporting endpoint — for now close with cancel
    onCancel();
  };

  const renderInner = () => {
    if (analysis.shouldBlock) {
      return (
        <BlockedModal
          analysis={analysis}
          onCancel={onCancel}
          onReport={handleReport}
        />
      );
    }
    if (analysis.requiresPin || analysis.requiresFaceAuth || analysis.requiresVoiceAuth) {
      return (
        <AuthEscalationModal
          analysis={analysis}
          amount={amount}
          recipientName={recipientName}
          onCancel={onCancel}
          onAuthSuccess={onAuthSuccess}
        />
      );
    }
    return (
      <WarningModal
        analysis={analysis}
        onCancel={onCancel}
        onProceed={onProceed}
      />
    );
  };

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        variants={backdropVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
        onClick={analysis.shouldBlock ? undefined : onCancel}
      />

      {/* Sheet */}
      <motion.div
        variants={sheetVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="fixed bottom-0 left-0 right-0 z-50 max-w-[430px] mx-auto"
      >
        <div className="glass rounded-t-3xl px-4 pt-3 pb-8"
          style={{ border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none' }}>
          {/* Drag handle */}
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />
          {renderInner()}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}