import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  buildProviderPrompt,
  classifyAIRequest,
  policyFallbackResponse,
  redactSensitiveText,
  summarizeForAudit,
  validateModelActionResponse,
  type AIActionPolicyResult,
  type AIActionResponse,
} from '../_shared/ai-action-policy.ts';
import {
  AIProviderError,
  type AIProviderErrorDetail,
  type AIProviderPublicCode,
  publicCodeForStatus,
} from '../_shared/ai-provider-errors.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import {
  callGeminiWithModelFailover,
  GEMINI_API_VERSION,
  resolveGeminiModel,
} from '../_shared/gemini-provider.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
if (!APP_ORIGIN) console.warn('[ai-router] APP_ORIGIN not set - CORS locked down');

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
};

const MAX_PROMPT_CHARS = 4000;
const AI_REQUESTS_PER_HOUR = 30;
const PROVIDER_TIMEOUT_MS = 15000;

async function auditLog(
  supabase: ReturnType<typeof createClient>,
  payload: { user_id?: string; model?: string; correlation_id?: string; prompt_len: number; status: string; provider?: string }
): Promise<void> {
  const { error } = await supabase.from('ai_sessions').insert({
    user_id: payload.user_id ?? null,
    model: payload.model ?? 'unknown',
    correlation_id: payload.correlation_id ?? null,
    tokens_in: payload.prompt_len,
    tokens_out: null,
    provider: payload.provider ?? 'unknown',
  });
  if (error) console.error('[ai-router] auditLog insert failed:', error.message);
}

async function securityLog(
  supabase: ReturnType<typeof createClient>,
  payload: {
    user_id: string;
    event_type: string;
    severity?: 'info' | 'warn' | 'critical';
    action?: string;
    outcome?: string;
    prompt?: string;
    policy?: AIActionPolicyResult;
    response?: AIActionResponse;
  }
): Promise<void> {
  const { error } = await supabase.from('security_events').insert({
    user_id: payload.user_id,
    event_type: payload.event_type,
    severity: payload.severity ?? 'info',
    action: payload.action ?? 'ai_policy',
    outcome: payload.outcome ?? 'logged',
    payload: {
      prompt_summary: summarizeForAudit(payload.prompt ?? ''),
      classification: payload.policy?.classification,
      forbidden_reason: payload.policy?.forbidden_reason,
      prompt_injection: payload.policy?.prompt_injection ?? false,
      proposed_action_type: payload.response?.proposed_action?.action_type,
      requires_confirmation: payload.response?.proposed_action?.requires_confirmation,
      requires_step_up: payload.response?.proposed_action?.requires_step_up,
    },
  });
  if (error) console.error('[ai-router] security_events insert failed:', error.message);
}

function detectProvider(modelHint: string): 'anthropic' | 'gemini' | 'openai' {
  const h = modelHint.toLowerCase();
  if (h.includes('claude')) return 'anthropic';
  if (h.includes('gemini')) return 'gemini';
  return 'openai';
}

function logProviderDiagnostic(
  event: string,
  details: {
    provider: string;
    model: string;
    status?: number;
    publicCode: AIProviderPublicCode;
    detail?: AIProviderErrorDetail;
    apiVersion?: string;
    retryAfterSeconds?: number;
  }
) {
  // Sanitized server-side diagnostic. Never includes the API key, prompt
  // body, raw provider response, Authorization headers, or user PII.
  console.error('[ai-router]', event, {
    provider: details.provider,
    model: details.model,
    api_version: details.apiVersion,
    status: details.status ?? 0,
    public_error_code: details.publicCode,
    detail: details.detail,
    retry_after_seconds: details.retryAfterSeconds,
  });
}

