import { normalizePhone } from './payment-lifecycle.ts';

export async function getDarajaToken(consumerKey: string, consumerSecret: string, baseUrl: string): Promise<string> {
  const credentials = btoa(`${consumerKey}:${consumerSecret}`);
  const res = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`Daraja OAuth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Daraja OAuth: no access_token');
  return data.access_token;
}

export function generateDarajaTimestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

export function generateDarajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return btoa(`${shortcode}${passkey}${timestamp}`);
}

export function darajaBaseUrl(darajaEnv: string): string {
  return darajaEnv === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

export type StkPushResult =
  | { ok: true; checkoutRequestId: string; merchantRequestId: string }
  | { ok: false; responseCode: string; responseDescription: string };

export async function requestDarajaStkPush({
  darajaEnv,
  consumerKey,
  consumerSecret,
  shortcode,
  passkey,
  callbackUrl,
  amount,
  fromPhone,
  accountReference,
  transactionDesc,
}: {
  darajaEnv: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  amount: number;
  fromPhone: string;
  /**
   * Daraja STK Push AccountReference (≤12 chars, echoed back in the callback).
   * Callers MUST pass the pending row's server-generated `correlation_ref` so an
   * orphaned callback stays re-linkable (MED-3) — NOT the user-facing biller
   * account reference, which is preserved in pending_payments.metadata.
   */
  accountReference: string;
  transactionDesc: string;
}): Promise<StkPushResult> {
  const normalizedFromPhone = normalizePhone(fromPhone);
  const baseUrl = darajaBaseUrl(darajaEnv);
  const token = await getDarajaToken(consumerKey, consumerSecret, baseUrl);
  const timestamp = generateDarajaTimestamp();
  const password = generateDarajaPassword(shortcode, passkey, timestamp);

  const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(Number(amount)),
      PartyA: normalizedFromPhone,
      PartyB: shortcode,
      PhoneNumber: normalizedFromPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference.slice(0, 12),
      TransactionDesc: transactionDesc,
    }),
  });

  if (!stkRes.ok) {
    throw new Error(`STK Push failed ${stkRes.status}: ${await stkRes.text()}`);
  }

  const stkData = await stkRes.json();
  if (stkData.ResponseCode !== '0') {
    return {
      ok: false,
      responseCode: String(stkData.ResponseCode ?? ''),
      responseDescription: String(stkData.ResponseDescription ?? 'Rejected by Daraja'),
    };
  }

  return {
    ok: true,
    checkoutRequestId: String(stkData.CheckoutRequestID),
    merchantRequestId: String(stkData.MerchantRequestID),
  };
}
