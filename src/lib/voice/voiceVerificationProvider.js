/**
 * Voice Verification Provider — Abstraction layer for easy swapping
 * Supports local demo, Azure Speaker Recognition, AWS Voice ID
 */

import {
  generateVoiceEmbedding,
  compareVoiceEmbeddings,
  detectReplayAttack,
  storeVoiceEnrollment,
  getVoiceEnrollment,
} from './voiceProcessor';

// ── Provider factory ────────────────────────────────────────────────────

class VoiceVerificationProvider {
  constructor(type = 'local-demo') {
    this.type = type;
    this.config = {};
  }

  async enroll(userId, audioBuffer, passphrase) {
    throw new Error('enroll() not implemented');
  }

  async verify(userId, audioBuffer, passphrase) {
    throw new Error('verify() not implemented');
  }

  async remove(userId) {
    throw new Error('remove() not implemented');
  }

  getStatus(userId) {
    throw new Error('getStatus() not implemented');
  }
}

// ── Local demo provider (current implementation) ────────────────────────

class LocalDemoProvider extends VoiceVerificationProvider {
  constructor() {
    super('local-demo');
    this.recentRecordings = {};
  }

  async enroll(userId, audioBuffer, passphrase) {
    try {
      const embedding = await generateVoiceEmbedding(audioBuffer, passphrase);
      const enrollment = storeVoiceEnrollment(userId, embedding, passphrase);

      return {
        success: true,
        provider: 'local-demo',
        enrollmentId: `${userId}_${Date.now()}`,
        enrolledAt: enrollment.enrolledAt,
        message: 'Voice enrollment successful',
      };
    } catch (e) {
      return {
        success: false,
        provider: 'local-demo',
        error: e.message,
      };
    }
  }

  async verify(userId, audioBuffer, passphrase) {
    try {
      // Get enrolled voiceprint
      const enrollment = getVoiceEnrollment(userId);
      if (!enrollment) {
        return {
          success: false,
          provider: 'local-demo',
          isMatch: false,
          error: 'Voice not enrolled for this user',
          confidence: 0,
        };
      }

      // Check passphrase first
      const inputPassphraseHash = this._hashPassphrase(passphrase);
      if (inputPassphraseHash !== enrollment.passphraseHash) {
        return {
          success: false,
          provider: 'local-demo',
          isMatch: false,
          error: 'Passphrase mismatch',
          confidence: 0,
          failureReason: 'passphrase',
        };
      }

      // Generate verification embedding
      const verificationEmbedding = await generateVoiceEmbedding(audioBuffer, passphrase);

      // Check for replay attacks
      if (!this.recentRecordings[userId]) this.recentRecordings[userId] = [];
      const replayCheck = detectReplayAttack(
        { embedding: verificationEmbedding, timestamp: Date.now() },
        this.recentRecordings[userId]
      );

      if (replayCheck.isReplay) {
        return {
          success: false,
          provider: 'local-demo',
          isMatch: false,
          error: 'Replay attack suspected',
          confidence: 0,
          failureReason: 'replay_attack',
          replayRisk: replayCheck.replayRisk,
        };
      }

      // Compare embeddings
      const comparisonResult = compareVoiceEmbeddings(
        enrollment.embedding,
        verificationEmbedding,
        0.75 // threshold
      );

      // Track recent recording for replay detection
      this.recentRecordings[userId].push({
        embedding: verificationEmbedding,
        timestamp: Date.now(),
      });
      if (this.recentRecordings[userId].length > 10) {
        this.recentRecordings[userId].shift();
      }

      return {
        success: comparisonResult.isMatch,
        provider: 'local-demo',
        isMatch: comparisonResult.isMatch,
        confidence: comparisonResult.confidence,
        overallScore: comparisonResult.overallScore,
        threshold: comparisonResult.threshold,
        scoreBreakdown: comparisonResult.scoreBreakdown,
        recommendation: comparisonResult.recommendation,
        failureReason: comparisonResult.isMatch ? null : 'voice_mismatch',
        message: comparisonResult.isMatch ? 'Voice verified' : 'Voice does not match enrollment',
      };
    } catch (e) {
      return {
        success: false,
        provider: 'local-demo',
        error: e.message,
        failureReason: 'processing_error',
      };
    }
  }

