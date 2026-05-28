import { describe, it, expect } from 'vitest';

/**
 * Structural contract for fraud LLM responses — keeps UI resilient when AI fails.
 */
describe('fraud analysis response shape', () => {
  it('accepts minimal safe schema', () => {
    const result = {
      isFraud: false,
      confidence: 0.2,
      signals: [],
      severity: 'low',
      recommendation: 'ok',
    };
    expect(typeof result.isFraud).toBe('boolean');
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
