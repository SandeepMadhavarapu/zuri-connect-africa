import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIProviderError, publicCodeForStatus } from '../../supabase/functions/_shared/ai-provider-errors.ts';

let capturedPayload;

vi.mock('@/lib/ai/failover', () => ({
  withFailover: vi.fn(async (payload, provider) => {
    capturedPayload = { payload, provider };
    return {
      response: '{"type":"answer","message":"Sure - recursion is when a function calls itself until a stop condition is reached."}',
      provider,
      latency: 12,
      fallbackTriggered: false,
    };
  }),
}));

describe('Duke AI provider routing', () => {
  beforeEach(() => {
    capturedPayload = null;
    sessionStorage.clear();
    localStorage.clear();
  });

  it('general question gets a natural provider-backed answer when provider succeeds', async () => {
    const { routeAIRequest } = await import('@/lib/ai/orchestrator.js');

    const result = await routeAIRequest({
      type: 'general',
      user: { email: 'maria@example.com', full_name: 'Maria Wanjiku' },
      message: 'Explain recursion simply',
      context: { conversationMessages: [] },
    });

    expect(result.provider).toBe('openai');
    expect(result.response).toMatch(/recursion/i);
    expect(capturedPayload.payload.systemPrompt).toMatch(/answer normal general questions naturally/i);
    expect(capturedPayload.payload.systemPrompt).toMatch(/Message classification: general_chat/i);
  });

  it('finance question sends safe app context to the provider instead of bypassing to local only', async () => {
    const { routeAIRequest } = await import('@/lib/ai/orchestrator.js');

    await routeAIRequest({
      type: 'general',
      user: { id: 'user-1', email: 'maria@example.com', full_name: 'Maria Wanjiku', phone: '+254712345678' },
      message: 'What did I spend most on?',
      context: {
        availableBalance: 8800,
        txHistory: [{ type: 'send', name: 'John Kamau', phone: '+254722222222', amount: -1200, status: 'completed' }],
        budgetSpend: { food: 3880, shopping: 3200 },
        conversationMessages: [{ role: 'user', content: 'My OTP is 123456 and token Bearer abcdefghijklmnopqrstuvwxyz123456' }],
      },
    });

    expect(capturedPayload.provider).toBe('openai');
    expect(capturedPayload.payload.systemPrompt).toMatch(/Message classification: finance_budget/i);
    expect(capturedPayload.payload.systemPrompt).toMatch(/Available balance: KSh 8,800/i);
    expect(capturedPayload.payload.systemPrompt).toMatch(/Food: KSh 3,880/i);
    expect(capturedPayload.payload.systemPrompt).not.toMatch(/\+254712345678|\+254722222222|123456|abcdefghijklmnopqrstuvwxyz|Bearer/);
  });
});

describe('AI router provider public error codes', () => {
  it('maps provider HTTP status to stable public codes', () => {
    expect(publicCodeForStatus(401)).toBe('AI_PROVIDER_AUTH_FAILED');
    expect(publicCodeForStatus(403)).toBe('AI_PROVIDER_AUTH_FAILED');
    expect(publicCodeForStatus(429)).toBe('AI_PROVIDER_RATE_LIMITED');
    expect(publicCodeForStatus(408)).toBe('AI_PROVIDER_TIMEOUT');
    expect(publicCodeForStatus(504)).toBe('AI_PROVIDER_TIMEOUT');
    expect(publicCodeForStatus(500)).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(publicCodeForStatus(502)).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(publicCodeForStatus(418)).toBe('AI_PROVIDER_BAD_RESPONSE');
  });

  it('represents missing provider keys and malformed provider responses without secrets', () => {
    const missing = new AIProviderError('gemini', 'gemini-1.5-flash', 503, 'AI_PROVIDER_NOT_CONFIGURED');
    const malformed = new AIProviderError('gemini', 'gemini-1.5-flash', 502, 'AI_PROVIDER_BAD_RESPONSE');

    expect(missing.publicCode).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(malformed.publicCode).toBe('AI_PROVIDER_BAD_RESPONSE');
    expect(JSON.stringify(missing)).not.toMatch(/API_KEY|Bearer|sk-|OTP|PIN/i);
  });
});