  async remove(userId) {
    try {
      sessionStorage.removeItem(`voice_enrollment_${userId}`);
      if (this.recentRecordings[userId]) delete this.recentRecordings[userId];
      return { success: true, provider: 'local-demo' };
    } catch (e) {
      return { success: false, provider: 'local-demo', error: e.message };
    }
  }

  getStatus(userId) {
    const enrollment = getVoiceEnrollment(userId);
    return {
      isEnrolled: !!enrollment,
      enrolledAt: enrollment?.enrolledAt || null,
      provider: 'local-demo',
      version: enrollment?.enrollmentVersion || null,
    };
  }

  _hashPassphrase(passphrase) {
    let hash = 0;
    for (let i = 0; i < passphrase.length; i++) {
      const char = passphrase.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
}

// ── Azure Speaker Recognition provider stub ─────────────────────────────

class AzureProvider extends VoiceVerificationProvider {
  constructor(config) {
    super('azure');
    this.config = config; // { endpoint, subscriptionKey }
  }

  async enroll(userId, audioBuffer, passphrase) {
    // TODO: Implement Azure Speaker Recognition enrollment
    // https://learn.microsoft.com/en-us/rest/api/speakerrecognition/
    throw new Error('Azure provider not yet implemented');
  }

  async verify(userId, audioBuffer, passphrase) {
    // TODO: Implement Azure Speaker Recognition verification
    throw new Error('Azure provider not yet implemented');
  }

  async remove(userId) {
    throw new Error('Azure provider not yet implemented');
  }

  getStatus(userId) {
    throw new Error('Azure provider not yet implemented');
  }
}

// ── AWS Voice ID provider stub ──────────────────────────────────────────

class AWSProvider extends VoiceVerificationProvider {
  constructor(config) {
    super('aws');
    this.config = config; // { region, accessKeyId, secretAccessKey, domainId }
  }

  async enroll(userId, audioBuffer, passphrase) {
    // TODO: Implement AWS Voice ID enrollment
    // https://docs.aws.amazon.com/voice-id/latest/dg/enrollment.html
    throw new Error('AWS provider not yet implemented');
  }

  async verify(userId, audioBuffer, passphrase) {
    // TODO: Implement AWS Voice ID verification
    throw new Error('AWS provider not yet implemented');
  }

  async remove(userId) {
    throw new Error('AWS provider not yet implemented');
  }

  getStatus(userId) {
    throw new Error('AWS provider not yet implemented');
  }
}

// ── Provider factory & singleton ────────────────────────────────────────

let _currentProvider = new LocalDemoProvider();

export function createProvider(type, config = {}) {
  switch (type) {
    case 'local-demo':
      return new LocalDemoProvider();
    case 'azure':
      return new AzureProvider(config);
    case 'aws':
      return new AWSProvider(config);
    default:
      return new LocalDemoProvider();
  }
}

export function setVoiceProvider(provider) {
  if (!(provider instanceof VoiceVerificationProvider)) {
    throw new Error('Invalid provider');
  }
  _currentProvider = provider;
}

export function getCurrentVoiceProvider() {
  return _currentProvider;
}

// ── High-level API ────────────────────────────────────────────────────

export async function enrollVoice(userId, audioBuffer, passphrase) {
  return _currentProvider.enroll(userId, audioBuffer, passphrase);
}

export async function verifyVoice(userId, audioBuffer, passphrase) {
  return _currentProvider.verify(userId, audioBuffer, passphrase);
}

export async function removeVoiceEnrollment(userId) {
  return _currentProvider.remove(userId);
}

export function getVoiceEnrollmentStatus(userId) {
  return _currentProvider.getStatus(userId);
}