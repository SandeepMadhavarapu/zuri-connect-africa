import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file) {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

describe('Duke AI auth routing guards', () => {
  it('ai-router maps missing and invalid JWTs to public auth codes', () => {
    const router = source('supabase/functions/ai-router/index.ts');

    expect(router).toMatch(/authErrorResponse\('AI_AUTH_REQUIRED'\)/);
    expect(router).toMatch(/authErrorResponse\('AI_AUTH_INVALID'\)/);
    expect(router).not.toMatch(/Response\.json\(\{\s*error:\s*'invalid_token'/);
  });

  it('failover stops on AI auth failures instead of retrying every provider', () => {
    const failover = source('src/lib/ai/failover.js');

    expect(failover).toMatch(/AUTH_ERROR_CODES/);
    expect(failover).toMatch(/AI_AUTH_REQUIRED/);
    expect(failover).toMatch(/AI_AUTH_INVALID/);
    expect(failover).toMatch(/Please sign in again so Duke AI can respond securely/);
  });

  it('ai-router provider calls stay server-side and use public provider error codes', () => {
    const router = source('supabase/functions/ai-router/index.ts');
    const errors = source('supabase/functions/_shared/ai-provider-errors.ts');

    expect(router).toMatch(/Deno\.env\.get\('GEMINI_API_KEY'\)/);
    expect(router).toMatch(/Deno\.env\.get\('OPENAI_API_KEY'\)/);
    expect(errors).toMatch(/AI_PROVIDER_AUTH_FAILED/);
    expect(errors).toMatch(/AI_PROVIDER_RATE_LIMITED/);
    expect(router + errors).toMatch(/AI_PROVIDER_BAD_RESPONSE/);
  });
});
