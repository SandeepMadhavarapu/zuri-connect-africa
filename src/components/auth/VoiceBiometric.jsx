import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, ShieldCheck, AlertTriangle, RefreshCw, Check, Volume2, Shield } from 'lucide-react';
import { captureVoiceRecording } from '@/lib/voice/voiceProcessor';
import { verifyVoice, getVoiceEnrollmentStatus } from '@/lib/voice/voiceVerificationProvider';
import { useAuth } from '@/lib/AuthContext';
import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';
import { toast } from '@/components/ui/use-toast';

const PASSPHRASES = [
  { text: "My voice is my Safaricom password", lang: 'en' },
  { text: "Sauti yangu ndiyo ufunguo wangu", lang: 'sw' },
  { text: "Lipa pesa yangu kwa sauti yangu", lang: 'sw' },
  { text: "Ninathibitisha malipo haya", lang: 'sw' },
  { text: "Confirm this payment with my voice", lang: 'en' },
];

const ANALYSIS_STAGES = [
  { label: 'Capturing audio sample…',          ms: 700 },
  { label: 'Analysing waveform pattern…',      ms: 800 },
  { label: 'Extracting voiceprint features…',  ms: 900 },
  { label: 'Running anti-spoof detection…',    ms: 700 },
  { label: 'Matching voiceprint profile…',     ms: 800 },
  { label: 'Finalizing verification…',         ms: 500 },
];

const MIN_VOLUME_THRESHOLD = 8; // RMS units — below this = silence
const RECORD_DURATION_MS   = 5000;

function WaveformVisualizer({ isRecording, amplitude, volumeOk }) {
  const bars = 36;
  return (
    <div className="flex items-center justify-center gap-0.5 h-14">
      {Array.from({ length: bars }).map((_, i) => {
        const center   = Math.abs(i - bars / 2) / (bars / 2);
        const envelope = 1 - center * 0.55;
        const wave     = isRecording
          ? 3 + amplitude * envelope * (0.5 + 0.5 * Math.sin(i * 1.4 + Date.now() / 180))
          : 3;
        return (
          <motion.div
            key={i}
            className="rounded-full"
            style={{
              width: 2,
              backgroundColor: volumeOk ? 'hsl(142, 72%, 36%)' : 'rgba(255,255,255,0.2)',
            }}
            animate={{ height: wave }}
            transition={{ duration: 0.07, ease: 'linear' }}
          />
        );
      })}
    </div>
  );
}

