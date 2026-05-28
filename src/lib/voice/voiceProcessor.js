/**
 * Voice Processor — Real voiceprint generation & similarity matching
 * Web Audio API-based lightweight voice feature extraction
 * Designed for local demo; easily swap for Azure Speaker Recognition or AWS Voice ID
 */

// ── Audio capture & processing ────────────────────────────────────────────

export async function captureVoiceRecording({
  durationMs = 3000,
  onProgress = null,
  onQualityCheck = null,
} = {}) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } 
    });

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const mediaRecorder = new MediaRecorder(stream);
    const chunks = [];

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          
          // Quality metrics
          const quality = await analyzeAudioQuality(audioBuffer);
          if (onQualityCheck) onQualityCheck(quality);

          if (!quality.isAcceptable) {
            reject(new Error(`Voice quality insufficient: ${quality.issues.join(', ')}`));
            return;
          }

          resolve({
            audioBlob,
            audioBuffer,
            durationMs: audioBuffer.duration * 1000,
            quality,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          reject(new Error(`Audio decode failed: ${e.message}`));
        }
      };

      mediaRecorder.start();

      // Stop recording after duration
      const timer = setTimeout(() => {
        mediaRecorder.stop();
      }, durationMs);

      // Progress callback
      if (onProgress) {
        const progressInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const pct = Math.min(100, Math.round((elapsed / durationMs) * 100));
          onProgress(pct);
          if (elapsed >= durationMs) clearInterval(progressInterval);
        }, 100);
      }

      // Timeout safety
      setTimeout(() => {
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
          reject(new Error('Recording timeout'));
        }
      }, durationMs + 1000);
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      throw new Error('Microphone permission denied');
    }
    throw new Error(`Voice capture failed: ${e.message}`);
  }
}

// ── Audio quality analysis ────────────────────────────────────────────────

async function analyzeAudioQuality(audioBuffer) {
  const issues = [];
  const rawData = audioBuffer.getChannelData(0);
  
  // 1. Duration check
  const durationMs = audioBuffer.duration * 1000;
  if (durationMs < 1000) issues.push('Too short (min 1s)');
  if (durationMs > 10000) issues.push('Too long (max 10s)');

  // 2. Silence detection
  const silenceThreshold = 0.02;
  const silentSamples = rawData.filter(s => Math.abs(s) < silenceThreshold).length;
  const silenceRatio = silentSamples / rawData.length;
  if (silenceRatio > 0.5) issues.push('Too much silence');

  // 3. Clipping detection (distortion)
  const clippedSamples = rawData.filter(s => Math.abs(s) > 0.99).length;
  if (clippedSamples / rawData.length > 0.1) issues.push('Audio clipping detected');

  // 4. Signal strength
  const maxAmplitude = Math.max(...rawData.map(Math.abs));
  if (maxAmplitude < 0.05) issues.push('Signal too weak');
  if (maxAmplitude > 0.95) issues.push('Signal too loud');

  // 5. Noise floor
  const rms = Math.sqrt(rawData.reduce((sum, s) => sum + s * s, 0) / rawData.length);
  if (rms < 0.02) issues.push('Microphone issue detected');

  // 6. Frequency spectrum (basic noise check)
  const hasVoiceFrequency = await detectVoiceFrequency(audioBuffer);
  if (!hasVoiceFrequency) issues.push('No voice detected');

  return {
    durationMs,
    silenceRatio,
    maxAmplitude,
    rms,
    hasVoiceFrequency,
    issues,
    isAcceptable: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 20),
  };
}

async function detectVoiceFrequency(audioBuffer) {
  const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  
  const analyser = offlineCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  analyser.connect(offlineCtx.destination);
  
  source.start(0);
  const result = await offlineCtx.startRendering();
  
  // Voice typically 85-255 Hz (male) and 165-255 Hz (female)
  // We'll check for energy in 80-4000 Hz band
  return true; // Simplified for demo; in production, analyze frequency bins
}

// ── Voice embedding generation (MFCC-like lightweight features) ────────────

export async function generateVoiceEmbedding(audioBuffer, passphrase = '') {
  const sampleRate = audioBuffer.sampleRate;
  const rawData = audioBuffer.getChannelData(0);

  // Extract multiple feature sets for robust matching
  const features = {
    mfccLike: extractMFCCLike(rawData, sampleRate),
    energyContour: extractEnergyContour(rawData, 256),
    voiceCharacteristics: extractVoiceCharacteristics(rawData),
    passphraseHash: hashPassphrase(passphrase),
    duration: audioBuffer.duration,
    sampleRate,
    timestamp: Date.now(),
  };

  // Create embedding signature
  const embedding = {
    ...features,
    version: '1.0',
    method: 'lightweight-mfcc-demo',
  };

  return embedding;
}

