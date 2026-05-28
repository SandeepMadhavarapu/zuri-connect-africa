import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildAfricaTalkingSmsBody,
  getAfricaTalkingUrl,
  mapProviderStatusToPublicCode,
  normalizeAfricaTalkingEnv,
  providerRecipientAccepted,
  readProviderDiagnostics,
  resolveAfricaTalkingConfig,
} from '../../supabase/functions/_shared/otp-provider-diagnostics.ts';

describe('Africa Talking OTP provider diagnostics', () => {
  it('missing AT_USERNAME fails with a safe misconfigured code', () => {
    expect(resolveAfricaTalkingConfig({
      apiKey: 'at-key',
      atEnv: 'sandbox',
      username: '',
    })).toMatchObject({
      ok: false,
      publicCode: 'SMS_PROVIDER_MISCONFIGURED',
      reason: 'missing_credentials',
      usernamePresent: false,
      apiKeyPresent: true,
    });
  });

  it('missing AT_API_KEY fails with a safe misconfigured code', () => {
    expect(resolveAfricaTalkingConfig({
      apiKey: '',
      atEnv: 'sandbox',
      username: 'sandbox',
    })).toMatchObject({
      ok: false,
      publicCode: 'SMS_PROVIDER_MISCONFIGURED',
      reason: 'missing_credentials',
      usernamePresent: true,
      apiKeyPresent: false,
    });
  });

  it('uses the sandbox Africa Talking SMS URL for sandbox', () => {
    const config = resolveAfricaTalkingConfig({
      apiKey: 'at-key',
      atEnv: 'sandbox',
      username: 'sandbox',
    });

    expect(config).toMatchObject({
      ok: true,
      atEnv: 'sandbox',
      url: 'https://api.sandbox.africastalking.com/version1/messaging',
    });
    expect(getAfricaTalkingUrl('sandbox')).toBe('https://api.sandbox.africastalking.com/version1/messaging');
  });

  it('uses the live Africa Talking SMS URL for live or production', () => {
    expect(resolveAfricaTalkingConfig({
      apiKey: 'at-key',
      atEnv: 'live',
      username: 'zuri',
    })).toMatchObject({
      ok: true,
      atEnv: 'live',
      url: 'https://api.africastalking.com/version1/messaging',
    });
    expect(getAfricaTalkingUrl('live')).toBe('https://api.africastalking.com/version1/messaging');
  });

  it('rejects unknown AT_ENV values as provider misconfiguration', () => {
    expect(resolveAfricaTalkingConfig({
      apiKey: 'at-key',
      atEnv: 'staging-ish',
      username: 'zuri',
    })).toMatchObject({
      ok: false,
      atEnv: 'invalid',
      publicCode: 'SMS_PROVIDER_MISCONFIGURED',
      reason: 'invalid_environment',
    });
  });

  it('builds urlencoded SMS bodies without undefined sender fields', () => {
    const body = buildAfricaTalkingSmsBody({
      username: 'sandbox',
      to: '+254143305099',
      message: 'Your code is 123456',
      from: undefined,
    });

    expect(body.get('username')).toBe('sandbox');
    expect(body.get('to')).toBe('+254143305099');
    expect(body.get('message')).toBe('Your code is 123456');
    expect(body.has('from')).toBe(false);
  });

  it('maps provider HTTP statuses to public safe codes', () => {
    expect(mapProviderStatusToPublicCode(401)).toBe('SMS_PROVIDER_MISCONFIGURED');
    expect(mapProviderStatusToPublicCode(403)).toBe('SMS_PROVIDER_MISCONFIGURED');
    expect(mapProviderStatusToPublicCode(429)).toBe('SMS_PROVIDER_RATE_LIMITED');
    expect(mapProviderStatusToPublicCode(500)).toBe('SMS_SEND_FAILED');
    expect(mapProviderStatusToPublicCode(400)).toBe('SMS_PROVIDER_REJECTED');
  });

  it('extracts only sanitized provider status codes from response bodies', async () => {
    const response = new Response(JSON.stringify({
      SMSMessageData: {
        Message: 'Sent to 0/1',
        Recipients: [{ number: '+254143305099', statusCode: 102, status: 'InvalidPhoneNumber' }],
      },
    }), { status: 400 });

    await expect(readProviderDiagnostics(response)).resolves.toEqual({
      providerErrorCode: '102',
      providerMalformed: false,
    });
  });

  it('accepts every Africa Talking recipient success code (100 / 101 / 102)', () => {
    // Per AT spec: 100 = Processed, 101 = Sent, 102 = Queued. All three must
    // be treated as success or normal sandbox sends (which usually return 100)
    // would be misclassified as SMS_PROVIDER_REJECTED and surface as a 502.
    expect(providerRecipientAccepted('100')).toBe(true);
    expect(providerRecipientAccepted('101')).toBe(true);
    expect(providerRecipientAccepted('102')).toBe(true);
    expect(providerRecipientAccepted('Success')).toBe(true);
    expect(providerRecipientAccepted('sent')).toBe(true);
    expect(providerRecipientAccepted('Queued')).toBe(true);
    expect(providerRecipientAccepted('Processed')).toBe(true);
    expect(providerRecipientAccepted(null)).toBe(true);
  });

  it('treats real Africa Talking recipient failure codes as provider rejections', () => {
    // The real AT failure codes that the legacy "only 101 wins" rule was
    // hiding behind. None of these should ever be silently accepted.
    expect(providerRecipientAccepted('402')).toBe(false); // InvalidSenderId
    expect(providerRecipientAccepted('403')).toBe(false); // InvalidPhoneNumber
    expect(providerRecipientAccepted('404')).toBe(false); // UnsupportedNumberType
    expect(providerRecipientAccepted('405')).toBe(false); // InsufficientBalance
    expect(providerRecipientAccepted('406')).toBe(false); // UserInBlacklist
    expect(providerRecipientAccepted('409')).toBe(false); // DoNotDisturbRejection
    expect(providerRecipientAccepted('500')).toBe(false); // InternalServerError
    expect(providerRecipientAccepted('InvalidPhoneNumber')).toBe(false);
  });

  it('marks malformed provider response bodies without exposing the raw body', async () => {
    const response = new Response('provider body with internal details', { status: 500 });

    await expect(readProviderDiagnostics(response)).resolves.toEqual({
      providerErrorCode: null,
      providerMalformed: true,
    });
  });

  it('accepts a real Africa Talking sandbox success body without flipping to a 502', async () => {
    // This is the exact response shape AT sandbox returns when a message is
    // accepted. The recipient-level statusCode is 100 ("Processed"), which the
    // pre-fix code rejected as SMS_PROVIDER_REJECTED -> 502.
    const response = new Response(JSON.stringify({
      SMSMessageData: {
        Message: 'Sent to 1/1 Total Cost: KES 0.8000',
        Recipients: [{
          number: '+254143305099',
          cost: 'KES 0.8000',
          status: 'Success',
          statusCode: 100,
          messageId: 'ATXid_fake',
        }],
      },
    }), { status: 200 });
    const diagnostics = await readProviderDiagnostics(response);
    expect(diagnostics.providerErrorCode).toBe('100');
    expect(diagnostics.providerMalformed).toBe(false);
    expect(providerRecipientAccepted(diagnostics.providerErrorCode)).toBe(true);
  });

  it('maps gateway-class statuses to safe public codes', () => {
    // Provider 5xx -> generic retryable failure.
    expect(mapProviderStatusToPublicCode(502)).toBe('SMS_SEND_FAILED');
    expect(mapProviderStatusToPublicCode(503)).toBe('SMS_SEND_FAILED');
    // Provider 4xx (non auth/rate) -> rejection.
    expect(mapProviderStatusToPublicCode(404)).toBe('SMS_PROVIDER_REJECTED');
    // Null status (fetch threw) is treated as a provider rejection at the
    // mapper level; the caller upgrades it to SMS_SEND_FAILED on fetch error.
    expect(mapProviderStatusToPublicCode(null)).toBe('SMS_PROVIDER_REJECTED');
  });

  it('normalizes AT_ENV variants without leaking through unexpected values', () => {
    expect(normalizeAfricaTalkingEnv(undefined)).toBe('sandbox');
    expect(normalizeAfricaTalkingEnv('')).toBe('sandbox');
    expect(normalizeAfricaTalkingEnv('Sandbox')).toBe('sandbox');
    expect(normalizeAfricaTalkingEnv('test')).toBe('sandbox');
    expect(normalizeAfricaTalkingEnv('PRODUCTION')).toBe('live');
    expect(normalizeAfricaTalkingEnv('prod')).toBe('live');
    expect(normalizeAfricaTalkingEnv('LIVE')).toBe('live');
    expect(normalizeAfricaTalkingEnv('staging')).toBe('invalid');
  });

  it('never embeds secrets in the urlencoded SMS body', () => {
    const body = buildAfricaTalkingSmsBody({
      username: 'sandbox',
      to: '+254143305099',
      message: 'Your code is 123456',
      from: 'ZURI',
    });
    expect(body.has('apiKey')).toBe(false);
    expect(body.has('Authorization')).toBe(false);
    expect(body.has('AT_API_KEY')).toBe(false);
    expect(body.get('from')).toBe('ZURI');
  });
});

