export type DarajaCallback = {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: string;
  resultDesc: string;
  receiptNumber: string | null;
  amount: number | null;
  phoneNumber: string | null;
};

export type PendingPayment = {
  id: string;
  tx_ref: string;
  user_id: string;
  payment_type?: string | null;
  amount: number | string;
  from_phone: string;
  to_phone: string;
  description?: string | null;
  idempotency_key?: string | null;
  status: string;
  ledger_posted_at?: string | null;
};

export type PaymentReconciliationEvent = {
  pending_payment_id: string;
  external_reference: string;
  provider_status: string;
  internal_status: string;
  amount_match: boolean | null;
  phone_match: boolean | null;
  requires_manual_review: boolean;
  raw_provider_payload_hash: string;
  event_type?: string;
  /** Human-readable rationale; populated by finalizeDarajaPayment + sweep. */
  reason?: string;
};

const SUCCESS_STATUSES = new Set(['succeeded']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'timeout']);
const TERMINAL_STATUSES = new Set([...SUCCESS_STATUSES, ...FAILURE_STATUSES, 'review_required', 'reversed']);
const ALLOWED_PAYMENT_TYPES = new Set(['send', 'paybill', 'airtime', 'bundle', 'fuliza_drawdown']);

export function normalizePhone(phone: string): string {
  const cleaned = String(phone || '').replace(/\s+/g, '').replace(/^\+/, '');
  if (cleaned.startsWith('254')) return cleaned;
  if (cleaned.startsWith('07') || cleaned.startsWith('01')) return `254${cleaned.substring(1)}`;
  if (cleaned.length === 9 && (cleaned.startsWith('7') || cleaned.startsWith('1'))) return `254${cleaned}`;
  if (cleaned.length === 10 && cleaned.startsWith('0')) return `254${cleaned.substring(1)}`;
  throw new Error('Invalid phone number format');
}

export function normalizeMoneyAmount(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('INVALID_AMOUNT');
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildPendingPaymentRecord({
  body,
  userId,
  normalizedFromPhone,
}: {
  body: Record<string, unknown>;
  userId: string;
  normalizedFromPhone: string;
}) {
  const amount = normalizeMoneyAmount(body.amount);
  const txRef = String(body.tx_ref || '').trim();
  const idempotencyKey = String(body.idempotency_key || '').trim();
  const paymentType = String(body.payment_type || 'send').trim();
  const rawRecipient = String(body.to_phone || '').trim();
  const accountReference = String(body.account_reference || body.tx_ref || '').trim();
  if (!txRef) throw new Error('TX_REF_REQUIRED');
  if (!idempotencyKey) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  if (!ALLOWED_PAYMENT_TYPES.has(paymentType)) throw new Error('INVALID_PAYMENT_TYPE');
  if (!rawRecipient) throw new Error('RECIPIENT_REQUIRED');
  if (!accountReference || accountReference.length > 64) throw new Error('INVALID_ACCOUNT_REFERENCE');

  let recipient = rawRecipient;
  if (paymentType === 'send') {
    recipient = normalizePhone(rawRecipient);
  } else if (!/^[A-Z0-9_-]{3,32}$/i.test(rawRecipient)) {
    throw new Error('INVALID_RECIPIENT');
  }

  return {
    tx_ref: txRef,
    user_id: userId,
    idempotency_key: idempotencyKey,
    payment_type: paymentType,
    amount,
    from_phone: normalizedFromPhone,
    to_phone: recipient,
    description: String(body.description || '').trim(),
    metadata: {
      ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {}),
      account_reference: accountReference,
    },
    status: 'processing',
    updated_at: new Date().toISOString(),
  };
}

function callbackItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const stk = (payload.Body as Record<string, unknown> | undefined)?.stkCallback as Record<string, unknown> | undefined;
  const metadata = stk?.CallbackMetadata as Record<string, unknown> | undefined;
  const items = metadata?.Item;
  return Array.isArray(items) ? items.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
}

function callbackValue(items: Record<string, unknown>[], name: string): unknown {
  return items.find((item) => item.Name === name)?.Value ?? null;
}

