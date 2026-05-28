# Real Voice Verification System — Architecture & Implementation

Zuri Connect Africa now supports real voiceprint matching with enrollment, similarity verification, replay attack detection, and noise/quality analysis.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│             Voice Verification Component                │
│         (components/auth/VoiceBiometric)                │
│  - UI: passphrase display, waveform, quality feedback  │
│  - Manages recording & real-time amplitude display      │
└────────────────────┬────────────────────────────────────┘
                     │
     ┌───────────────┴───────────────┐
     │                               │
┌────▼──────────────────┐   ┌───────▼──────────────────┐
│ Voice Processor        │   │ Voice Provider          │
│ (lib/voice/...)        │   │ (lib/voice/...)         │
│                        │   │                         │
│ • captureVoiceRecording│   │ Abstraction Layer       │
│ • analyzeAudioQuality  │   │ Supports multiple       │
│ • generateVoiceEmbed   │   │ verification backends:  │
│ • compareEmbeddings    │   │                         │
│ • detectReplayAttack   │   │ • Local Demo (current)  │
│ • encryptEmbedding     │   │ • Azure (stub)          │
│ • storeVoiceEnrollment │   │ • AWS (stub)            │
│                        │   │                         │
└────────────────────────┘   └────────────────────────────┘
```

## Core Components

### 1. **lib/voice/voiceProcessor.js**

Real voice feature extraction & similarity matching using Web Audio API.

#### Functions

**`captureVoiceRecording({ durationMs, onProgress, onQualityCheck })`**
- Real microphone capture with user feedback
- Returns: `{ audioBlob, audioBuffer, durationMs, quality, timestamp }`
- Error handling: permission denial, device unavailable, timeout

**`analyzeAudioQuality(audioBuffer)`**
- Duration check (1–10 seconds)
- Silence detection (max 50%)
- Clipping detection (distortion)
- Signal strength validation
- RMS level check
- Voice frequency detection
- Returns: `{ issues: [], isAcceptable, score }`

**`generateVoiceEmbedding(audioBuffer, passphrase)`**
- MFCC-like feature extraction (13 coefficients)
- Energy contour analysis
- Voice characteristics: ZCR, spectral centroid, RMS
- Passphrase hash (consistency check)
- Returns: `{ mfccLike, energyContour, voiceCharacteristics, passphraseHash, ... }`

**`compareVoiceEmbeddings(enrollmentEmbed, verificationEmbed, threshold)`**
- Cosine similarity on MFCC features (weight: 0.4)
- Energy contour matching (weight: 0.25)
- Voice characteristics comparison (weight: 0.25)
- Passphrase verification (weight: 0.1)
- Returns: `{ isMatch, overallScore, scoreBreakdown, confidence }`

**`detectReplayAttack(currentRecording, recentRecordings)`**
- Checks if current sample is suspiciously similar to recent recordings
- Flags within 30-second window & >92% similarity as replay
- Returns: `{ isReplay, replayRisk, recommendation }`

**`encryptEmbedding(embedding)` / `decryptEmbedding(encrypted)`**
- Demo: Base64 encoding + JSON
- Production: SubtleCrypto AES-GCM

**`storeVoiceEnrollment(userId, embedding, passphrase)`**
- Stores encrypted embedding in sessionStorage (demo) or backend
- Returns enrollment metadata

**`getVoiceEnrollment(userId)`**
- Retrieves & decrypts stored voiceprint

---

### 2. **lib/voice/voiceVerificationProvider.js**

Provider abstraction for easy backend swapping (local → Azure/AWS).

#### Classes

**`VoiceVerificationProvider` (base class)**
```javascript
class VoiceVerificationProvider {
  async enroll(userId, audioBuffer, passphrase)    // Enroll new voiceprint
  async verify(userId, audioBuffer, passphrase)    // Verify against enrollment
  async remove(userId)                             // Remove enrollment
  getStatus(userId)                                // Check enrollment status
}
```

**`LocalDemoProvider` (current)**
- Real MFCC-based similarity matching
- Detects replays and low-quality recordings
- Fallback when voice not enrolled
- Returns detailed match confidence & reason

**`AzureProvider` (stub)**
```javascript
// Constructor
new AzureProvider({
  endpoint: 'https://<region>.tts.speech.microsoft.com',
  subscriptionKey: '...',
})
```
TODO: Implement Azure Speaker Recognition REST API calls

**`AWSProvider` (stub)**
```javascript
// Constructor
new AWSProvider({
  region: 'us-east-1',
  accessKeyId: '...',
  secretAccessKey: '...',
  domainId: '...',
})
```
TODO: Implement AWS Voice ID Enroll/Verify calls

#### High-level API

```javascript
import {
  enrollVoice,
  verifyVoice,
  removeVoiceEnrollment,
  getVoiceEnrollmentStatus,
  setVoiceProvider,
} from '@/lib/voice/voiceVerificationProvider';

