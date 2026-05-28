export type AfricaTalkingRuntimeEnv = 'sandbox' | 'live';

export type OtpProviderPublicCode =
  | 'OTP_SERVICE_UNAVAILABLE'
  | 'SMS_SEND_FAILED'
  | 'SMS_PROVIDER_REJECTED'
  | 'SMS_PROVIDER_MISCONFIGURED'
  | 'SMS_PROVIDER_RATE_LIMITED';

export type AfricaTalkingConfigResult =
  | {
      ok: true;
      atEnv: AfricaTalkingRuntimeEnv;
      url: string;
      username: string;
      apiKey: string;
    }
  | {
      ok: false;
      atEnv: AfricaTalkingRuntimeEnv | 'invalid';
      publicCode: OtpProviderPublicCode;
      reason: 'missing_credentials' | 'invalid_environment';
      usernamePresent: boolean;
      apiKeyPresent: boolean;
    };

const AT_SANDBOX_URL = 'https://api.sandbox.africastalking.com/version1/messaging';
const AT_LIVE_URL = 'https://api.africastalking.com/version1/messaging';

export function normalizeAfricaTalkingEnv(input: string | null | undefined): AfricaTalkingRuntimeEnv | 'invalid' {
  const value = String(input ?? 'sandbox').trim().toLowerCase();
  if (!value || value === 'sandbox' || value === 'test') return 'sandbox';
  if (value === 'live' || value === 'production' || value === 'prod') return 'live';
  return 'invalid';
}

export function getAfricaTalkingUrl(atEnv: AfricaTalkingRuntimeEnv): string {
  return atEnv === 'live' ? AT_LIVE_URL : AT_SANDBOX_URL;
}

export function resolveAfricaTalkingConfig({
  apiKey,
  atEnv,
  username,
}: {
  apiKey?: string | null;
  atEnv?: string | null;
  username?: string | null;
}): AfricaTalkingConfigResult {
  const resolvedEnv = normalizeAfricaTalkingEnv(atEnv);
  const safeUsername = String(username ?? '').trim();
  const safeApiKey = String(apiKey ?? '').trim();

  if (resolvedEnv === 'invalid') {
    return {
      ok: false,
      atEnv: 'invalid',
      publicCode: 'SMS_PROVIDER_MISCONFIGURED',
      reason: 'invalid_environment',
      usernamePresent: Boolean(safeUsername),
      apiKeyPresent: Boolean(safeApiKey),
    };
  }

  if (!safeUsername || !safeApiKey) {
    return {
      ok: false,
      atEnv: resolvedEnv,
      publicCode: 'SMS_PROVIDER_MISCONFIGURED',
      reason: 'missing_credentials',
      usernamePresent: Boolean(safeUsername),
      apiKeyPresent: Boolean(safeApiKey),
    };
  }

  return {
    ok: true,
    atEnv: resolvedEnv,
    url: getAfricaTalkingUrl(resolvedEnv),
    username: safeUsername,
    apiKey: safeApiKey,
  };
}

export function buildAfricaTalkingSmsBody({
  from,
  message,
  to,
  username,
}: {
  from?: string | null;
  message: string;
  to: string;
  username: string;
}): URLSearchParams {
  const body = new URLSearchParams({
    username,
    to,
    message,
  });
  const safeFrom = String(from ?? '').trim();
  if (safeFrom) body.set('from', safeFrom);
  return body;
}

export function mapProviderStatusToPublicCode(status: number | null): OtpProviderPublicCode {
  if (status === 401 || status === 403) return 'SMS_PROVIDER_MISCONFIGURED';
  if (status === 429) return 'SMS_PROVIDER_RATE_LIMITED';
  if (status !== null && status >= 500) return 'SMS_SEND_FAILED';
  return 'SMS_PROVIDER_REJECTED';
}

// Africa's Talking SMS recipient-level success codes (per the public spec):
//   100 = Processed   (accepted at AT for onward dispatch)
//   101 = Sent        (handed off to the MNO)
//   102 = Queued      (queued at the MNO)
// Anything else (402 InvalidSenderId, 403 InvalidPhoneNumber, 405 Insufficient
// balance, 406 Blacklist, 409 DoNotDisturb, 500/501/502 gateway errors, ...) is
// a real provider rejection that must surface as SMS_PROVIDER_REJECTED.
const AT_RECIPIENT_SUCCESS_CODES = new Set([
  '100',
  '101',
  '102',
  'success',
  'sent',
  'queued',
  'processed',
]);

export function providerRecipientAccepted(providerErrorCode: string | null): boolean {
  if (!providerErrorCode) return true;
  const code = providerErrorCode.trim().toLowerCase();
  return AT_RECIPIENT_SUCCESS_CODES.has(code);
}

export function maskPhoneSuffix(phone: string): string {
  const suffix = String(phone ?? '').replace(/\D/g, '').slice(-3);
  return suffix ? `***${suffix}` : '***';
}

function extractRecipientStatusCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { SMSMessageData?: unknown }).SMSMessageData;
  if (!data || typeof data !== 'object') return null;
  const recipients = (data as { Recipients?: unknown }).Recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) return null;
  const first = recipients[0] as { statusCode?: unknown; status?: unknown };
  const code = first.statusCode ?? first.status;
  return code === undefined || code === null ? null : String(code).slice(0, 80);
}

export async function readProviderDiagnostics(response: Response): Promise<{
  providerErrorCode: string | null;
  providerMalformed: boolean;
}> {
  try {
    const text = await response.text();
    if (!text) return { providerErrorCode: null, providerMalformed: true };
    try {
      const parsed = JSON.parse(text);
      const providerErrorCode = extractRecipientStatusCode(parsed);
      return {
        providerErrorCode,
        providerMalformed: providerErrorCode === null,
      };
    } catch {
      return { providerErrorCode: null, providerMalformed: true };
    }
  } catch {
    return { providerErrorCode: null, providerMalformed: true };
  }
}