function providerErrorResponse(error: AIProviderError, status = 502) {
  // `detail` is a non-secret diagnostic enum (e.g. "model_not_found") that
  // helps the frontend show a precise message without exposing API keys,
  // raw provider responses, or internal endpoints.
  const isRateLimited = error.publicCode === 'AI_PROVIDER_RATE_LIMITED';
  const retryAfterSeconds = isRateLimited
    ? (error.retryAfterSeconds ?? 60)
    : error.retryAfterSeconds;
  const headers: Record<string, string> = { ...corsHeaders };
  if (Number.isFinite(retryAfterSeconds) && (retryAfterSeconds as number) > 0) {
    headers['Retry-After'] = String(retryAfterSeconds);
  }
  return Response.json(
    {
      error: error.publicCode,
      code: error.publicCode,
      provider: error.provider,
      status: error.status,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(Number.isFinite(retryAfterSeconds) && (retryAfterSeconds as number) > 0
        ? { retry_after_seconds: retryAfterSeconds, retryAfterSeconds }
        : {}),
      message: isRateLimited
        ? 'Duke AI is cooling down for a moment. Try again shortly.'
        : 'Duke AI provider is not available right now.',
    },
    { status, headers }
  );
}

function authErrorResponse(code: 'AI_AUTH_REQUIRED' | 'AI_AUTH_INVALID') {
  return Response.json(
    {
      error: code,
      code,
      message: 'Please sign in again so Duke AI can respond securely.',
    },
    { status: 401, headers: corsHeaders }
  );
}

function timeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

function responseBody(actionResponse: AIActionResponse, parsed: unknown = null) {
  return {
    ...actionResponse,
    text: actionResponse.message,
    parsed: parsed ?? actionResponse,
  };
}

function schemaBlockedFallback(actionResponse: AIActionResponse, policy: AIActionPolicyResult) {
  return {
    isFraud: true,
    confidence: 0.95,
    signals: [policy.forbidden_reason || policy.classification],
    severity: 'high',
    recommendation: actionResponse.message,
  };
}

async function callAnthropic(prompt: string, modelHint: string, apiKey: string): Promise<string> {
  const model = modelHint.toLowerCase().includes('claude') ? 'claude-3-5-haiku-20241022' : modelHint;
  const provider = 'anthropic';
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: timeoutSignal(),
  });
  } catch {
    throw new AIProviderError(provider, model, 504, 'AI_PROVIDER_TIMEOUT');
  }
  if (!res.ok) throw new AIProviderError(provider, model, res.status, publicCodeForStatus(res.status));
  const data = await res.json().catch(() => {
    throw new AIProviderError(provider, model, 502, 'AI_PROVIDER_BAD_RESPONSE');
  });
  const text = data?.content?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new AIProviderError(provider, model, 502, 'AI_PROVIDER_BAD_RESPONSE');
  }
  return text;
}

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  // The configured Gemini model is read from env (GEMINI_MODEL) with a safe
  // default. A built-in fallback chain swaps models when Google returns 404
  // (typically because a legacy alias like gemini-1.5-flash is unavailable
  // for the current API key/version).
  const configuredModel = resolveGeminiModel({ GEMINI_MODEL: Deno.env.get('GEMINI_MODEL') });
  const result = await callGeminiWithModelFailover(prompt, {
    apiKey,
    model: configuredModel,
    signal: timeoutSignal(),
  });
  return result.text;
}