export function parseDarajaStkCallback(payload: Record<string, unknown>): DarajaCallback {
  const stk = (payload.Body as Record<string, unknown> | undefined)?.stkCallback as Record<string, unknown> | undefined;
  if (!stk) throw new Error('UNSUPPORTED_DARAJA_CALLBACK');
  const items = callbackItems(payload);
  const callback = {
    checkoutRequestId: String(stk.CheckoutRequestID || ''),
    merchantRequestId: stk.MerchantRequestID ? String(stk.MerchantRequestID) : null,
    resultCode: String(stk.ResultCode ?? ''),
    resultDesc: String(stk.ResultDesc || ''),
    receiptNumber: callbackValue(items, 'MpesaReceiptNumber') ? String(callbackValue(items, 'MpesaReceiptNumber')) : null,
    amount: callbackValue(items, 'Amount') === null ? null : Number(callbackValue(items, 'Amount')),
    phoneNumber: callbackValue(items, 'PhoneNumber') ? String(callbackValue(items, 'PhoneNumber')) : null,
  };
  if (!callback.checkoutRequestId) throw new Error('MISSING_CHECKOUT_REQUEST_ID');
  if (!callback.merchantRequestId) throw new Error('MISSING_MERCHANT_REQUEST_ID');
  if (!callback.resultCode) throw new Error('MISSING_RESULT_CODE');
  if (callback.resultCode === '0' && !callback.receiptNumber) throw new Error('MISSING_MPESA_RECEIPT');
  return callback;
}

export function callbackStatus(callback: DarajaCallback): string {
  if (callback.resultCode === '0') return 'succeeded';
  const desc = callback.resultDesc.toLowerCase();
  if (callback.resultCode === '1032' || desc.includes('cancel')) return 'cancelled';
  if (callback.resultCode === '1037' || desc.includes('timeout') || desc.includes('timed out')) return 'timeout';
  return 'failed';
}

export function callbackExternalReference(callback: DarajaCallback): string {
  return callback.receiptNumber || callback.checkoutRequestId || callback.merchantRequestId || 'unknown';
}

export function callbackIdempotencyKey(callback: DarajaCallback, payloadHash: string): string {
  return [
    'mpesa',
    callback.checkoutRequestId,
    callback.resultCode,
    callback.receiptNumber || payloadHash,
  ].join(':');
}

function normalizeStatus(status: unknown): string {
  const value = String(status || '').toLowerCase();
  if (['completed', 'confirmed', 'settled'].includes(value)) return 'succeeded';
  if (value === 'canceled') return 'cancelled';
  return value;
}

function statusesConflict(providerStatus: string, internalStatus: string): boolean {
  const normalizedInternal = normalizeStatus(internalStatus);
  if (!TERMINAL_STATUSES.has(normalizedInternal)) return false;
  if (normalizedInternal === 'review_required') return providerStatus !== 'review_required';
  if (SUCCESS_STATUSES.has(normalizedInternal)) return providerStatus !== 'succeeded';
  if (FAILURE_STATUSES.has(normalizedInternal)) return providerStatus === 'succeeded' || providerStatus !== normalizedInternal;
  return providerStatus !== normalizedInternal;
}

function compareAmount(callbackAmount: number | null, pendingAmount: number | string): boolean | null {
  if (callbackAmount === null || !Number.isFinite(callbackAmount)) return null;
  return round(Number(callbackAmount)) === round(Number(pendingAmount));
}