// Use current provider
const enrollResult = await enrollVoice(userId, audioBuffer, passphrase);
const verifyResult = await verifyVoice(userId, audioBuffer, passphrase);

// Switch provider at runtime
setVoiceProvider(new AzureProvider(config));
```

---

## Enrollment Flow

### Step 1: User initiates enrollment
**Location:** Profile → Biometric Security → "Enable Voice"

### Step 2: Select passphrase
User sees random passphrase in English or Kiswahili.
Can switch phrases before recording.

### Step 3: Real microphone capture
- 5-second recording window
- Real-time waveform visualization
- Volume feedback ("Good" / "Speak up")
- Noise detection warning
- User must speak ≥1.5 seconds

### Step 4: Quality analysis
- Duration check
- Silence detection
- Signal strength
- Noise floor validation
- Voice frequency detection

### Step 5: Embedding generation
- MFCC extraction
- Energy contour
- Voice characteristics
- Passphrase hash

### Step 6: Encrypted storage
- Embedding encrypted with Base64 (demo) / SubtleCrypto (prod)
- Stored in sessionStorage (demo) / backend (production)

### Step 7: Success confirmation
User sees green checkmark & can now use voice auth.

---

## Verification Flow

### Step 1: User initiates voice auth
**Trigger:** High-value transaction (>KSh 50,000) or security-critical action

### Step 2: Check enrollment
If voice not enrolled → force fallback to PIN

### Step 3: Passphrase display
Random passphrase shown (may differ from enrollment)

### Step 4: Real microphone capture
Same as enrollment: 5s, real-time feedback

### Step 5: Quality & replay checks
- Audio quality validation
- Replay attack detection (recent 30-second window)
- Passphrase validation

### Step 6: Voice embedding generation
Same features as enrollment

### Step 7: Real similarity matching
- Compare MFCC (cosine distance)
- Compare energy contours
- Compare voice characteristics
- Verify passphrase consistency
- Weighted score: default threshold 0.75

### Step 8: Result
**If match:**
- Confidence: 0–100
- Auto-advance to next step
- Log successful auth

**If no match:**
- Reason: voice_mismatch | passphrase | replay_attack | processing_error
- Allow max 3 retries
- After 3 failures: PIN fallback required
- Log failed attempt

---

## Quality Control

### Audio Quality Checks

| Metric | Min | Max | Consequence |
|--------|-----|-----|-------------|
| Duration | 1s | 10s | Reject if outside |
| Silence ratio | — | 50% | Warn if >50% silent |
| Max amplitude | 0.05 | 0.95 | Reject if outside |
| Clipping | — | 10% | Reject if >10% clipped |
| RMS (noise floor) | 0.02 | — | Reject if <0.02 |
| Voice frequency | Required | — | Reject if not detected |

### Real-time Feedback

During recording:
- **Waveform visualizer** — 36 animated bars showing amplitude envelope
- **Volume meter** — "Good" (green) or "Speak up" (amber)
- **Noise warning** — Alert if background noise detected
- **Countdown** — Time remaining (5s → 0s)

---

## Security Features

### 1. Passphrase Verification
- Passphrase hash stored (not plaintext)
- Verification recording must match enrolled phrase
- Prevents speaker impersonation (attacker wouldn't know passphrase)

### 2. Replay Attack Detection
- Compares current recording to recent (< 30s) samples
- Flags >92% similarity as replay
- Requires user to re-record

### 3. Background Noise Detection
- Analyzes frequency spectrum
- Warns user in real-time if noise too high
- Quality check during verification

### 4. Microphone Quality Checks
- Signal strength validation (not too quiet, not clipping)
- RMS level checking
- Voice frequency detection

### 5. No Raw Biometric Storage
- Only encrypted embeddings stored
- Original audio is not persisted
- Passphrase hashed (not plaintext)

### 6. Fallback to PIN
- If voice auth fails 3× → PIN required
- If replay attack suspected → re-record or PIN
- If passphrase mismatch → re-record or PIN
- If voice not enrolled → PIN only

---

## API Reference

### Voice Processor

```javascript
import {
  captureVoiceRecording,
  generateVoiceEmbedding,
  compareVoiceEmbeddings,
  detectReplayAttack,
  storeVoiceEnrollment,
  getVoiceEnrollment,
} from '@/lib/voice/voiceProcessor';

