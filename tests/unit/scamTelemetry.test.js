import { describe, it, expect, beforeEach } from 'vitest';
import { logScamAttempt, getRecentThreats } from '@/lib/scamTelemetry.js';

describe('scam telemetry', () => {
  beforeEach(() => {
    sessionStorage.removeItem('_zca_telemetry');
  });

  it('records events and lists recent threats', () => {
    logScamAttempt({
      eventType: 'fraud_warning',
      scamCategory: 'urgency',
      triggeredSignals: ['s1'],
      userAction: 'warned',
      recipientPhoneHash: 'h1',
      amountBand: '500-2k',
      deviceAnomalyFlag: false,
      authEscalated: false,
    });
    const recent = getRecentThreats(5);
    expect(recent.length).toBe(1);
    expect(recent[0].eventType).toBe('fraud_warning');
    expect(recent[0].scamCategory).toBe('urgency');
  });

  it('bounded ring buffer', () => {
    for (let i = 0; i < 120; i++) {
      logScamAttempt({
        eventType: 'fraud_warning',
        scamCategory: 'generic',
        triggeredSignals: [],
        userAction: 'warned',
        recipientPhoneHash: `h${i}`,
        amountBand: '<500',
        deviceAnomalyFlag: false,
        authEscalated: false,
      });
    }
    expect(getRecentThreats(200).length).toBeLessThanOrEqual(100);
  });
});
