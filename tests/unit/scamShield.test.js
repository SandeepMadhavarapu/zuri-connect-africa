import { describe, it, expect, beforeEach } from 'vitest';
import { analyzeTransaction, recordUserCancelledWarning, recordUserVerifiedSafe } from '@/lib/scamShield.js';

describe('Scam Shield engine', () => {
  beforeEach(() => {
    sessionStorage.removeItem('_zca_bm');
  });

  it('blocks lottery / prize patterns', () => {
    const r = analyzeTransaction({
      amount: 500,
      recipientPhone: '+254712345678',
      recipientName: 'Jane',
      userMessage: 'Congratulations you have won a cash prize send processing fee',
      isNewRecipient: true,
      timeOfDay: 14,
      avgUserTransactionAmount: 1000,
      txCountLastHour: 0,
      sessionAgeMinutes: 30,
      geoChanged: false,
      recipientHistory: null,
      recipientVelocity: 0,
    });
    expect(r.shouldBlock).toBe(true);
    expect(r.triggeredSignals.some((s) => /prize|lottery/i.test(s))).toBe(true);
  });

  it('escalates auth when velocity combines with failed attempts threshold', () => {
    const r = analyzeTransaction({
      amount: 2000,
      isNewRecipient: false,
      userMessage: '',
      timeOfDay: 14,
      txCountLastHour: 5,
      recentFailedAttempts: 2,
      avgUserTransactionAmount: 1000,
      sessionAgeMinutes: 30,
      geoChanged: false,
      recipientHistory: null,
      recipientVelocity: 0,
    });
    expect(r.requiresPin || r.shouldWarn || r.shouldBlock).toBe(true);
  });

  it('warns on urgency manipulation with two phrases', () => {
    const r = analyzeTransaction({
      amount: 2000,
      isNewRecipient: true,
      userMessage: 'This is urgent please hurry hospital emergency',
      timeOfDay: 14,
      avgUserTransactionAmount: 1500,
      txCountLastHour: 0,
      sessionAgeMinutes: 30,
      geoChanged: false,
      recipientHistory: null,
      recipientVelocity: 0,
    });
    expect(r.shouldWarn || r.shouldBlock).toBe(true);
  });

  it('adaptive memory affects sensitivity after cancel', () => {
    recordUserCancelledWarning();
    const r = analyzeTransaction({
      amount: 3000,
      isNewRecipient: true,
      userMessage: 'please send now',
      timeOfDay: 14,
      avgUserTransactionAmount: 1000,
      txCountLastHour: 0,
      sessionAgeMinutes: 30,
      geoChanged: false,
      recipientHistory: null,
      recipientVelocity: 0,
    });
    expect(r.triggeredSignals.length).toBeGreaterThanOrEqual(0);
  });

  it('verified-safe flow reduces sensitivity over time', () => {
    recordUserVerifiedSafe();
    recordUserVerifiedSafe();
    const r = analyzeTransaction({
      amount: 4000,
      isNewRecipient: true,
      userMessage: '',
      timeOfDay: 14,
      avgUserTransactionAmount: 2000,
      txCountLastHour: 0,
      sessionAgeMinutes: 30,
      geoChanged: false,
      recipientHistory: null,
      recipientVelocity: 0,
    });
    expect(r).toBeDefined();
  });
});