// Capture audio
const recording = await captureVoiceRecording({
  durationMs: 5000,
  onProgress: (percent) => console.log(percent),
  onQualityCheck: (quality) => {
    console.log('Issues:', quality.issues);
    console.log('Score:', quality.score);
  },
});

// Generate embedding
const embedding = await generateVoiceEmbedding(
  recording.audioBuffer,
  'My voice is my Safaricom password'
);

// Compare embeddings
const result = compareVoiceEmbeddings(enrollmentEmbed, verifyEmbed, 0.75);
console.log(result.isMatch);        // true/false
console.log(result.confidence);     // 0-100
console.log(result.scoreBreakdown); // [{ name, score, weight }, ...]

// Detect replays
const replayCheck = detectReplayAttack(
  { embedding: verifyEmbed, timestamp: Date.now() },
  recentRecordings
);
console.log(replayCheck.isReplay);  // true/false
console.log(replayCheck.replayRisk);// 0-100
```

### Voice Provider

```javascript
import {
  enrollVoice,
  verifyVoice,
  removeVoiceEnrollment,
  getVoiceEnrollmentStatus,
  setVoiceProvider,
  createProvider,
} from '@/lib/voice/voiceVerificationProvider';

// Enroll (real voiceprint)
const enrollResult = await enrollVoice('user@example.com', audioBuffer, 'passphrase');
// Result:
// {
//   success: true,
//   provider: 'local-demo',
//   enrollmentId: 'user@example.com_1234567890',
//   enrolledAt: '2026-05-08T...',
// }

// Verify against enrollment
const verifyResult = await verifyVoice('user@example.com', audioBuffer, 'passphrase');
// Result:
// {
//   success: true,
//   isMatch: true,
//   confidence: 92,
//   overallScore: 0.92,
//   scoreBreakdown: [...],
//   provider: 'local-demo',
// }
// or
// {
//   success: false,
//   isMatch: false,
//   error: 'Voice does not match enrollment',
//   failureReason: 'voice_mismatch' | 'passphrase' | 'replay_attack' | 'processing_error',
//   confidence: 0,
//   provider: 'local-demo',
// }

// Check status
const status = getVoiceEnrollmentStatus('user@example.com');
// { isEnrolled: true, enrolledAt: '2026-05-08T...', provider: 'local-demo' }

// Remove enrollment
await removeVoiceEnrollment('user@example.com');

