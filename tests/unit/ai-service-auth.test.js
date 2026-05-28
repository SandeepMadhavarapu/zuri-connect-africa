import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  invokeEdgeFunction: vi.fn(),
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: mocks.getSession,
    },
  }),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: mocks.invokeEdgeFunction,
}));

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

describe('Duke AI ai-router auth request behavior', () => {
  beforeEach(async () => {
    mocks.getSession.mockReset();
    mocks.invokeEdgeFunction.mockReset();
    const { _resetAiInFlightForTest } = await import('@/services/aiService.js');
    _resetAiInFlightForTest();
  });

  it('uses the signed-in Supabase session access token for ai-router', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'session-token-abcdefghijklmnopqrstuvwxyz' } },
      error: null,
    });
    mocks.invokeEdgeFunction.mockResolvedValue({ text: 'Hello from Duke AI' });

    const { invokeLlm } = await import('@/services/aiService.js');
    const result = await invokeLlm({ prompt: 'User: hello', model: 'gemini' });

    expect(result).toBe('Hello from Duke AI');
    // Browser-side retries are DISABLED for ai-router so a 429 cannot
    // trigger a retry loop. The router does its own server-side failover.
    expect(mocks.invokeEdgeFunction).toHaveBeenCalledWith(
      'aiRouter',
      { prompt: 'User: hello', response_json_schema: undefined, model: 'gemini' },
      'session-token-abcdefghijklmnopqrstuvwxyz',
      { retry: { retries: 0 } },
    );
  });

  it('never sends undefined, null, or invalid_token as ai-router authorization', async () => {
    const { invokeLlm } = await import('@/services/aiService.js');

    for (const token of [undefined, null, 'invalid_token']) {
      mocks.getSession.mockResolvedValueOnce({
        data: { session: { access_token: token } },
        error: null,
      });
      await expect(invokeLlm({ prompt: 'User: hello' })).rejects.toMatchObject({
        code: token ? 'AI_AUTH_INVALID' : 'AI_AUTH_REQUIRED',
      });
    }

    expect(mocks.invokeEdgeFunction).not.toHaveBeenCalled();
  });

  it('does not reference provider API keys in frontend source', () => {
    const root = resolve(process.cwd(), 'src');
    const source = walkFiles(root)
      .filter((file) => /\.(js|jsx|ts|tsx)$/.test(file))
      .filter((file) => !file.endsWith(join('config', 'envSchema.js')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SERVICE_ROLE_KEY/);
  });
});
