import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, ShieldAlert, ShieldCheck, X, ChevronRight, AlertTriangle } from 'lucide-react';
import PinPad from './PinPad';
import FaceID from '@/components/auth/FaceID';
import VoiceBiometric from '@/components/auth/VoiceBiometric';
import BiometricAuthGate from './BiometricAuthGate';
import { evaluateRisk, getRiskColor } from '@/lib/riskEngine';
import { getFailedAttempts } from '@/lib/security';
import { getEffectiveRiskLevel, getFraudAlertScenario } from '@/lib/demoMode';
import { isBiometricEnrolled } from '@/lib/biometricAuth';
import { useAuth } from '@/lib/AuthContext';
import { rotateSession } from '@/lib/sessionSecurity';
import { recordAuthFailure as recordAtoFailure, recordSensitiveAction } from '@/lib/atoDefense';
import { audit } from '@/lib/auditLogger';
import { issueStepUpChallenge } from '@/lib/deviceTrust';

// Map auth step name → display label
const STEP_LABELS = { pin: 'PIN', face: 'Face ID', voice: 'Voice' };
const STEP_ICONS  = { pin: '🔢', face: '👤', voice: '🎙' };

export default function AuthGate({
  type       = 'adaptive',   // 'pin' | 'face' | 'voice' | 'adaptive' | 'biometric'
  amount     = 0,
  recipient  = '',
  actionType = 'transfer',
  onSuccess,
  onFailure,
  onCancel,
}) {
  const { user } = useAuth();
  const [risk,        setRisk]        = useState(null);
  const [authSteps,   setAuthSteps]   = useState([]);
  const [stepIndex,   setStepIndex]   = useState(0);
  const [completed,   setCompleted]   = useState([]);
  const [fraudAlert,  setFraudAlert]  = useState(null);
  const [fraudAcked,  setFraudAcked]  = useState(false);
  const [showBiometricGate, setShowBiometricGate] = useState(false);

  // ── Evaluate risk on mount ─────────────────────────────────────────────
  useEffect(() => {
    const failedAttempts = getFailedAttempts();
    const rawRisk = evaluateRisk({
      amount,
      recipient,
      deviceTrusted: true,
      newRecipient:  false,
      unusualAmount: amount > 20000,
      failedAttempts,
      locationMismatch: false,
      actionType,
    });

    // Override requiredAuth based on effective risk level derived from score
    const score = rawRisk.factors?.length >= 3 ? 50 : rawRisk.factors?.length >= 1 ? 20 : 0;
    let requiredAuth;
    let riskLevel;
    
    // If biometric is enrolled and type is 'biometric', use it
    const hasBiometric = user?.email && isBiometricEnrolled(user.email);
    
    // Production auth ladder intentionally omits the local 'voice' step.
    // High-value step-up is anchored on the server-issued WebAuthn challenge
    // (see BiometricStepUpModal + paymentService.resumePaymentAfterStepUp);
    // the local PIN + Face ID pre-auth here is only a UX prelude. Voice
    // biometric remains available as a Labs/preview surface inside the
    // wallet transfer flow (and only when the client demo policy is relaxed).
    if (type === 'biometric' && hasBiometric) {
      requiredAuth = ['biometric'];
      riskLevel = 'LOW';
    } else if (score >= 50) {
      riskLevel = 'HIGH';
      requiredAuth = ['pin', 'face'];
    } else if (score >= 20) {
      riskLevel = 'MEDIUM';
      requiredAuth = ['pin', 'face'];
    } else {
      riskLevel = 'LOW';
      requiredAuth = ['pin'];
    }

    const effectiveDisplayLevel = getEffectiveRiskLevel(riskLevel);
    if (effectiveDisplayLevel === 'HIGH')        requiredAuth = ['pin', 'face'];
    else if (effectiveDisplayLevel === 'MEDIUM') requiredAuth = ['pin', 'face'];
    else if (type !== 'biometric')               requiredAuth = ['pin'];

    const effectiveRisk = { ...rawRisk, requiredAuth, riskLevel: effectiveDisplayLevel };
    setRisk(effectiveRisk);

    // Determine steps from type prop vs adaptive
    if (type === 'biometric' && hasBiometric) {
      setAuthSteps(['biometric']);
    } else if (type === 'adaptive') {
      setAuthSteps(effectiveRisk.requiredAuth);
    } else {
      setAuthSteps([type]);
    }

    // Issue a step-up challenge token (one-time, expires 5 min)
    issueStepUpChallenge(`${actionType}_${amount}`);
    audit.stepUpIssued(`${actionType} amount=${amount}`, user?.email);

    // Fraud alert injection (demo mode)
    const alert = getFraudAlertScenario();
    if (alert) setFraudAlert(alert);
  }, [type, amount, recipient, actionType, user?.email]);

  const currentStep = authSteps[stepIndex];

  const handleStepSuccess = () => {
    const newCompleted = [...completed, currentStep];
    setCompleted(newCompleted);
    audit.authSuccess(currentStep, user?.email);

    if (stepIndex + 1 >= authSteps.length) {
      // All steps passed — rotate session token and consume challenge
      rotateSession('stepup_complete');
      audit.stepUpPassed(user?.email);
      if (actionType) recordSensitiveAction(actionType);
      setTimeout(() => onSuccess?.(), 400);
    } else {
      setStepIndex(stepIndex + 1);
    }
  };

  const handleStepFailure = (reason) => {
    recordAtoFailure(currentStep);
    audit.authFailure(currentStep, user?.email);
    if (reason === 'locked') onFailure?.('locked');
  };

  const handleFallback = () => {
    // Jump back to PIN if mid-flow fallback
    const pinIdx = authSteps.indexOf('pin');
    if (pinIdx !== -1 && currentStep !== 'pin') {
      setStepIndex(pinIdx);
    } else if (currentStep === 'biometric') {
      // If biometric fails, fall back to PIN
      const pinIndex = authSteps.indexOf('pin');
      if (pinIndex !== -1) {
        setStepIndex(pinIndex);
      } else {
        // No PIN available, just show PIN as fallback
        setAuthSteps(['pin']);
        setStepIndex(0);
      }
    }
  };

  const handleBiometricSuccess = () => {
    handleStepSuccess();
    setShowBiometricGate(false);
  };

  const handleBiometricFallback = () => {
    setShowBiometricGate(false);
    handleFallback();
  };

  if (!risk) return null;

  const riskColor   = getRiskColor(risk.requiredAuth);
  const RiskIcon    = risk.riskLevel === 'HIGH' ? ShieldAlert : risk.riskLevel === 'MEDIUM' ? Shield : ShieldCheck;

  // ── Fraud alert gate ────────────────────────────────────────────────────
  if (fraudAlert && !fraudAcked) {
    return (
      <AuthSheet onCancel={onCancel}>
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-red-400/10 border border-red-400/30 flex items-center justify-center mb-4">
            <AlertTriangle size={28} className="text-red-400" />
          </div>
          <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 text-red-400`}>
            {fraudAlert.severity} Risk Alert
          </p>
          <h3 className="text-base font-bold text-foreground font-grotesk mb-2">{fraudAlert.title}</h3>
          <p className="text-[12px] text-muted-foreground mb-5 leading-relaxed">{fraudAlert.detail}</p>
          <button onClick={() => setFraudAcked(true)}
            className="w-full gradient-green rounded-2xl py-3.5 text-black font-bold text-sm mb-3">
            I Understand · Continue
          </button>
          <button onClick={onCancel} className="text-xs text-muted-foreground py-2">Cancel Transaction</button>
        </div>
      </AuthSheet>
    );
  }

  return (
    <AuthSheet onCancel={onCancel}>
      {/* Risk badge + step tracker */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <RiskIcon size={14} className={riskColor} />
          <span className={`text-[11px] font-bold uppercase tracking-wider ${riskColor}`}>
            {risk.riskLevel} Risk
          </span>
        </div>
        {/* Step pills */}
        <div className="flex items-center gap-1.5">
          {authSteps.map((step, i) => (
            <div key={step} className="flex items-center gap-1">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold transition-all ${
                completed.includes(step)
                  ? 'bg-primary text-black'
                  : i === stepIndex
                  ? 'bg-primary/20 border border-primary text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}>
                {completed.includes(step) ? '✓' : i + 1}
              </div>
              {i < authSteps.length - 1 && <ChevronRight size={9} className="text-muted-foreground/40" />}
            </div>
          ))}
        </div>
      </div>

      {/* Transaction context */}
      {(amount > 0 || recipient) && (
        <div className="glass-card rounded-2xl px-4 py-3 mb-5 flex items-center justify-between">
          <div>
            <p className="text-[10px] text-muted-foreground">Authorising payment to</p>
            <p className="text-sm font-bold text-foreground mt-0.5 truncate max-w-[160px]">{recipient || 'Unknown'}</p>
          </div>
          <p className="font-grotesk font-bold text-lg text-primary">KSh {Number(amount).toLocaleString()}</p>
        </div>
      )}

      {/* Step label */}
      <p className="text-[11px] text-muted-foreground text-center mb-4">
        Step {stepIndex + 1} of {authSteps.length} · {STEP_ICONS[currentStep]} {STEP_LABELS[currentStep] || currentStep}
      </p>

      {/* Auth step rendering */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep + stepIndex}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.22 }}
        >
          {currentStep === 'pin' && (
            <PinPad
              onSuccess={handleStepSuccess}
              onFailure={handleStepFailure}
              onForgot={() => {}}
              mode="verify"
            />
          )}
          {currentStep === 'face' && (
            <FaceID
              onSuccess={handleStepSuccess}
              onCancel={onCancel}
              onFallback={handleFallback}
            />
          )}
          {currentStep === 'voice' && (
            <VoiceBiometric
              amount={amount}
              recipient={recipient}
              onSuccess={handleStepSuccess}
              onCancel={onCancel}
              onFallback={handleFallback}
            />
          )}
          {currentStep === 'biometric' && (
            <div className="text-center">
              <p className="text-[11px] text-muted-foreground mb-4">
                🔒 WebAuthn Biometric Authentication
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Biometric auth gate (overlay) */}
      {currentStep === 'biometric' && (
        <BiometricAuthGate
          isOpen={true}
          userId={user?.email}
          transactionType={actionType}
          onSuccess={handleBiometricSuccess}
          onFallbackToPin={handleBiometricFallback}
        />
      )}
    </AuthSheet>
  );
}

// ── Modal sheet wrapper ────────────────────────────────────────────────────────
function AuthSheet({ children, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Sheet */}
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 380, damping: 38 }}
        className="relative w-full max-w-[430px] glass rounded-t-3xl px-5 pt-5 pb-10 z-10 overflow-y-auto"
        style={{ borderTop: '1px solid rgba(46,204,113,0.15)', maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle + close */}
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-1 rounded-full bg-muted mx-auto absolute left-1/2 -translate-x-1/2 top-3" />
          <div className="flex-1" />
          <button onClick={onCancel} className="w-7 h-7 rounded-full bg-white/6 flex items-center justify-center">
            <X size={13} className="text-muted-foreground" />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}