export default function VoiceBiometric({ amount, recipient, onSuccess, onCancel, onFallback }) {
  const { user } = useAuth();
  const [phase,        setPhase]        = useState('idle');
  const [phraseIndex,  setPhraseIndex]  = useState(() => Math.floor(Math.random() * PASSPHRASES.length));
  const [amplitude,    setAmplitude]    = useState(4);
  const [volumeOk,     setVolumeOk]     = useState(false);
  const [noiseWarn,    setNoiseWarn]    = useState(false);
  const [countdown,    setCountdown]    = useState(RECORD_DURATION_MS / 1000);
  const [stageIndex,   setStageIndex]   = useState(0);
  const [stageLabel,   setStageLabel]   = useState('');
  const [confidence,   setConfidence]   = useState(0);
  const [attempts,     setAttempts]     = useState(0);
  const [permDenied,   setPermDenied]   = useState(false);
  const [spokeLong,    setSpokeLong]    = useState(false);
  const [qualityIssues, setQualityIssues] = useState([]);
  const [isEnrolled,   setIsEnrolled]   = useState(false);
  const [failureReason, setFailureReason] = useState(null);

  const streamRef    = useRef(null);
  const animFrameRef = useRef(null);
  const timerRef     = useRef(null);
  const countRef     = useRef(null);
  const speakTimeRef = useRef(0);
  const audioContextRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const passphrase   = PASSPHRASES[phraseIndex];

  // Check enrollment status on mount
  useEffect(() => {
    if (user?.email) {
      const status = getVoiceEnrollmentStatus(user.email);
      setIsEnrolled(status.isEnrolled);
    }
  }, [user?.email]);

  // ── Waveform + volume + noise analysis ───────────────────────────────────
  const startAmplitudeLoop = useCallback((analyser) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      analyser.getByteFrequencyData(freqData);

      // RMS amplitude
      const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length);
      setAmplitude(4 + rms * 1.4);

      const isVolumeOk = rms >= MIN_VOLUME_THRESHOLD;
      setVolumeOk(isVolumeOk);
      if (isVolumeOk) speakTimeRef.current += 1;
      if (speakTimeRef.current > 20) setSpokeLong(true);

      // Rough background noise detection: high energy at low freqs with no mid/high = noise
      const lowFreqEnergy = freqData.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
      const midFreqEnergy = freqData.slice(8, 40).reduce((a, b) => a + b, 0) / 32;
      setNoiseWarn(lowFreqEnergy > 80 && midFreqEnergy < 20 && rms > 5);

      animFrameRef.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    clearTimeout(timerRef.current);
    clearInterval(countRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setAmplitude(4);
    setVolumeOk(false);
  }, []);

  useEffect(() => () => stopMic(), [stopMic]);

  // ── Start recording ───────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (!isEnrolled) {
      // No raw alert() in production UI — surface a toast and hand off to the
      // PIN fallback so the user is never blocked.
      toast({
        title: 'Voice not enrolled',
        description: 'Enroll your voice in Profile → Security to use voice authentication. Using PIN instead.',
      });
      onFallback?.();
      return;
    }

    setPhase('listening');
    setCountdown(RECORD_DURATION_MS / 1000);
    speakTimeRef.current = 0;
    setSpokeLong(false);
    setQualityIssues([]);

    // Countdown tick
    let c = RECORD_DURATION_MS / 1000;
    countRef.current = setInterval(() => {
      c = Math.max(0, c - 1);
      setCountdown(c);
    }, 1000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      // Start MediaRecorder for actual audio capture
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        audioChunksRef.current.push(e.data);
      };

      mediaRecorder.start();
      startAmplitudeLoop(analyser);
    } catch (err) {
      clearInterval(countRef.current);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setPermDenied(true);
        setPhase('idle');
        return;
      }
    }

    timerRef.current = setTimeout(() => {
      stopMic();
      runAnalysis();
    }, RECORD_DURATION_MS);
  }, [startAmplitudeLoop, stopMic, isEnrolled, onFallback]);

  // ── Analysis pipeline ─────────────────────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    setPhase('analysing');
    setStageIndex(0);
    setFailureReason(null);

    try {
      // Construct audio blob from chunks
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

      // Decode audio to get AudioBuffer
      let audioBuffer = null;
      try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const ctx = audioContextRef.current || new (window.AudioContext || window.webkitAudioContext)();
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      } catch (e) {
        throw new Error('Audio decode failed');
      }

      // Check quality
      const quality = await captureVoiceRecording({
        durationMs: 0, // Skip actual capture, use decoded buffer
        onQualityCheck: (q) => {
          if (!q.isAcceptable) {
            setQualityIssues(q.issues);
          }
        },
      }).catch(() => null);

      // Run real voice verification
      let verifyResult = null;
      for (let i = 0; i < ANALYSIS_STAGES.length; i++) {
        setStageIndex(i);
        setStageLabel(ANALYSIS_STAGES[i].label);
        await new Promise(r => setTimeout(r, ANALYSIS_STAGES[i].ms));

        // Run verification on final stage
        if (i === ANALYSIS_STAGES.length - 1) {
          verifyResult = await verifyVoice(
            user?.email,
            audioBuffer,
            passphrase.text
          );
          const conf = verifyResult.confidence || 0;
          setConfidence(conf);
        } else {
          const targetConf = Math.round(((i + 1) / ANALYSIS_STAGES.length) * 100);
          setConfidence(targetConf);
        }
      }

      // Handle result
      if (verifyResult?.success && verifyResult?.isMatch) {
        setConfidence(verifyResult.confidence);
        setPhase('success');
        setTimeout(() => onSuccess?.(), 1400);
      } else {
        setAttempts(a => a + 1);
        setFailureReason(verifyResult?.failureReason || 'voice_mismatch');
        setPhase('failed');
      }
    } catch (e) {
      console.error('[VoiceBiometric] Analysis error:', e);
      setAttempts(a => a + 1);
      setFailureReason('processing_error');
      setPhase('failed');
    }
  }, [user?.email, passphrase.text, onSuccess]);

  const retry = () => {
    setPhraseIndex(i => (i + 1) % PASSPHRASES.length);
    setPhase('idle');
    setStageIndex(0);
    setConfidence(0);
    setPermDenied(false);
  };

  return (
    <div className="flex flex-col items-center w-full">
      {/* Disclaimer */}
      <div className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400/8 border border-amber-400/15 mb-4">
        <span className="text-[10px] text-amber-400 font-medium">
          Voice verification preview · Local voiceprint check
        </span>
      </div>

      {/* Permission denied banner */}
      <AnimatePresence>
        {permDenied && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-2 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2.5 mb-3 w-full">
            <MicOff size={13} className="text-red-400 shrink-0" />
            <div>
              <p className="text-xs text-red-400 font-semibold">Microphone access denied</p>
              <p className="text-[10px] text-red-300/70 mt-0.5">Enable microphone access in browser settings and retry.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">

        {/* IDLE */}
        {phase === 'idle' && (
          <motion.div key="idle" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex flex-col items-center w-full">
            {!isEnrolled && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2.5 mb-3 w-full">
                <Shield size={13} className="text-red-400 shrink-0" />
                <div>
                  <p className="text-xs text-red-400 font-semibold">Voice not enrolled</p>
                  <p className="text-[10px] text-red-300/70">Enroll voice in Profile → Security</p>
                </div>
              </motion.div>
            )}
            <div className="w-16 h-16 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
              <Mic size={28} className="text-primary" />
            </div>
            <h3 className="text-base font-bold text-foreground font-grotesk mb-1">Voice Authentication</h3>
            <p className="text-[11px] text-muted-foreground text-center mb-4">Speak the passphrase clearly to authorise this transaction</p>

            {/* Passphrase card */}
            <div className="glass-card rounded-2xl p-4 mb-2 w-full text-center" style={{ borderColor: 'rgba(0,200,83,0.2)' }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 font-semibold">
                {passphrase.lang === 'sw' ? '🇰🇪 Kiswahili' : '🇬🇧 English'} · Say this phrase
              </p>
              <p className="text-foreground font-semibold text-sm leading-snug">"{passphrase.text}"</p>
            </div>
            <button onClick={() => setPhraseIndex(i => (i + 1) % PASSPHRASES.length)}
              className="flex items-center gap-1 text-xs text-primary mb-5">
              <RefreshCw size={11} /> Use different phrase
            </button>

            <motion.button whileTap={{ scale: 0.97 }} onClick={startListening}
              className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-2 text-black font-bold text-sm mb-3">
              <Mic size={18} /> Start Voice Authentication
            </motion.button>
            <button onClick={onFallback} className="text-xs text-muted-foreground py-2">Use PIN instead</button>
          </motion.div>
        )}

        {/* LISTENING */}
        {phase === 'listening' && (
          <motion.div key="listening" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full">
            <motion.div className="w-20 h-20 rounded-full bg-primary/10 border-2 border-primary/30 flex items-center justify-center mb-3 animate-pulse-green">
              <Mic size={32} className="text-primary" />
            </motion.div>
            <p className="text-foreground font-bold text-base font-grotesk">Listening…</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">{countdown}s remaining · Speak clearly</p>

            <WaveformVisualizer isRecording amplitude={amplitude} volumeOk={volumeOk} />

            {/* Volume feedback */}
            <div className="flex items-center justify-between w-full mt-3 mb-2">
              <span className="text-[10px] text-muted-foreground">Volume</span>
              <span className={`text-[10px] font-semibold ${volumeOk ? 'text-primary' : 'text-amber-400'}`}>
                {volumeOk ? 'Good' : 'Speak up'}
              </span>
            </div>
            <div className="w-full h-1 bg-white/6 rounded-full overflow-hidden mb-3">
              <motion.div
                className={`h-full rounded-full ${volumeOk ? 'bg-primary' : 'bg-amber-400'}`}
                animate={{ width: `${Math.min(100, (amplitude / 30) * 100)}%` }}
                transition={{ duration: 0.1 }}
              />
            </div>

            {/* Noise warning */}
            <AnimatePresence>
              {noiseWarn && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-2 bg-amber-400/8 border border-amber-400/15 rounded-xl px-3 py-2 mb-3 w-full">
                  <Volume2 size={12} className="text-amber-400 shrink-0" />
                  <p className="text-[10px] text-amber-400">Background noise detected — move to a quieter area</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Passphrase reminder */}
            <div className="glass-card rounded-xl px-4 py-3 w-full text-center mb-3">
              <p className="text-xs text-muted-foreground mb-1">Say:</p>
              <p className="text-sm font-semibold text-foreground">"{passphrase.text}"</p>
            </div>

            <button onClick={() => { stopMic(); setPhase('idle'); }}
              className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <MicOff size={13} /> Cancel recording
            </button>
          </motion.div>
        )}

        {/* ANALYSING */}
        {phase === 'analysing' && (
          <motion.div key="analysing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full">
            <div className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-4 glow-green">
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}>
                <RefreshCw size={28} className="text-black" />
              </motion.div>
            </div>
            <p className="text-foreground font-bold text-base font-grotesk mb-1">Analysing Voice</p>

            {/* Confidence meter */}
            <div className="w-full mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-muted-foreground">Match confidence</span>
                <span className="text-[11px] text-primary font-semibold font-grotesk">{confidence}%</span>
              </div>
              <div className="w-full h-1.5 bg-white/6 rounded-full overflow-hidden">
                <motion.div className="h-full bg-primary rounded-full"
                  animate={{ width: `${confidence}%` }} transition={{ duration: 0.4 }} />
              </div>
            </div>

            <div className="space-y-2.5 w-full">
              {ANALYSIS_STAGES.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
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
            <p className="text-[10px] text-muted-foreground/50 text-center mt-4">
              {getClientDemoPolicy().hardenedSurface
                ? 'PIN fallback remains available for high-value actions.'
                : 'Local voice analysis preview · PIN fallback available.'}
            </p>
          </motion.div>
        )}

        {/* SUCCESS */}
        {phase === 'success' && (
          <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center py-4">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
              className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-4 glow-green">
              <ShieldCheck size={36} className="text-black" />
            </motion.div>
            <h3 className="text-xl font-bold text-foreground font-grotesk">Voice Verified!</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Match confidence: <span className="text-primary font-semibold">{confidence}%</span>
            </p>
            <p className="text-[10px] text-muted-foreground/60 text-center mt-2 leading-relaxed px-4">
              {getClientDemoPolicy().hardenedSurface
                ? 'Additional verification may be requested for high-value actions.'
                : 'Local voice verification preview · additional verification may be requested.'}
            </p>
          </motion.div>
        )}

        {/* FAILED */}
        {phase === 'failed' && (
          <motion.div key="failed" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center w-full">
            <div className="w-16 h-16 rounded-full bg-red-400/10 border border-red-400/30 flex items-center justify-center mb-3">
              <AlertTriangle size={28} className="text-red-400" />
            </div>
            <h3 className="text-base font-bold text-foreground font-grotesk mb-1">Voice Not Recognised</h3>
            <p className="text-[11px] text-muted-foreground text-center mb-4 leading-relaxed">
              {failureReason === 'passphrase' && 'Passphrase does not match. Did you say the correct phrase?'}
              {failureReason === 'replay_attack' && 'Possible replay attack detected. Please re-record.'}
              {failureReason === 'voice_mismatch' && 'Voice does not match your enrollment. Try again in a quieter environment.'}
              {failureReason === 'processing_error' && 'Voice processing error. Please try again.'}
              {!failureReason && 'Verification failed. Try again.'}
            </p>
            <div className="glass-card rounded-xl px-4 py-3 mb-4 w-full">
              <p className="text-[11px] text-muted-foreground font-semibold mb-2 uppercase tracking-wider">Tips</p>
              {['Speak clearly at a normal pace', 'Move to a quieter location', 'Hold phone 15–20 cm from mouth', 'Try the Swahili phrase instead'].map(tip => (
                <div key={tip} className="flex items-center gap-2 py-1">
                  <div className="w-1 h-1 rounded-full bg-primary shrink-0" />
                  <p className="text-xs text-muted-foreground">{tip}</p>
                </div>
              ))}
            </div>
            {attempts >= 3 && (
              <div className="glass-card rounded-xl px-4 py-3 mb-4 w-full bg-amber-400/5 border border-amber-400/15">
                <p className="text-[11px] text-amber-400 font-medium">
                  Maximum attempts reached. Use PIN to proceed.
                </p>
              </div>
            )}
            {attempts < 3 ? (
              <>
                <button onClick={retry}
                  className="w-full gradient-green rounded-2xl py-3.5 flex items-center justify-center gap-2 text-black font-bold text-sm mb-3">
                  <RefreshCw size={16} /> Try Again
                </button>
                <button onClick={onFallback} className="text-xs text-muted-foreground py-2">Use PIN instead</button>
              </>
            ) : (
              <button onClick={onFallback}
                className="w-full gradient-green rounded-2xl py-3.5 flex items-center justify-center gap-2 text-black font-bold text-sm">
                Use PIN to Continue
              </button>
            )}
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