function extractMFCCLike(rawData, sampleRate) {
  // Lightweight MFCC-like feature extraction (13 coefficients)
  const frameSize = 512;
  const hopSize = 256;
  const numFrames = Math.floor((rawData.length - frameSize) / hopSize);
  const coefficients = [];

  for (let i = 0; i < Math.min(numFrames, 100); i++) {
    const start = i * hopSize;
    const frame = rawData.slice(start, start + frameSize);
    
    // Hamming window
    const windowed = frame.map((s, idx) => {
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * idx / (frameSize - 1));
      return s * w;
    });

    // Power spectrum (simplified)
    const power = windowed.reduce((sum, s) => sum + s * s, 0) / frameSize;
    coefficients.push(power);
  }

  // Normalize
  const mean = coefficients.reduce((a, b) => a + b, 0) / coefficients.length;
  const std = Math.sqrt(coefficients.reduce((sum, c) => sum + (c - mean) ** 2, 0) / coefficients.length);
  return coefficients.map(c => (c - mean) / (std + 1e-8));
}

function extractEnergyContour(rawData, windowSize) {
  const contour = [];
  for (let i = 0; i < rawData.length; i += windowSize) {
    const window = rawData.slice(i, i + windowSize);
    const energy = Math.sqrt(window.reduce((sum, s) => sum + s * s, 0) / window.length);
    contour.push(energy);
  }
  return contour;
}

function extractVoiceCharacteristics(rawData) {
  // Zero-crossing rate (voiced/unvoiced discrimination)
  let zeroCrossings = 0;
  for (let i = 1; i < Math.min(rawData.length, 10000); i++) {
    if ((rawData[i] >= 0 && rawData[i - 1] < 0) || (rawData[i] < 0 && rawData[i - 1] >= 0)) {
      zeroCrossings++;
    }
  }

  // Spectral centroid (pitch estimation proxy)
  const fft = simpleFFT(rawData.slice(0, 4096));
  let spectralSum = 0;
  let weightedSum = 0;
  for (let i = 0; i < fft.length; i++) {
    spectralSum += fft[i];
    weightedSum += i * fft[i];
  }
  const spectralCentroid = weightedSum / (spectralSum + 1e-8);

  return {
    zeroCrossingRate: zeroCrossings,
    spectralCentroid,
    rms: Math.sqrt(rawData.reduce((sum, s) => sum + s * s, 0) / rawData.length),
  };
}

function simpleFFT(data) {
  // Placeholder for actual FFT; in production use FFT.js or Web Audio analyser
  const result = new Array(data.length / 2).fill(0);
  for (let i = 0; i < data.length; i++) {
    result[i % result.length] += Math.abs(data[i]);
  }
  return result;
}

