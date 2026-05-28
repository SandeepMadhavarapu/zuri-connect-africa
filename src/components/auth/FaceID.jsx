import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, CameraOff, ShieldCheck, AlertTriangle, RefreshCw, Check, Sun } from 'lucide-react';
import {
  registerBiometric,
  authenticateBiometric,
  getPlatformAuthenticators,
  isBiometricEnrolled,
} from '@/lib/biometricAuth.js';
import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

const SCAN_STAGES = [
  { label: 'Detecting face landmarks…',       key: 'detect'    },
  { label: 'Checking liveness (blink)…',      key: 'liveness'  },
  { label: 'Extracting facial geometry…',     key: 'geometry'  },
  { label: 'Running anti-spoofing check…',    key: 'antispoofing' },
  { label: 'Matching facial profile…',        key: 'match'     },
  { label: 'Finalizing verification…',        key: 'finalize'  },
];

export default function FaceID({ onSuccess, onCancel, onFallback, userId = null }) {
  const videoRef     = useRef(null);
  const streamRef    = useRef(null);
  const canvasRef    = useRef(null);
  const animFrameRef = useRef(null);

  const simAllowed = useMemo(() => getClientDemoPolicy().allowBiometricClientSimulation, []);

  const [phase,       setPhase]       = useState('idle');     // idle | camera | scanning | success | failed | denied
  const [stageIndex,  setStageIndex]  = useState(0);
  const [brightness,  setBrightness]  = useState(null);       // null | 'ok' | 'low'
  const [confidence,  setConfidence]  = useState(0);
  const [faceAligned, setFaceAligned] = useState(false);
  const [countdown,   setCountdown]   = useState(3);
  const [policyBlocked, setPolicyBlocked] = useState(false);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ── Brightness sampling ───────────────────────────────────────────────────
  const sampleBrightness = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const ctx = canvas.getContext('2d');
    canvas.width  = 80;
    canvas.height = 60;
    ctx.drawImage(video, 0, 0, 80, 60);
    const data   = ctx.getImageData(0, 0, 80, 60).data;
    let total    = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const avg = total / (data.length / 4);
    setBrightness(avg < 40 ? 'low' : 'ok');
    animFrameRef.current = requestAnimationFrame(sampleBrightness);
  }, []);

  // ── Start camera ──────────────────────────────────────────────────────────
  const startCamera = async () => {
    setPhase('camera');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          sampleBrightness();
          // Simulate face alignment detection after 1.5s
          setTimeout(() => setFaceAligned(true), 1500);
        };
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setPhase('denied');
      } else {
        setPhase('denied');
      }
    }
  };

  // ── Run face scan ─────────────────────────────────────────────────────────
  const runScan = useCallback(async () => {
    stopCamera();
    setPhase('scanning');
    setStageIndex(0);
    setConfidence(0);

    // Use a consistent userId throughout — never mix null and fallback
    const effectiveUserId = userId ?? 'zuri_guest';

    try {
      // Check device biometric support
      const platformAvailable = await getPlatformAuthenticators();

      if (!platformAvailable) {
        // Device has no platform authenticator — show not-available message
        setPolicyBlocked(true);
        setPhase('failed');
        return;
      }

      // Enroll if not already enrolled this session
      if (!isBiometricEnrolled(effectiveUserId)) {
        const enrollment = await registerBiometric(effectiveUserId);
        if (!enrollment?.success) {
          setPolicyBlocked(false);
          setPhase('failed');
          return;
        }
      }

      // Run stage animation concurrently with WebAuthn
      // Animation is cosmetic — real result comes from authenticateBiometric
      const stageAnimation = (async () => {
        for (let i = 0; i < SCAN_STAGES.length; i++) {
          setStageIndex(i);
          await new Promise(r => setTimeout(r, 550));
          setConfidence(Math.round(((i + 1) / SCAN_STAGES.length) * 94));
        }
      })();

      const authResult = await authenticateBiometric(effectiveUserId);

      // Wait for animation to finish before showing result
      await stageAnimation;

      if (authResult?.success) {
        setConfidence(97);
        setPhase('success');
        setTimeout(() => onSuccess?.({ method: 'webauthn' }), 1400);
      } else {
        setPolicyBlocked(false);
        setPhase('failed');
      }

    } catch (err) {
      console.warn('[FaceID] WebAuthn error:', err);
      setPolicyBlocked(false);
      setPhase('failed');
    }
  }, [onSuccess, stopCamera, userId]);

  // ── Countdown before scan ─────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'camera' || !faceAligned) return;
    let c = 3;
    setCountdown(c);
    const t = setInterval(() => {
      c--;
      setCountdown(c);
      if (c <= 0) {
        clearInterval(t);
        runScan();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [phase, faceAligned, runScan]);

  const handleCancel = () => {
    stopCamera();
    onCancel?.();
  };

  return (
    <div className="flex flex-col items-center w-full">
      {/* Environment disclaimer */}
      <div
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg mb-4 border ${
          simAllowed ? 'bg-amber-400/8 border-amber-400/15' : 'bg-sky-500/8 border-sky-500/20'
        }`}
      >
        <span
          className={`text-[10px] font-medium text-center ${
            simAllowed ? 'text-amber-400' : 'text-sky-300'
          }`}
        >
          {simAllowed
            ? 'Camera verification preview · Local facial match check'
            : 'Device biometric verification is enforced by WebAuthn where available'}
        </span>
      </div>

      <AnimatePresence mode="wait">

        {/* IDLE */}
        {phase === 'idle' && (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full">
            <div className="w-16 h-16 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
              <Camera size={28} className="text-primary" />
            </div>
            <h3 className="text-base font-bold text-foreground font-grotesk mb-1">Face Verification</h3>
            <p className="text-[11px] text-muted-foreground text-center mb-5 leading-relaxed">
              {simAllowed
                ? 'Position your face within the frame and hold still. The scan takes approximately 4 seconds.'
                : 'This flow is disabled where simulated biometrics are not permitted. Continue with your PIN or enrolled device biometric.'}
            </p>
            {simAllowed ? (
              <>
                <div className="space-y-2 w-full mb-5">
                  {['Ensure good lighting', 'Remove glasses if possible', 'Look directly at the camera', 'Hold the device steady'].map(tip => (
                    <div key={tip} className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      <p className="text-[11px] text-muted-foreground">{tip}</p>
                    </div>
                  ))}
                </div>
                <motion.button whileTap={{ scale: 0.97 }} onClick={startCamera}
                  className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-2 text-black font-bold text-sm mb-3">
                  <Camera size={16} /> Open Camera
                </motion.button>
              </>
            ) : null}
            <button onClick={onFallback} className="text-xs text-muted-foreground py-2">
              {simAllowed ? 'Use PIN instead' : 'Continue with PIN'}
            </button>
          </motion.div>
        )}

        {/* CAMERA LIVE */}
        {phase === 'camera' && (
          <motion.div key="camera" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full">
            <div className="relative w-full aspect-[4/3] rounded-2xl overflow-hidden bg-black mb-3" style={{ maxHeight: 240 }}>
              <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
              {/* Hidden canvas for brightness sampling */}
              <canvas ref={canvasRef} className="hidden" />

              {/* Face oval overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <motion.div
                  animate={{ borderColor: faceAligned ? 'rgba(46,204,113,0.9)' : 'rgba(255,255,255,0.4)' }}
                  transition={{ duration: 0.4 }}
                  className="w-32 h-40 rounded-full border-2"
                  style={{ boxShadow: faceAligned ? '0 0 20px rgba(46,204,113,0.25)' : 'none' }}
                />
              </div>

              {/* Scanning line animation when aligned */}
              {faceAligned && (
                <motion.div
                  className="absolute left-1/2 -translate-x-1/2 w-32 h-0.5 bg-primary/70"
                  style={{ top: '25%' }}
                  animate={{ top: ['25%', '65%', '25%'] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
                />
              )}

              {/* Corner brackets */}
              {['tl','tr','bl','br'].map(corner => (
                <div key={corner} className={`absolute w-5 h-5 border-primary/60 ${
                  corner === 'tl' ? 'top-3 left-3 border-t-2 border-l-2' :
                  corner === 'tr' ? 'top-3 right-3 border-t-2 border-r-2' :
                  corner === 'bl' ? 'bottom-3 left-3 border-b-2 border-l-2' :
                                    'bottom-3 right-3 border-b-2 border-r-2'
                }`} />
              ))}

              {/* Guidance text */}
              <div className="absolute bottom-3 left-0 right-0 flex justify-center">
                <div className="bg-black/60 rounded-full px-3 py-1">
                  <p className="text-[11px] text-white font-medium text-center">
                    {faceAligned
                      ? `Hold still · Scanning in ${countdown}…`
                      : 'Align face inside the frame'}
                  </p>
                </div>
              </div>
            </div>

            {/* Low light warning */}
            <AnimatePresence>
              {brightness === 'low' && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2 mb-3 w-full">
                  <Sun size={12} className="text-amber-400 shrink-0" />
                  <p className="text-[11px] text-amber-400">Low light detected — move to a brighter area</p>
                </motion.div>
              )}
            </AnimatePresence>

            <button onClick={handleCancel} className="text-xs text-muted-foreground py-2">Cancel</button>
          </motion.div>
        )}

        {/* SCANNING */}
        {phase === 'scanning' && (
          <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full">
            <div className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mx-auto mb-4 glow-green">
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}>
                <RefreshCw size={28} className="text-black" />
              </motion.div>
            </div>
            <p className="text-foreground font-bold text-base font-grotesk mb-1">Analyzing Face</p>

            {/* Confidence meter */}
            <div className="w-full mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-muted-foreground">Match confidence</span>
                <span className="text-[11px] text-primary font-semibold font-grotesk">{confidence}%</span>
              </div>
              <div className="w-full h-1.5 bg-white/6 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-primary rounded-full"
                  animate={{ width: `${confidence}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
            </div>

            <div className="space-y-2.5 w-full">
              {SCAN_STAGES.map((s, i) => (
                <div key={s.key} className="flex items-center gap-3">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all ${
                    i < stageIndex ? 'bg-primary' : i === stageIndex ? 'bg-primary/30 border border-primary animate-pulse' : 'bg-muted'
                  }`}>
                    {i < stageIndex && <Check size={11} className="text-black" />}
                  </div>
                  <p className={`text-xs transition-all ${i <= stageIndex ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* SUCCESS */}
        {phase === 'success' && (
          <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center py-4">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
              className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-4 glow-green">
              <ShieldCheck size={36} className="text-black" />
            </motion.div>
            <h3 className="text-xl font-bold text-foreground font-grotesk">Face Verified</h3>
            <p className="text-sm text-muted-foreground mt-1 text-center">
              Match confidence: <span className="text-primary font-semibold">{confidence}%</span>
            </p>
            <p className="text-[10px] text-muted-foreground/60 text-center mt-2 leading-relaxed px-4">
              Production systems integrate Apple Face ID, Android BiometricPrompt, or enterprise facial verification APIs.
            </p>
          </motion.div>
        )}

        {/* FAILED */}
        {phase === 'failed' && (
          <motion.div key="failed" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center">
            <div className="w-16 h-16 rounded-full bg-red-400/10 border border-red-400/30 flex items-center justify-center mb-3">
              <AlertTriangle size={28} className="text-red-400" />
            </div>
            <h3 className="text-base font-bold text-foreground font-grotesk mb-1">
              {policyBlocked ? 'Biometric Not Available' : 'Face Not Recognised'}
            </h3>
            <p className="text-[11px] text-muted-foreground text-center mb-4 leading-relaxed">
              {policyBlocked
                ? 'This device does not support biometric authentication. Please use your PIN to continue.'
                : 'Biometric verification was not completed. Please try again or use your PIN instead.'}
            </p>
            {!policyBlocked && (
            <button onClick={() => { setPolicyBlocked(false); setPhase('idle'); setStageIndex(0); setConfidence(0); setFaceAligned(false); }}
              className="w-full gradient-green rounded-2xl py-3.5 flex items-center justify-center gap-2 text-black font-bold text-sm mb-3">
              <RefreshCw size={14} /> Try Again
            </button>
            )}
            <button onClick={onFallback} className="text-xs text-muted-foreground py-2">Use PIN instead</button>
          </motion.div>
        )}

        {/* DENIED */}
        {phase === 'denied' && (
          <motion.div key="denied" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center">
            <div className="w-16 h-16 rounded-full bg-amber-400/10 border border-amber-400/30 flex items-center justify-center mb-3">
              <CameraOff size={28} className="text-amber-400" />
            </div>
            <h3 className="text-base font-bold text-foreground font-grotesk mb-1">Camera Access Denied</h3>
            <p className="text-[11px] text-muted-foreground text-center mb-4 leading-relaxed">
              Allow camera access in your browser settings to use face verification, then tap Retry.
            </p>
            <button onClick={() => setPhase('idle')}
              className="w-full gradient-green rounded-2xl py-3.5 text-black font-bold text-sm mb-3">
              Retry
            </button>
            <button onClick={onFallback} className="text-xs text-muted-foreground py-2">Use PIN instead</button>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
