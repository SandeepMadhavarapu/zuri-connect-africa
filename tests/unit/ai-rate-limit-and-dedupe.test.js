/**
 * Duke AI rate-limit and single-call behavior.
 *
 * Verifies:
 *   - One user message → exactly one ai-router request, even for failed
 *     provider routes (no openai→gemini→anthropic loop from the browser).
 *   - Duplicate in-flight calls are deduped at the service layer.
 *   - 429 responses surface a polished cooldown message with retry timing
 *     and never trigger an immediate retry.
 *   - The local fallback runs at most once after a non-rate-limit provider
 *     failure.
 *   - Edge-function-level retry is disabled for ai-router (so a single 429
 *     cannot become three quota-burning calls).
 *   - The ai-router source still does its own server-side provider failover.
 *   - No provider API key references leak into frontend source.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  invokeEdgeFunction: vi.fn(),
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: mocks.getSession },
  }),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: mocks.invokeEdgeFunction,
}));

const validSession = {
  data: { session: { access_token: 'session-token-abcdefghijklmnopqrstuvwxyz' } },
  error: null,
};

beforeEach(async () => {
  mocks.getSession.mockReset();
  mocks.invokeEdgeFunction.mockReset();
  mocks.getSession.mockResolvedValue(validSession);
  vi.resetModules();
  sessionStorage.clear();
  // Silence the failover.js "[AIFailover] Provider ... failed:" warn lines
  // and the orchestrator's debug warns — they are intentional in failure-path
  // tests and add noise to CI output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aiService in-flight dedupe', () => {
  it('two simultaneous invokeLlm calls for the same prompt result in ONE edge call', async () => {
    let resolveInvoke;
    const pending = new Promise((r) => { resolveInvoke = r; });
    mocks.invokeEdgeFunction.mockReturnValue(pending);

    const { invokeLlm } = await import('@/services/aiService.js');
    const a = invokeLlm({ prompt: 'User: hello', model: 'gemini' });
    const b = invokeLlm({ prompt: 'User: hello', model: 'gemini' });

    // Flush microtasks so the first invokeLlm reaches its edge call before
    // resolving — otherwise the dedupe map hasn't been populated yet.
    await new Promise((r) => setTimeout(r, 0));

    resolveInvoke({ text: 'one' });
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('one');
    expect(rb).toBe('one');
    expect(mocks.invokeEdgeFunction).toHaveBeenCalledTimes(1);
  });

  it('different prompts do NOT dedupe and each fire their own edge call', async () => {
    mocks.invokeEdgeFunction.mockResolvedValue({ text: 'ok' });

    const { invokeLlm } = await import('@/services/aiService.js');
    await Promise.all([
      invokeLlm({ prompt: 'User: hi', model: 'gemini' }),
      invokeLlm({ prompt: 'User: explain recursion', model: 'gemini' }),
    ]);

    expect(mocks.invokeEdgeFunction).toHaveBeenCalledTimes(2);
  });
});

describe('aiService rate-limit normalization', () => {
  it('promotes 429 from ai-router to AI_PROVIDER_RATE_LIMITED with retryAfterSeconds', async () => {
    const { ApiError } = await import('@/api/errorHandling.js');
    mocks.invokeEdgeFunction.mockRejectedValue(new ApiError('rate_limited', {
      status: 429,
      code: 'AI_PROVIDER_RATE_LIMITED',
      body: { code: 'AI_PROVIDER_RATE_LIMITED', retryAfterSeconds: 120, retry_after_seconds: 120 },
      retryAfterSeconds: 120,
    }));

    const { invokeLlm } = await import('@/services/aiService.js');
    await expect(invokeLlm({ prompt: 'User: hello' })).rejects.toMatchObject({
      status: 429,
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 120,
    });
  });

  it('does not retry on 429 — invokeLlm calls invokeEdgeFunction exactly once', async () => {
    const { ApiError } = await import('@/api/errorHandling.js');
    mocks.invokeEdgeFunction.mockRejectedValue(new ApiError('rate_limited', {
      status: 429,
      body: { error: 'rate_limited' },
    }));

    const { invokeLlm } = await import('@/services/aiService.js');
    await expect(invokeLlm({ prompt: 'User: hello' })).rejects.toBeDefined();
    expect(mocks.invokeEdgeFunction).toHaveBeenCalledTimes(1);
  });

  it('passes retry:{retries:0} so the api client never retries ai-router from the browser', async () => {
    mocks.invokeEdgeFunction.mockResolvedValue({ text: 'ok' });
    const { invokeLlm } = await import('@/services/aiService.js');
    await invokeLlm({ prompt: 'User: hello', model: 'gemini' });
    const args = mocks.invokeEdgeFunction.mock.calls[0];
    expect(args[3]).toEqual({ retry: { retries: 0 } });
  });
});

describe('failover: one user message → one ai-router call', () => {
  it('a successful provider call does NOT loop through other providers', async () => {
    vi.resetModules();
    vi.doMock('@/services/aiService.js', () => ({
      invokeLlm: vi.fn(async () => '{"type":"answer","message":"hi"}'),
    }));

    const aiServiceMod = await import('@/services/aiService.js');
    const { withFailover } = await import('@/lib/ai/failover.js');

    const result = await withFailover({
      systemPrompt: 'sys',
      userMessage: 'hello',
      context: '',
    }, 'openai');

    expect(result.provider).toBe('openai');
    expect(result.fallbackTriggered).toBe(false);
    expect(aiServiceMod.invokeLlm).toHaveBeenCalledTimes(1);
  });

  it('a 429 from ai-router does NOT trigger gemini/anthropic retries — exactly ONE edge attempt', async () => {
    vi.resetModules();
    const { ApiError } = await import('@/api/errorHandling.js');
    const rateError = new ApiError('AI_PROVIDER_RATE_LIMITED', {
      status: 429,
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 90,
      body: { code: 'AI_PROVIDER_RATE_LIMITED', retryAfterSeconds: 90 },
    });
    const invokeLlmMock = vi.fn(async () => { throw rateError; });
    vi.doMock('@/services/aiService.js', () => ({ invokeLlm: invokeLlmMock }));

    const { withFailover } = await import('@/lib/ai/failover.js');
    const result = await withFailover({
      systemPrompt: 'sys',
      userMessage: 'hello',
      context: '',
    }, 'gemini');

    expect(invokeLlmMock).toHaveBeenCalledTimes(1);
    expect(result.rateLimited).toBe(true);
    expect(result.error).toBe(true);
    expect(result.retryAfterSeconds).toBe(90);
    expect(result.provider).toBe('rate_limited');
    expect(result.response).toMatch(/cooling down/i);
  });

  it('a 429 does NOT invoke the local deterministic fallback', async () => {
    vi.resetModules();
    const { ApiError } = await import('@/api/errorHandling.js');
    const invokeLlmMock = vi.fn(async () => {
      throw new ApiError('rate_limited', {
        status: 429,
        code: 'rate_limited',
        body: { error: 'rate_limited' },
      });
    });
    vi.doMock('@/services/aiService.js', () => ({ invokeLlm: invokeLlmMock }));

    const localMock = vi.fn(async () => 'should not run');
    vi.doMock('@/lib/ai/providers/localFallbackProvider', () => ({
      generateResponse: localMock,
    }));
    vi.doMock('@/lib/ai/providers/localFallbackProvider.js', () => ({
      generateResponse: localMock,
    }));

    const { withFailover } = await import('@/lib/ai/failover.js');
    const result = await withFailover({
      systemPrompt: 'sys',
      userMessage: 'hello',
      context: '',
    }, 'openai');

    expect(localMock).not.toHaveBeenCalled();
    expect(result.rateLimited).toBe(true);
  });

  it('a generic provider failure runs the local fallback EXACTLY ONCE', async () => {
    vi.resetModules();
    const { ApiError } = await import('@/api/errorHandling.js');
    const invokeLlmMock = vi.fn(async () => {
      throw new ApiError('AI_PROVIDER_UNAVAILABLE', {
        status: 502,
        code: 'AI_PROVIDER_UNAVAILABLE',
        body: { code: 'AI_PROVIDER_UNAVAILABLE' },
      });
    });
    vi.doMock('@/services/aiService.js', () => ({ invokeLlm: invokeLlmMock }));

    const localMock = vi.fn(async () => 'local answer');
    vi.doMock('@/lib/ai/providers/localFallbackProvider', () => ({
      generateResponse: localMock,
    }));

    const { withFailover } = await import('@/lib/ai/failover.js');
    const result = await withFailover({
      systemPrompt: 'sys',
      userMessage: 'hello',
      context: '',
    }, 'openai');

    expect(invokeLlmMock).toHaveBeenCalledTimes(1);
    expect(localMock).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('local');
    expect(result.fallbackTriggered).toBe(true);
    expect(result.response).toBe('local answer');
  });

  it('an auth failure short-circuits with the secure sign-in message — no local fallback', async () => {
    vi.resetModules();
    const { ApiError } = await import('@/api/errorHandling.js');
    const invokeLlmMock = vi.fn(async () => {
      throw new ApiError('AI_AUTH_REQUIRED', { status: 401, code: 'AI_AUTH_REQUIRED' });
    });
    vi.doMock('@/services/aiService.js', () => ({ invokeLlm: invokeLlmMock }));
    const localMock = vi.fn(async () => 'nope');
    vi.doMock('@/lib/ai/providers/localFallbackProvider', () => ({
      generateResponse: localMock,
    }));

    const { withFailover } = await import('@/lib/ai/failover.js');
    const result = await withFailover({
      systemPrompt: 'sys',
      userMessage: 'hello',
      context: '',
    }, 'openai');

    expect(localMock).not.toHaveBeenCalled();
    expect(result.authError).toBe(true);
    expect(result.response).toMatch(/sign in again so Duke AI/i);
  });
});

describe('orchestrator surfaces rate-limit metadata with polished copy', () => {
  it('formats retryAfterSeconds into a minute-rounded message', async () => {
    vi.resetModules();
    vi.doMock('@/lib/ai/failover', () => ({
      withFailover: vi.fn(async () => ({
        response: 'placeholder',
        provider: 'rate_limited',
        latency: 5,
        fallbackTriggered: false,
        error: true,
        rateLimited: true,
        retryAfterSeconds: 180,
        code: 'AI_PROVIDER_RATE_LIMITED',
      })),
    }));

    const { routeAIRequest } = await import('@/lib/ai/orchestrator.js');
    const result = await routeAIRequest({
      type: 'general',
      user: { email: 'maria@example.com' },
      message: 'Hi',
      context: { conversationMessages: [] },
    });

    expect(result.rateLimited).toBe(true);
    expect(result.response).toMatch(/cooling down/i);
    expect(result.response).toMatch(/about 3 minutes/);
  });

  it('falls back to the generic cooldown message when no retryAfterSeconds is provided', async () => {
    vi.resetModules();
    vi.doMock('@/lib/ai/failover', () => ({
      withFailover: vi.fn(async () => ({
        response: 'placeholder',
        provider: 'rate_limited',
        latency: 5,
        fallbackTriggered: false,
        error: true,
        rateLimited: true,
        code: 'rate_limited',
      })),
    }));

    const { routeAIRequest } = await import('@/lib/ai/orchestrator.js');
    const result = await routeAIRequest({
      type: 'general',
      user: { email: 'maria@example.com' },
      message: 'Hi',
      context: { conversationMessages: [] },
    });

    expect(result.response).toMatch(/Try again shortly/i);
  });
});

describe('source-level guards', () => {
  function source(file) {
    return readFileSync(resolve(process.cwd(), file), 'utf8');
  }

  function walkFiles(dir) {
    const result = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) result.push(...walkFiles(full));
      else result.push(full);
    }
    return result;
  }

  it('failover.js no longer cycles through openai/gemini/anthropic via ai-router', () => {
    const text = source('src/lib/ai/failover.js');
    // No iteration that hits ai-router for each provider per message.
    expect(text).not.toMatch(/for\s*\(\s*let\s+i\s*=\s*0[\s\S]*PROVIDERS\[/);
    expect(text).not.toMatch(/PROVIDERS\s*=\s*\[\s*\{\s*name:\s*'gemini'[\s\S]*name:\s*'openai'[\s\S]*name:\s*'anthropic'/);
    // It still short-circuits on auth, rate-limit, and runs local once.
    expect(text).toMatch(/RATE_LIMIT_CODES/);
    expect(text).toMatch(/AI_PROVIDER_RATE_LIMITED/);
    expect(text).toMatch(/AUTH_ERROR_CODES/);
    expect(text).toMatch(/AI_AUTH_REQUIRED/);
    expect(text).toMatch(/Please sign in again so Duke AI/);
  });

  it('api client retry policy excludes 429 from default retries', () => {
    const text = source('src/api/client.js');
    expect(text).toMatch(/shouldRetry/);
    // 429 must not be in the default retry set.
    const defaultRetryBlock = text.match(/DEFAULT_RETRY\s*=\s*\{[\s\S]*?\};/);
    expect(defaultRetryBlock?.[0]).toBeDefined();
    expect(defaultRetryBlock?.[0]).not.toMatch(/429/);
    expect(text).toMatch(/options\.retry/);
  });

  it('aiService disables retries on the ai-router edge call', () => {
    const text = source('src/services/aiService.js');
    expect(text).toMatch(/retry:\s*\{\s*retries:\s*0\s*\}/);
    expect(text).toMatch(/dedupeKey/);
    expect(text).toMatch(/inFlight/);
  });

  it('ai-router preserves server-side provider failover and emits AI_PROVIDER_RATE_LIMITED with Retry-After', () => {
    const text = source('supabase/functions/ai-router/index.ts');
    expect(text).toMatch(/usedProvider !== 'openai'/);
    expect(text).toMatch(/callOpenAI\(/);
    expect(text).toMatch(/AI_PROVIDER_RATE_LIMITED/);
    expect(text).toMatch(/'Retry-After'/);
    expect(text).toMatch(/retry_after_seconds/);
    // Polished cooldown copy.
    expect(text).toMatch(/cooling down for a moment/i);
  });

  it('frontend source never references provider API keys or direct provider URLs', () => {
    const root = resolve(process.cwd(), 'src');
    const text = walkFiles(root)
      .filter((file) => /\.(js|jsx|ts|tsx)$/.test(file))
      .filter((file) => !file.endsWith(join('config', 'envSchema.js')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SERVICE_ROLE_KEY/);
    expect(text).not.toMatch(/api\.openai\.com\/v1|api\.anthropic\.com\/v1|generativelanguage\.googleapis\.com/);
  });
});
