import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AIProviderError,
  publicCodeForStatus,
} from '../../supabase/functions/_shared/ai-provider-errors.ts';
import {
  buildGeminiEndpoint,
  callGemini,
  callGeminiWithModelFailover,
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  GEMINI_DEFAULT_MODEL,
  GEMINI_MODEL_FALLBACK_CHAIN,
  parseGeminiText,
  resolveGeminiModel,
} from '../../supabase/functions/_shared/gemini-provider.ts';

const FAKE_KEY = 'fake-gemini-key-AAA1111-do-not-log';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('Gemini default model and endpoint', () => {
  it('defaults to gemini-2.0-flash (current supported text model)', () => {
    expect(GEMINI_DEFAULT_MODEL).toBe('gemini-2.0-flash');
    expect(resolveGeminiModel({})).toBe('gemini-2.0-flash');
    expect(resolveGeminiModel(undefined)).toBe('gemini-2.0-flash');
  });

  it('respects GEMINI_MODEL env override when provided', () => {
    expect(resolveGeminiModel({ GEMINI_MODEL: 'gemini-2.0-flash-lite' }))
      .toBe('gemini-2.0-flash-lite');
    expect(resolveGeminiModel({ GEMINI_MODEL: '  custom-model  ' }))
      .toBe('custom-model');
    expect(resolveGeminiModel({ GEMINI_MODEL: '' }))
      .toBe('gemini-2.0-flash');
  });

  it('uses the v1beta generateContent endpoint format', () => {
    const url = buildGeminiEndpoint('gemini-2.0-flash', FAKE_KEY);
    expect(GEMINI_API_VERSION).toBe('v1beta');
    expect(GEMINI_API_BASE).toBe('https://generativelanguage.googleapis.com');
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(FAKE_KEY)}`,
    );
    expect(url).toMatch(/:generateContent\?/);
  });

  it('lists a safe model fallback chain (no removed-from-API-only entries)', () => {
    expect(GEMINI_MODEL_FALLBACK_CHAIN[0]).toBe('gemini-2.0-flash');
    expect(GEMINI_MODEL_FALLBACK_CHAIN).toContain('gemini-2.0-flash-lite');
  });
});

describe('parseGeminiText', () => {
  it('extracts text from candidates[0].content.parts[0].text', () => {
    expect(parseGeminiText({
      candidates: [{ content: { parts: [{ text: 'Hello world' }] } }],
    })).toBe('Hello world');
  });

  it('joins multiple text parts safely', () => {
    const text = parseGeminiText({
      candidates: [{
        content: {
          parts: [
            { text: 'Hello ' },
            { text: 'world' },
            { text: '!' },
          ],
        },
      }],
    });
    expect(text).toBe('Hello world!');
  });

  it('ignores non-string parts (e.g. inlineData chunks)', () => {
    const text = parseGeminiText({
      candidates: [{
        content: {
          parts: [
            { text: 'Hi ' },
            { inlineData: { mimeType: 'image/png', data: 'abc' } },
            { text: 'there' },
          ],
        },
      }],
    });
    expect(text).toBe('Hi there');
  });

  it('returns empty string on missing/empty candidates', () => {
    expect(parseGeminiText({})).toBe('');
    expect(parseGeminiText({ candidates: [] })).toBe('');
    expect(parseGeminiText({ candidates: [{}] })).toBe('');
    expect(parseGeminiText({ candidates: [{ content: {} }] })).toBe('');
    expect(parseGeminiText({ candidates: [{ content: { parts: [] } }] })).toBe('');
    expect(parseGeminiText(null)).toBe('');
    expect(parseGeminiText(undefined)).toBe('');
  });
});

describe('callGemini', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('returns text from a valid Gemini response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Recursion is when a function calls itself.' }] } }],
    }));
    const text = await callGemini('User: explain recursion', { apiKey: FAKE_KEY, fetchImpl });
    expect(text).toBe('Recursion is when a function calls itself.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/v1beta\/models\/gemini-2\.0-flash:generateContent\?key=/);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(typeof init.body).toBe('string');
  });

  it('maps Gemini 404 to AI_PROVIDER_MODEL_NOT_FOUND with detail=model_not_found', async () => {
    const fetchImpl = vi.fn(async () => textResponse('{"error":{"code":404,"message":"model not found"}}', 404));
    await expect(callGemini('hi', { apiKey: FAKE_KEY, model: 'gemini-bogus', fetchImpl }))
      .rejects.toMatchObject({
        name: 'AIProviderError',
        provider: 'gemini',
        model: 'gemini-bogus',
        status: 404,
        publicCode: 'AI_PROVIDER_MODEL_NOT_FOUND',
        detail: 'model_not_found',
      });
  });

  it('maps malformed JSON Gemini response to AI_PROVIDER_BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(callGemini('hi', { apiKey: FAKE_KEY, fetchImpl }))
      .rejects.toMatchObject({
        name: 'AIProviderError',
        provider: 'gemini',
        publicCode: 'AI_PROVIDER_BAD_RESPONSE',
        detail: 'malformed_response',
      });
  });

  it('maps empty candidates list to AI_PROVIDER_BAD_RESPONSE with detail=empty_candidates', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [] }));
    await expect(callGemini('hi', { apiKey: FAKE_KEY, fetchImpl }))
      .rejects.toMatchObject({
        name: 'AIProviderError',
        provider: 'gemini',
        publicCode: 'AI_PROVIDER_BAD_RESPONSE',
        detail: 'empty_candidates',
      });
  });

  it('maps candidates with no text parts to AI_PROVIDER_BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: '   ' }] } }],
    }));
    await expect(callGemini('hi', { apiKey: FAKE_KEY, fetchImpl }))
      .rejects.toMatchObject({
        name: 'AIProviderError',
        publicCode: 'AI_PROVIDER_BAD_RESPONSE',
      });
  });

  it('maps a network failure (rejected fetch) to AI_PROVIDER_TIMEOUT', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    await expect(callGemini('hi', { apiKey: FAKE_KEY, fetchImpl }))
      .rejects.toMatchObject({
        publicCode: 'AI_PROVIDER_TIMEOUT',
        status: 504,
      });
  });

  it('never logs API key or full provider URL on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }));
    await callGemini('hi', { apiKey: FAKE_KEY, fetchImpl });
    const logged = consoleErrorSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(logged).not.toContain(FAKE_KEY);
  });

  it('uses the configured model from opts when provided', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }));
    await callGemini('hi', { apiKey: FAKE_KEY, model: 'gemini-2.0-flash-lite', fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/models\/gemini-2\.0-flash-lite:generateContent/);
  });
});

describe('callGeminiWithModelFailover', () => {
  it('falls back to the next model in the chain on 404 and reports the model used', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(url);
      if (url.includes('gemini-1.5-flash')) {
        return textResponse('{"error":"not found"}', 404);
      }
      if (url.includes('gemini-2.0-flash-lite')) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'answer from lite' }] } }],
        });
      }
      return textResponse('{"error":"not found"}', 404);
    });

    const result = await callGeminiWithModelFailover('hi', {
      apiKey: FAKE_KEY,
      model: 'gemini-1.5-flash',
      fetchImpl,
    });
    expect(result.text).toBe('answer from lite');
    expect(result.model).toBe('gemini-2.0-flash-lite');
    expect(calls.some((u) => u.includes('gemini-1.5-flash'))).toBe(true);
    expect(calls.some((u) => u.includes('gemini-2.0-flash-lite'))).toBe(true);
  });

  it('throws AI_PROVIDER_MODEL_NOT_FOUND if every model in the chain returns 404', async () => {
    const fetchImpl = vi.fn(async () => textResponse('{"error":"not found"}', 404));
    await expect(callGeminiWithModelFailover('hi', {
      apiKey: FAKE_KEY,
      model: 'gemini-2.0-flash',
      fetchImpl,
    })).rejects.toMatchObject({
      publicCode: 'AI_PROVIDER_MODEL_NOT_FOUND',
      provider: 'gemini',
    });
  });

  it('does not retry on non-404 provider errors', async () => {
    const fetchImpl = vi.fn(async () => textResponse('{"error":"unauthorized"}', 401));
    await expect(callGeminiWithModelFailover('hi', {
      apiKey: FAKE_KEY,
      model: 'gemini-2.0-flash',
      fetchImpl,
    })).rejects.toMatchObject({
      publicCode: 'AI_PROVIDER_AUTH_FAILED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('ai-router source-level Gemini wiring', () => {
  function source(file) {
    return readFileSync(resolve(process.cwd(), file), 'utf8');
  }

  it('ai-router imports the shared Gemini provider module (no inline model literal)', () => {
    const router = source('supabase/functions/ai-router/index.ts');
    expect(router).toMatch(/from '\.\.\/_shared\/gemini-provider\.ts'/);
    expect(router).toMatch(/callGeminiWithModelFailover/);
    expect(router).not.toMatch(/const model = 'gemini-1\.5-flash'/);
  });

  it('ai-router still uses GEMINI_API_KEY via Deno.env (no client exposure)', () => {
    const router = source('supabase/functions/ai-router/index.ts');
    expect(router).toMatch(/Deno\.env\.get\('GEMINI_API_KEY'\)/);
    expect(router).toMatch(/Deno\.env\.get\('GEMINI_MODEL'\)/);
  });

  it('ai-router declares GEMINI_MODEL as an optional Edge Function env var', () => {
    const router = source('supabase/functions/ai-router/index.ts');
    expect(router).toMatch(/optional:\s*\[[^\]]*'GEMINI_MODEL'[^\]]*\]/);
  });

  it('AI_PROVIDER_MODEL_NOT_FOUND is exposed by the shared error module', () => {
    const errors = source('supabase/functions/_shared/ai-provider-errors.ts');
    expect(errors).toMatch(/AI_PROVIDER_MODEL_NOT_FOUND/);
    expect(publicCodeForStatus(404)).toBe('AI_PROVIDER_MODEL_NOT_FOUND');
    const err = new AIProviderError('gemini', 'gemini-2.0-flash', 404, 'AI_PROVIDER_MODEL_NOT_FOUND', 'model_not_found');
    expect(err.publicCode).toBe('AI_PROVIDER_MODEL_NOT_FOUND');
    expect(err.detail).toBe('model_not_found');
  });
});

describe('Gemini source safety (no provider key leakage)', () => {
  function source(file) {
    return readFileSync(resolve(process.cwd(), file), 'utf8');
  }

  it('gemini-provider does not console.log the API key or the full request body', () => {
    const text = source('supabase/functions/_shared/gemini-provider.ts');
    expect(text).not.toMatch(/console\.(log|info|debug|warn|error)\([^)]*apiKey/);
    expect(text).not.toMatch(/console\.(log|info|debug|warn|error)\([^)]*req\.body/);
  });

  it('smoke:ai-router script does not print provider API keys', () => {
    const text = source('scripts/ai-router-smoke.mjs');
    expect(text).not.toMatch(/GEMINI_API_KEY[^|)\s]*\s*\}|\$\{[^}]*API_KEY[^}]*\}/);
    expect(text).toMatch(/configured/);
    expect(text).toMatch(/model/);
    expect(text).toMatch(/provider/);
  });
});