async function callOpenAI(prompt: string, modelHint: string, apiKey: string, schema: unknown): Promise<string> {
  const modelHintLower = modelHint.toLowerCase();
  const model = modelHintLower.includes('claude') || modelHintLower.includes('gemini') ? 'gpt-4o-mini' : modelHint;
  const provider = 'openai';
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      ...(schema ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: timeoutSignal(),
  });
  } catch {
    throw new AIProviderError(provider, model, 504, 'AI_PROVIDER_TIMEOUT');
  }
  if (!res.ok) throw new AIProviderError(provider, model, res.status, publicCodeForStatus(res.status));
  const data = await res.json().catch(() => {
    throw new AIProviderError(provider, model, 502, 'AI_PROVIDER_BAD_RESPONSE');
  });
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new AIProviderError(provider, model, 502, 'AI_PROVIDER_BAD_RESPONSE');
  }
  return text;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  // At least ONE AI provider key must be configured. Providers are optional
  // individually, but the function cannot operate without any.
  const envCheck = requireFunctionEnv({
    functionName: 'ai-router',
    required:       ['APP_ORIGIN'],
    optional:       ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'OPENAI_API_KEY'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const geminiKey = Deno.env.get('GEMINI_API_KEY') ?? '';
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

  if (!anthropicKey && !geminiKey && !openaiKey) {
    const err = new AIProviderError('none', 'none', 503, 'AI_PROVIDER_NOT_CONFIGURED');
    logProviderDiagnostic('provider_not_configured', {
      provider: err.provider,
      model: err.model,
      status: err.status,
      publicCode: err.publicCode,
    });
    return providerErrorResponse(err, 503);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return authErrorResponse('AI_AUTH_REQUIRED');

  const { data: userRes, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    console.warn('[ai-router] auth_failed', { public_error_code: 'AI_AUTH_INVALID' });
    return authErrorResponse('AI_AUTH_INVALID');
  }
  const userId = userRes.user.id;

  const { data: rlResult, error: rlError } = await supabase.rpc('check_rate_limit', {
    p_bucket_key: userId,
    p_bucket_type: 'user',
    p_endpoint: 'ai-router',
    p_max_requests: AI_REQUESTS_PER_HOUR,
    p_window_seconds: 3600,
    p_block_duration_seconds: 0,
  });
  if (rlError || (rlResult as { allowed: boolean })?.allowed === false) {
    const retryAfter = (rlResult as { retry_after_seconds?: number })?.retry_after_seconds ?? 3600;
    // Use the same public code as a provider 429 so the frontend has one
    // path for "cool down". `error: 'rate_limited'` is kept for backwards
    // compatibility with any older clients still listening for it.
    return Response.json(
      {
        error: 'rate_limited',
        code: 'AI_PROVIDER_RATE_LIMITED',
        message: 'Duke AI is cooling down for a moment. Try again shortly.',
        retry_after: retryAfter,
        retry_after_seconds: retryAfter,
        retryAfterSeconds: retryAfter,
      },
      { status: 429, headers: { ...corsHeaders, 'Retry-After': String(retryAfter) } }
    );
  }

  try {
    const body = await req.json();
    const prompt = String(body?.prompt ?? '').slice(0, MAX_PROMPT_CHARS);
    const modelHint = String(body?.model ?? 'gpt-4o-mini');
    const schema = body?.response_json_schema;
    const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID();

    if (!prompt.trim()) {
      return Response.json({ error: 'Empty prompt' }, { status: 400, headers: corsHeaders });
    }

    const policy = classifyAIRequest(prompt);
    const wantsActionResponse = !schema;

    if (policy.classification === 'forbidden_action') {
      const blocked = policyFallbackResponse(policy);
      await securityLog(supabase, {
        user_id: userId,
        event_type: policy.prompt_injection ? 'ai.prompt_injection.blocked' : 'ai.action.blocked',
        severity: policy.prompt_injection ? 'critical' : 'warn',
        action: 'block_ai_request',
        outcome: 'denied',
        prompt,
        policy,
        response: blocked,
      });
      await auditLog(supabase, { user_id: userId, model: modelHint, correlation_id: correlationId, prompt_len: prompt.length, status: 'blocked', provider: 'policy' });
      return Response.json(
        wantsActionResponse ? responseBody(blocked) : { text: blocked.message, parsed: schemaBlockedFallback(blocked, policy) },
        { headers: corsHeaders }
      );
    }

    const targetProvider = detectProvider(modelHint);
    const providerPrompt = wantsActionResponse ? buildProviderPrompt(prompt, policy) : redactSensitiveText(prompt);
    let text = '';
    let usedProvider = targetProvider;

    try {
      if (targetProvider === 'anthropic' && anthropicKey) {
        text = await callAnthropic(providerPrompt, modelHint, anthropicKey);
      } else if (targetProvider === 'gemini' && geminiKey) {
        text = await callGemini(providerPrompt, geminiKey);
      } else if (targetProvider === 'openai' && openaiKey) {
        text = await callOpenAI(providerPrompt, modelHint, openaiKey, wantsActionResponse ? { type: 'object' } : schema);
      } else if (geminiKey) {
        usedProvider = 'gemini';
        text = await callGemini(providerPrompt, geminiKey);
      } else if (openaiKey) {
        usedProvider = 'openai';
        text = await callOpenAI(providerPrompt, modelHint, openaiKey, wantsActionResponse ? { type: 'object' } : schema);
      } else if (anthropicKey) {
        usedProvider = 'anthropic';
        text = await callAnthropic(providerPrompt, modelHint, anthropicKey);
      } else {
        await auditLog(supabase, { user_id: userId, model: modelHint, correlation_id: correlationId, prompt_len: prompt.length, status: 'no_key', provider: 'none' });
        const err = new AIProviderError('none', modelHint, 503, 'AI_PROVIDER_NOT_CONFIGURED');
        logProviderDiagnostic('provider_not_configured', {
          provider: err.provider,
          model: err.model,
          status: err.status,
          publicCode: err.publicCode,
        });
        return providerErrorResponse(err, 503);
      }
    } catch (providerError) {
      const err = providerError instanceof AIProviderError
        ? providerError
        : new AIProviderError(usedProvider, modelHint, 502, 'AI_PROVIDER_UNAVAILABLE');
      logProviderDiagnostic('provider_failed', {
        provider: err.provider,
        model: err.model,
        status: err.status,
        publicCode: err.publicCode,
        detail: err.detail,
        apiVersion: err.provider === 'gemini' ? GEMINI_API_VERSION : undefined,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      if (usedProvider !== 'openai' && openaiKey) {
        usedProvider = 'openai';
        try {
          text = await callOpenAI(providerPrompt, 'gpt-4o-mini', openaiKey, wantsActionResponse ? { type: 'object' } : schema);
        } catch (fallbackError) {
          const finalErr = fallbackError instanceof AIProviderError
            ? fallbackError
            : new AIProviderError('openai', 'gpt-4o-mini', 502, 'AI_PROVIDER_UNAVAILABLE');
          logProviderDiagnostic('provider_fallback_failed', {
            provider: finalErr.provider,
            model: finalErr.model,
            status: finalErr.status,
            publicCode: finalErr.publicCode,
            detail: finalErr.detail,
          });
          await auditLog(supabase, { user_id: userId, model: modelHint, correlation_id: correlationId, prompt_len: prompt.length, status: finalErr.publicCode, provider: finalErr.provider });
          return providerErrorResponse(finalErr, finalErr.status >= 400 && finalErr.status < 600 ? finalErr.status : 502);
        }
      } else {
        await auditLog(supabase, { user_id: userId, model: modelHint, correlation_id: correlationId, prompt_len: prompt.length, status: err.publicCode, provider: err.provider });
        return providerErrorResponse(err, err.status >= 400 && err.status < 600 ? err.status : 502);
      }
    }

    let parsed: unknown = null;
    if (schema && !wantsActionResponse) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    await auditLog(supabase, { user_id: userId, model: modelHint, correlation_id: correlationId, prompt_len: prompt.length, status: 'ok', provider: usedProvider });

    if (!wantsActionResponse) return Response.json({ text, parsed }, { headers: corsHeaders });

    const actionResponse = validateModelActionResponse(text, policy);
    if (actionResponse.type === 'action_proposal') {
      await securityLog(supabase, {
        user_id: userId,
        event_type: actionResponse.proposed_action?.action_type === 'send_money' || policy.classification === 'financial_action'
          ? 'ai.financial_action.proposed'
          : 'ai.action.proposed',
        severity: policy.classification === 'financial_action' ? 'warn' : 'info',
        action: 'return_action_proposal',
        outcome: 'pending_user_confirmation',
        prompt,
        policy,
        response: actionResponse,
      });
    }

    return Response.json(responseBody(actionResponse), { headers: corsHeaders });
  } catch (error) {
    console.error('[ai-router] Unhandled error:', error);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
});