describe('send-otp source: provider failure modes are all classified safely', () => {
  const sendOtpSource = readFileSync(
    resolve(process.cwd(), 'supabase/functions/send-otp/index.ts'),
    'utf8',
  );

  it('routes provider 5xx via mapProviderStatusToPublicCode and not by hand', () => {
    // Confirms send-otp delegates HTTP-status mapping to the shared module
    // instead of inlining a brittle switch that could miss a status.
    expect(sendOtpSource).toMatch(/mapProviderStatusToPublicCode\(providerStatus\)/);
  });

  it('rolls back the just-inserted OTP if the provider call fails', () => {
    // Critical safety: if we cannot send the SMS, we must invalidate the
    // pending OTP row so an attacker cannot brute-force a code that was
    // never delivered.
    expect(sendOtpSource).toMatch(/from\(['"]otp_records['"]\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\(['"]phone['"]/);
    expect(sendOtpSource).toMatch(/\.is\(['"]consumed_at['"]\s*,\s*null\)/);
  });

  it('handles fetch throws without leaking provider error details', () => {
    // The catch block must map to SMS_SEND_FAILED and only log generic
    // sanitized fields (error_name + phone_suffix), never raw error.message.
    const catchStart = sendOtpSource.indexOf('catch (fetchErr)');
    const nextBlock = sendOtpSource.indexOf('if (providerPublicCode)', catchStart);
    expect(catchStart).toBeGreaterThan(0);
    expect(nextBlock).toBeGreaterThan(catchStart);
    const fetchCatchBlock = sendOtpSource.slice(catchStart, nextBlock);

    expect(fetchCatchBlock).toMatch(/SMS_SEND_FAILED/);
    expect(fetchCatchBlock).toMatch(/error_name:\s*\(fetchErr as Error\)\?\.name/);
    expect(fetchCatchBlock).not.toMatch(/fetchErr\)\.message/);
    expect(fetchCatchBlock).not.toMatch(/fetchErr\.stack/);
    expect(fetchCatchBlock).not.toMatch(/JSON\.stringify\(fetchErr/);
  });

  it('never logs the normalized full phone number — only the masked suffix', () => {
    // Hard guard: `phone_suffix:` should appear and `normalizedPhone` must
    // never be a direct console argument. The masked suffix is built via
    // maskPhoneSuffix(normalizedPhone) before logging.
    expect(sendOtpSource).toMatch(/phone_suffix:\s*phoneSuffix/);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*\bnormalizedPhone\b/);
  });
});

describe('send-otp smoke helper: no secret leaks', () => {
  const smokeSource = readFileSync(
    resolve(process.cwd(), 'scripts/smoke-send-otp.mjs'),
    'utf8',
  );

  it('refuses to run real SMS sends without RUN_REAL_SMS=1', () => {
    expect(smokeSource).toMatch(/RUN_REAL_SMS\s*===\s*['"]1['"]/);
    expect(smokeSource).toMatch(/Dry guard active/);
  });

  it('never prints anon key, API key, or the raw phone number', () => {
    expect(smokeSource).not.toMatch(/console\.[a-z]+\([^)]*anonKey/);
    expect(smokeSource).not.toMatch(/console\.[a-z]+\([^)]*AT_API_KEY/i);
    expect(smokeSource).not.toMatch(/console\.[a-z]+\([^)]*\$\{phone\}/);
    // Output goes through maskPhone helper, which only emits *** + last 3.
    expect(smokeSource).toMatch(/maskPhone\(phone\)/);
  });
});
