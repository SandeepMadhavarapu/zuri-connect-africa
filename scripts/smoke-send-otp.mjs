#!/usr/bin/env node

/**
 * Local operator smoke helper for send-otp.
 *
 * This intentionally refuses to send SMS unless RUN_REAL_SMS=1 is set.
 * It never prints Supabase or Africa's Talking secrets.
 */

const phone = process.argv[2] || '';
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const runRealSms = process.env.RUN_REAL_SMS === '1';

function maskPhone(value) {
  const suffix = String(value || '').replace(/\D/g, '').slice(-3);
  return suffix ? `***${suffix}` : '***';
}

if (!runRealSms) {
  console.log('[smoke-send-otp] Dry guard active. Set RUN_REAL_SMS=1 to send a real OTP SMS.');
  console.log('[smoke-send-otp] Usage: RUN_REAL_SMS=1 node scripts/smoke-send-otp.mjs +254143305099');
  process.exit(0);
}

if (!phone || !supabaseUrl || !anonKey) {
  console.error('[smoke-send-otp] Missing required phone, SUPABASE_URL/VITE_SUPABASE_URL, or SUPABASE_ANON_KEY/VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const endpoint = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/send-otp`;
console.log(`[smoke-send-otp] Calling send-otp for ${maskPhone(phone)}.`);

const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ phone }),
});

let body = null;
try {
  body = await res.json();
} catch {
  body = { ok: false, error: 'NON_JSON_RESPONSE' };
}

console.log('[smoke-send-otp] Result:', {
  ok: res.ok,
  status: res.status,
  error: body?.error ?? null,
  success: body?.success === true,
});

process.exit(res.ok ? 0 : 1);