// Switch provider at runtime
setVoiceProvider(createProvider('azure', {
  endpoint: 'https://...',
  subscriptionKey: '...',
}));
```

---

## Production Deployment

### Database Schema (Backend)

```sql
CREATE TABLE voice_enrollments (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  encrypted_embedding TEXT NOT NULL,
  passphrase_hash TEXT NOT NULL,
  enrolled_at TIMESTAMP NOT NULL,
  provider VARCHAR(50),
  version VARCHAR(10),
  provider_enrollment_id VARCHAR(255),  -- Azure/AWS ID
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE voice_auth_logs (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider VARCHAR(50),
  success BOOLEAN,
  confidence NUMERIC,
  failure_reason VARCHAR(50),
  detected_replay BOOLEAN,
  quality_score NUMERIC,
  timestamp TIMESTAMP DEFAULT NOW()
);
```

### Environment Variables

```bash
# Local demo (no config needed)
VOICE_PROVIDER=local-demo

# Azure Speaker Recognition
VOICE_PROVIDER=azure
AZURE_SPEECH_ENDPOINT=https://<region>.tts.speech.microsoft.com
AZURE_SPEECH_KEY=<subscription-key>

# AWS Voice ID
VOICE_PROVIDER=aws
AWS_REGION=us-east-1
AWS_VOICE_ID_DOMAIN=<domain-id>
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
```

### Migration from Simulated to Real

1. **Phase 1:** Local demo (current)
   - Real MFCC matching
   - Replay detection
   - Quality analysis

2. **Phase 2:** Azure Speaker Recognition
   - Replace `generateVoiceEmbedding` with Azure API call
   - Move verification to Azure backend
   - Implement `AzureProvider.verify()`

3. **Phase 3:** AWS Voice ID
   - Similar migration to AWS backend
   - Implement `AWSProvider.enroll/verify()`

### Switching Providers

```javascript
// At app startup
import { setVoiceProvider, createProvider } from '@/lib/voice/voiceVerificationProvider';

const provider = process.env.VOICE_PROVIDER || 'local-demo';
const config = {
  azure: {
    endpoint: process.env.AZURE_SPEECH_ENDPOINT,
    subscriptionKey: process.env.AZURE_SPEECH_KEY,
  },
  aws: {
    region: process.env.AWS_REGION,
    domainId: process.env.AWS_VOICE_ID_DOMAIN,
    // AWS SDK will use env vars for credentials
  },
};

setVoiceProvider(createProvider(provider, config[provider]));
```

---

## Testing

### Unit Tests

```javascript
// Test quality analysis
const audioBuffer = /* decode test WAV */;
const quality = await analyzeAudioQuality(audioBuffer);
assert(quality.isAcceptable === true);

// Test embedding generation
const embed1 = await generateVoiceEmbedding(audioBuffer, 'test phrase');
const embed2 = await generateVoiceEmbedding(audioBuffer, 'test phrase');
assert(compareVoiceEmbeddings(embed1, embed2, 0.75).overallScore > 0.95);

// Test replay detection
const recordings = [
  { embedding: embed1, timestamp: Date.now() - 15000 },
];
const replayCheck = detectReplayAttack(
  { embedding: embed1, timestamp: Date.now() },
  recordings
);
assert(replayCheck.isReplay === true);
```

### E2E Testing

1. **Enroll:** Say "My voice is my Safaricom password" → verify stored
2. **Match:** Say same phrase again → verify match ≥75%
3. **Mismatch:** Say different phrase → verify no match
4. **Noise:** Record with background noise → quality check fails or confidence drops
5. **Replay:** Enroll, immediately re-submit same recording → replay attack detected
6. **Fallback:** Fail 3× voice auth → PIN required

---

## Limitations & Future Work

### Current Limitations

- Local MFCC matching is lightweight (good for demo, not production-grade)
- Passphrase must be identical (future: text-independent verification)
- No speaker age/gender adaptation
- Limited to English/Swahili passphrases
- No liveness detection (anti-spoofing)

### Future Roadmap

- [ ] Implement Azure Speaker Recognition backend
- [ ] Implement AWS Voice ID backend
- [ ] Text-independent speaker verification (no passphrase needed)
- [ ] Anti-spoofing / liveness detection
- [ ] Multi-factor voice + face auth
- [ ] Biometric sync across sessions
- [ ] Voice enrollment persistence (backend)
- [ ] Admin dashboard for voice auth stats
- [ ] Automatic retraining on enrollment updates

---

## Support & Troubleshooting

**"Microphone access denied"**
- Enable microphone in browser settings
- Check HTTPS (required for getUserMedia)

**"Voice not enrolled"**
- Go to Profile → Biometric Security → "Enable Voice"
- Complete enrollment with clear audio

**"Confidence below threshold"**
- Speak clearly and at normal pace
- Move to quieter location
- Hold phone 15–20 cm from mouth
- Try again

**"Replay attack suspected"**
- Don't immediately re-submit same recording
- Re-record fresh voice sample
- Use PIN as fallback

---

**Last Updated:** 2026-05-08
**Status:** Demo Ready → Production Migration Path