function comparePhone(callbackPhone: string | null, pendingPhone: string): boolean | null {
  if (!callbackPhone) return null;
  try {
    return normalizePhone(callbackPhone) === normalizePhone(pendingPhone);
  } catch {
    return false;
  }
}

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function sha256Hex(message: string): Promise<string> {
  const encoded = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ledgerHash(entry: Record<string, unknown>, entryType: 'debit' | 'credit'): Promise<string> {
  return sha256Hex([
    entry.transaction_ref,
    entryType,
    String(entry.amount),
    String(entry.balance_before),
    String(entry.balance_after),
    entry.account_phone,
  ].join('|'));
}

export async function buildLedgerRpcArgs(
  pending: PendingPayment,
  debitBalanceBefore: number,
  creditBalanceBefore: number
) {
  const amount = normalizeMoneyAmount(pending.amount);
  const isFulizaDrawdown = pending.payment_type === 'fuliza_drawdown';
  const debitPhone = isFulizaDrawdown ? pending.to_phone : pending.from_phone;
  const creditPhone = isFulizaDrawdown ? pending.from_phone : pending.to_phone;
  const debitBalanceAfter = round(debitBalanceBefore - amount);
  const creditBalanceAfter = round(creditBalanceBefore + amount);

  const base = {
    transaction_ref: pending.tx_ref,
    amount: String(amount),
    description: pending.description || `Payment ${pending.tx_ref}`,
    owner_id: pending.user_id,
    idempotency_key: pending.idempotency_key || `pending_${pending.id}`,
  };
  const debit = {
    ...base,
    balance_before: String(debitBalanceBefore),
    balance_after: String(debitBalanceAfter),
    account_phone: debitPhone,
  };
  const credit = {
    ...base,
    balance_before: String(creditBalanceBefore),
    balance_after: String(creditBalanceAfter),
    account_phone: creditPhone,
  };

  return {
    p_debit: { ...debit, hash: await ledgerHash(debit, 'debit') },
    p_credit: { ...credit, hash: await ledgerHash(credit, 'credit') },
    p_expect_debit_balance_before: debitBalanceBefore,
  };
}

export async function finalizeDarajaPayment({
  callback,
  pending,
  payloadHash,
  getLatestBalance,
  postDoubleEntry,
  updatePendingPayment,
  recordReconciliationEvent = async () => undefined,
  writeAuditEvent = async () => undefined,
  now = () => new Date().toISOString(),
}: {
  callback: DarajaCallback;
  pending: PendingPayment;
  payloadHash: string;
  getLatestBalance: (accountPhone: string) => Promise<number>;
  postDoubleEntry: (args: Record<string, unknown>) => Promise<unknown>;
  updatePendingPayment: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  recordReconciliationEvent?: (event: PaymentReconciliationEvent) => Promise<unknown>;
  writeAuditEvent?: (event: Record<string, unknown>) => Promise<unknown>;
  now?: () => string;
}) {
  const status = callbackStatus(callback);
  const internalStatus = normalizeStatus(pending.status);
  const externalReference = callbackExternalReference(callback);
  const amountMatch = compareAmount(callback.amount, pending.amount);
  const phoneMatch = comparePhone(callback.phoneNumber, pending.from_phone);
  const conflict = statusesConflict(status, internalStatus);
  const posted = Boolean(pending.ledger_posted_at) || internalStatus === 'succeeded';
  const successVerificationFailed = status === 'succeeded' && (amountMatch !== true || phoneMatch !== true);

  const reasonFor = (eventType: string): string => {
    switch (eventType) {
      case 'amount_mismatch':            return 'amount mismatch';
      case 'phone_mismatch':             return 'phone mismatch';
      case 'conflicting_provider_status':return 'provider/internal status conflict';
      case 'late_conflicting_callback':  return 'late callback after terminal status';
      case 'duplicate_success':          return 'duplicate success callback';
      case 'terminal_failure':           return `callback reported ${status}`;
      case 'succeeded':                  return 'callback succeeded';
      default:                           return eventType.replace(/_/g, ' ');
    }
  };

  const recordReconciliation = async (
    requiresManualReview: boolean,
    eventType: string,
    overrideInternalStatus: string = pending.status,
  ) => recordReconciliationEvent({
    pending_payment_id: pending.id,
    external_reference: externalReference,
    provider_status: status,
    internal_status: String(overrideInternalStatus || pending.status),
    amount_match: amountMatch,
    phone_match: phoneMatch,
    requires_manual_review: requiresManualReview,
    raw_provider_payload_hash: payloadHash,
    event_type: eventType,
    reason: reasonFor(eventType),
  });

  const auditPayload = {
    pending_payment_id: pending.id,
    tx_ref: pending.tx_ref,
    provider_status: status,
    internal_status: pending.status,
    external_reference: externalReference,
    amount_match: amountMatch,
    phone_match: phoneMatch,
  };

  const terminalPatch = {
    status,
    result_code: callback.resultCode,
    result_desc: callback.resultDesc,
    provider_receipt: callback.receiptNumber,
    callback_payload_hash: payloadHash,
    raw_callback: callback,
    updated_at: now(),
  };

  if (posted && status === 'succeeded') {
    await recordReconciliation(false, 'duplicate_success');
    await writeAuditEvent({
      event_type: 'payment.webhook.duplicate_success',
      event_category: 'financial',
      severity: 'info',
      actor_id: pending.user_id,
      actor_type: 'service',
      target_type: 'pending_payments',
      target_id: pending.id,
      action: 'ignore_duplicate_success_callback',
      outcome: 'success',
      payload: auditPayload,
      correlation_id: pending.tx_ref,
    });
    return { ok: true, duplicate: true, status: 'succeeded', ledgerPosted: false };
  }

  if (posted && status !== 'succeeded') {
    // Late failure callback for an already-succeeded payment. We MUST NOT
    // auto-reverse the ledger — that's a manual ops decision.
    await recordReconciliation(true, 'late_conflicting_callback');
    await writeAuditEvent({
      event_type: 'webhook.conflicting_status',
      event_category: 'financial',
      severity: 'critical',
      actor_id: pending.user_id,
      actor_type: 'service',
      target_type: 'pending_payments',
      target_id: pending.id,
      action: 'require_reconciliation_review_after_ledger_post',
      outcome: 'pending',
      payload: auditPayload,
      correlation_id: pending.tx_ref,
    });
    return { ok: true, status: pending.status, ledgerPosted: false, reviewRequired: true };
  }

  if (conflict) {
    await recordReconciliation(true, 'conflicting_provider_status');
    await updatePendingPayment(pending.id, {
      status: 'review_required',
      result_code: callback.resultCode,
      result_desc: callback.resultDesc,
      callback_payload_hash: payloadHash,
      raw_callback: callback,
      updated_at: now(),
    });
    await writeAuditEvent({
      event_type: 'webhook.conflicting_status',
      event_category: 'financial',
      severity: 'warn',
      actor_id: pending.user_id,
      actor_type: 'service',
      target_type: 'pending_payments',
      target_id: pending.id,
      action: 'require_reconciliation_review',
      outcome: 'pending',
      payload: auditPayload,
      correlation_id: pending.tx_ref,
    });
    return { ok: true, status: 'review_required', ledgerPosted: false, reviewRequired: true };
  }

  if (status !== 'succeeded') {
    await updatePendingPayment(pending.id, terminalPatch);
    await recordReconciliation(false, 'terminal_failure');
    await writeAuditEvent({
      event_type: `payment.webhook.${status}`,
      event_category: 'financial',
      severity: status === 'failed' ? 'warn' : 'info',
      actor_id: pending.user_id,
      actor_type: 'service',
      target_type: 'pending_payments',
      target_id: pending.id,
      action: 'finalize_payment_without_ledger',
      outcome: 'failure',
      payload: auditPayload,
      correlation_id: pending.tx_ref,
    });
    return { ok: true, status, ledgerPosted: false };
  }

  if (successVerificationFailed) {
    await updatePendingPayment(pending.id, {
      status: 'review_required',
      result_code: callback.resultCode,
      result_desc: callback.resultDesc,
      provider_receipt: callback.receiptNumber,
      callback_payload_hash: payloadHash,
      raw_callback: callback,
      updated_at: now(),
    });
    const mismatchEventName = amountMatch !== true ? 'webhook.amount_mismatch' : 'webhook.phone_mismatch';
    await recordReconciliation(true, amountMatch !== true ? 'amount_mismatch' : 'phone_mismatch', 'review_required');
    await writeAuditEvent({
      event_type: mismatchEventName,
      event_category: 'financial',
      severity: 'critical',
      actor_id: pending.user_id,
      actor_type: 'service',
      target_type: 'pending_payments',
      target_id: pending.id,
      action: 'hold_payment_for_reconciliation',
      outcome: 'pending',
      payload: auditPayload,
      correlation_id: pending.tx_ref,
    });
    return { ok: true, status: 'review_required', ledgerPosted: false, reviewRequired: true };
  }

  const isFulizaDrawdown = pending.payment_type === 'fuliza_drawdown';
  const debitPhone = isFulizaDrawdown ? pending.to_phone : pending.from_phone;
  const creditPhone = isFulizaDrawdown ? pending.from_phone : pending.to_phone;
  const debitBalance = await getLatestBalance(debitPhone);
  const creditBalance = await getLatestBalance(creditPhone);
  const args = await buildLedgerRpcArgs(pending, debitBalance, creditBalance);
  await postDoubleEntry(args);
  await updatePendingPayment(pending.id, {
    ...terminalPatch,
    status: 'succeeded',
    ledger_posted_at: now(),
    completed_at: now(),
  });
  await recordReconciliation(false, 'succeeded', 'succeeded');
  await writeAuditEvent({
    event_type: 'payment.webhook.succeeded',
    event_category: 'financial',
    severity: 'info',
    actor_id: pending.user_id,
    actor_type: 'service',
    target_type: 'pending_payments',
    target_id: pending.id,
    action: 'post_server_authoritative_ledger',
    outcome: 'success',
    payload: auditPayload,
    correlation_id: pending.tx_ref,
  });
  return { ok: true, status: 'succeeded', ledgerPosted: true, transactionRef: pending.tx_ref };
}