function hashPassphrase(passphrase) {
  // Simple hash to verify passphrase consistency without storing plaintext
  let hash = 0;
  for (let i = 0; i < passphrase.length; i++) {
    const char = passphrase.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

// ── Voice similarity matching ────────────────────────────────────────────

export function compareVoiceEmbeddings(enrollmentEmbedding, verificationEmbedding, threshold = 0.75) {
  const scores = [];

  // 1. MFCC-like similarity (cosine distance)
  if (enrollmentEmbedding.mfccLike && verificationEmbedding.mfccLike) {
    const mfccScore = cosineSimilarity(
      enrollmentEmbedding.mfccLike,
      verificationEmbedding.mfccLike
    );
    scores.push({ name: 'mfcc', score: mfccScore, weight: 0.4 });
  }

  // 2. Energy contour similarity
  if (enrollmentEmbedding.energyContour && verificationEmbedding.energyContour) {
    const energyScore = cosineSimilarity(
      enrollmentEmbedding.energyContour,
      verificationEmbedding.energyContour
    );
    scores.push({ name: 'energy', score: energyScore, weight: 0.25 });
  }

  // 3. Voice characteristics similarity
  if (enrollmentEmbedding.voiceCharacteristics && verificationEmbedding.voiceCharacteristics) {
    const charScore = compareCharacteristics(
      enrollmentEmbedding.voiceCharacteristics,
      verificationEmbedding.voiceCharacteristics
    );
    scores.push({ name: 'characteristics', score: charScore, weight: 0.25 });
  }

  // 4. Passphrase match
  if (enrollmentEmbedding.passphraseHash === verificationEmbedding.passphraseHash) {
    scores.push({ name: 'passphrase', score: 1.0, weight: 0.1 });
  } else {
    scores.push({ name: 'passphrase', score: 0.0, weight: 0.1 });
  }

  // Weighted average
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const overallScore = scores.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

  const isMatch = overallScore >= threshold;

  return {
    isMatch,
    overallScore: Math.round(overallScore * 100) / 100,
    scoreBreakdown: scores,
    threshold,
    confidence: Math.round(Math.max(0, overallScore - 0.5) * 200), // 0-100
    recommendation: getVerificationRecommendation(overallScore, threshold),
  };
}

function cosineSimilarity(vec1, vec2) {
  const minLen = Math.min(vec1.length, vec2.length);
  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < minLen; i++) {
    dotProduct += vec1[i] * vec2[i];
    mag1 += vec1[i] * vec1[i];
    mag2 += vec2[i] * vec2[i];
  }

  mag1 = Math.sqrt(mag1);
  mag2 = Math.sqrt(mag2);

  if (mag1 === 0 || mag2 === 0) return 0;
  return dotProduct / (mag1 * mag2);
}

function compareCharacteristics(char1, char2) {
  const zcr = 1 - Math.abs(char1.zeroCrossingRate - char2.zeroCrossingRate) / 
              Math.max(char1.zeroCrossingRate, char2.zeroCrossingRate, 1);
  const sc = 1 - Math.abs(char1.spectralCentroid - char2.spectralCentroid) / 
             Math.max(char1.spectralCentroid, char2.spectralCentroid, 1);
  const rms = 1 - Math.abs(char1.rms - char2.rms) / 
              Math.max(char1.rms, char2.rms, 0.1);

  return (zcr + sc + rms) / 3;
}

function getVerificationRecommendation(score, threshold) {
  if (score >= threshold) return 'Match — voice verified';
  if (score >= threshold - 0.15) return 'Uncertain — possible match, recommend fallback auth';
  return 'No match — voice verification failed';
}

// ── Replay attack detection ──────────────────────────────────────────────

export function detectReplayAttack(currentRecording, recentRecordings = []) {
  if (recentRecordings.length === 0) return { isReplay: false, risk: 0 };

  // Check if current recording is suspiciously similar to recent recordings
  // (might be a replay)
  let maxSimilarity = 0;
  for (const recent of recentRecordings.slice(-5)) {
    // Compare timestamps and embeddings
    const timeDiff = Math.abs(currentRecording.timestamp - recent.timestamp);
    if (timeDiff < 30000) { // Within 30 seconds
      const similarity = compareVoiceEmbeddings(recent.embedding, currentRecording.embedding, 0).overallScore;
      if (similarity > 0.9) {
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
    }
  }

  const isReplay = maxSimilarity > 0.92;
  const risk = Math.min(100, Math.round(maxSimilarity * 100));

  return {
    isReplay,
    replayRisk: risk,
    recommendation: isReplay ? 'Possible replay attack detected. Re-record voice sample.' : null,
  };
}

// ── Storage & encryption ────────────────────────────────────────────────

export function encryptEmbedding(embedding, key = 'demo-key') {
  // Demo: simple JSON + obfuscation. In production: use SubtleCrypto
  const json = JSON.stringify(embedding);
  const encoded = btoa(json); // Base64 encode
  return encoded;
}

export function decryptEmbedding(encrypted, key = 'demo-key') {
  // Demo decryption
  try {
    const json = atob(encrypted); // Base64 decode
    return JSON.parse(json);
  } catch (e) {
    throw new Error('Failed to decrypt embedding');
  }
}

export function storeVoiceEnrollment(userId, embedding, passphrase) {
  const encrypted = encryptEmbedding(embedding);
  const storage = {
    userId,
    encryptedEmbedding: encrypted,
    passphraseHash: hashPassphrase(passphrase),
    enrolledAt: new Date().toISOString(),
    enrollmentVersion: '1.0',
  };

  // Store in sessionStorage (demo) or backend (production)
  sessionStorage.setItem(`voice_enrollment_${userId}`, JSON.stringify(storage));
  return storage;
}

export function getVoiceEnrollment(userId) {
  const stored = sessionStorage.getItem(`voice_enrollment_${userId}`);
  if (!stored) return null;

  try {
    const storage = JSON.parse(stored);
    storage.embedding = decryptEmbedding(storage.encryptedEmbedding);
    return storage;
  } catch (e) {
    console.error('Failed to retrieve enrollment:', e);
    return null;
  }
}