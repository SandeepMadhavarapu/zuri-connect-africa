export type RiskDecision = 'allow' | 'step_up' | 'block' | 'manual_review';
export type StepUpType = 'otp' | 'pin' | 'biometric' | 'support_review';

export type RiskEvaluationInput = {
  userId: string;
  txRef: string;
  amount: number;
  paymentType: string;
  fromPhone: string;
  toPhone: string;
  idempotencyKey: string;
  now?: Date;
  recentPaymentCountHour?: number;
  recentPaymentCountDay?: number;
  dailyTotalAmount?: number;
  monthlyTotalAmount?: number;
  newRecipient?: boolean;
  failedOtpAttempts?: number;
  newDevice?: boolean;
  impossibleTravel?: boolean;
  recentSimOrAccountChange?: boolean;
  accountAgeDays?: number | null;
  recentReversalCount?: number;
  recipientRiskScore?: number;
  userDailyLimit?: number;
  userMonthlyLimit?: number;
  clientRiskOverridePresent?: boolean;
};

export type RiskEvaluationResult = {
  decision: RiskDecision;
  risk_score: number;
  reasons: string[];
  required_step_up?: StepUpType;
};

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function hourOfDay(now = new Date()): number {
  return now.getUTCHours();
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluationResult {
  let score = 0;
  const reasons: string[] = [];
  const amount = Number(input.amount) || 0;
  const dailyLimit = Number(input.userDailyLimit ?? 150000);
  const monthlyLimit = Number(input.userMonthlyLimit ?? 1000000);

  if (amount <= 0) {
    return { decision: 'block', risk_score: 100, reasons: ['invalid_amount'] };
  }

  if (amount > dailyLimit || Number(input.dailyTotalAmount ?? 0) + amount > dailyLimit) {
    return { decision: 'block', risk_score: 100, reasons: ['daily_limit_exceeded'] };
  }

  if (Number(input.monthlyTotalAmount ?? 0) + amount > monthlyLimit) {
    return { decision: 'manual_review', risk_score: 92, reasons: ['monthly_limit_review'], required_step_up: 'support_review' };
  }

  if (amount >= 100000) {
    score += 46;
    addReason(reasons, 'very_high_amount');
  } else if (amount >= 50000) {
    score += 32;
    addReason(reasons, 'high_amount');
  } else if (amount >= 10000) {
    score += 18;
    addReason(reasons, 'elevated_amount');
  }

  const hourlyCount = Number(input.recentPaymentCountHour ?? 0);
  const dailyCount = Number(input.recentPaymentCountDay ?? 0);
  if (hourlyCount >= 10 || dailyCount >= 30) {
    score += 55;
    addReason(reasons, 'velocity_abuse');
  } else if (hourlyCount >= 5 || dailyCount >= 15) {
    score += 32;
    addReason(reasons, 'high_velocity');
  } else if (hourlyCount >= 3) {
    score += 16;
    addReason(reasons, 'elevated_velocity');
  }

  if (input.newRecipient) {
    score += amount >= 5000 ? 18 : 8;
    addReason(reasons, 'new_recipient');
  }

  const failedOtp = Number(input.failedOtpAttempts ?? 0);
  if (failedOtp >= 5) {
    score += 38;
    addReason(reasons, 'failed_otp_abuse');
  } else if (failedOtp >= 2) {
    score += 16;
    addReason(reasons, 'recent_failed_otp_attempts');
  }

  if (input.newDevice) {
    score += 18;
    addReason(reasons, 'new_device');
  }

  if (input.impossibleTravel) {
    score += 42;
    addReason(reasons, 'impossible_travel');
  }

  if (input.recentSimOrAccountChange) {
    score += 34;
    addReason(reasons, 'recent_account_change');
  }

  const h = hourOfDay(input.now);
  if (h >= 21 || h < 4) {
    score += amount >= 5000 ? 14 : 6;
    addReason(reasons, 'unusual_time_of_day');
  }

  if (input.accountAgeDays !== null && input.accountAgeDays !== undefined && input.accountAgeDays < 7) {
    score += amount >= 10000 ? 25 : 12;
    addReason(reasons, 'new_account');
  }

  const reversals = Number(input.recentReversalCount ?? 0);
  if (reversals >= 3) {
    score += 32;
    addReason(reasons, 'recent_reversals');
  } else if (reversals > 0) {
    score += 12;
    addReason(reasons, 'previous_reversal');
  }

  const recipientRisk = Number(input.recipientRiskScore ?? 0);
  if (recipientRisk >= 90) {
    score += 55;
    addReason(reasons, 'critical_recipient_risk');
  } else if (recipientRisk >= 70) {
    score += 35;
    addReason(reasons, 'high_recipient_risk');
  } else if (recipientRisk >= 45) {
    score += 16;
    addReason(reasons, 'elevated_recipient_risk');
  }

  if (input.clientRiskOverridePresent) {
    score += 8;
    addReason(reasons, 'client_risk_override_ignored');
  }

  const riskScore = clampScore(score);

  if (riskScore >= 90 || reasons.includes('velocity_abuse') || reasons.includes('critical_recipient_risk')) {
    return { decision: 'block', risk_score: riskScore, reasons };
  }

  if (riskScore >= 75 || reasons.includes('impossible_travel')) {
    return { decision: 'manual_review', risk_score: riskScore, reasons, required_step_up: 'support_review' };
  }

  if (riskScore >= 45 || amount >= 50000) {
    const required: StepUpType = reasons.includes('new_device') || reasons.includes('impossible_travel')
      ? 'biometric'
      : amount >= 50000
        ? 'pin'
        : 'otp';
    return { decision: 'step_up', risk_score: riskScore, reasons, required_step_up: required };
  }

  return { decision: 'allow', risk_score: riskScore, reasons };
}

export function publicRiskMessage(result: RiskEvaluationResult): string {
  if (result.decision === 'step_up') return 'We need one more verification step.';
  if (result.decision === 'manual_review') return 'This payment needs review.';
  if (result.decision === 'block') return 'For your safety, this action was blocked.';
  return 'Payment risk checks passed.';
}

export async function buildRiskEvaluationInput({
  supabaseAdmin,
  pendingRecord,
  user,
  body,
  now = new Date(),
}: {
  supabaseAdmin: any;
  pendingRecord: Record<string, any>;
  user: Record<string, any>;
  body: Record<string, unknown>;
  now?: Date;
}): Promise<RiskEvaluationInput> {
  const userId = String(user.id);
  const amount = Number(pendingRecord.amount);
  const fromPhone = String(pendingRecord.from_phone);
  const toPhone = String(pendingRecord.to_phone);
  const metadata = typeof body.metadata === 'object' && body.metadata !== null
    ? body.metadata as Record<string, unknown>
    : {};

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ count: recentPaymentCountHour }, { count: recentPaymentCountDay }, priorRecipient, dailyRows, monthlyRows, otpRows, reversalRows, recipientRiskRows, deviceRows] = await Promise.all([
    supabaseAdmin.from('pending_payments').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', hourAgo),
    supabaseAdmin.from('pending_payments').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', dayAgo),
    supabaseAdmin.from('pending_payments').select('id').eq('user_id', userId).eq('to_phone', toPhone).in('status', ['succeeded', 'completed', 'confirmed', 'settled']).limit(1).maybeSingle(),
    supabaseAdmin.from('pending_payments').select('amount').eq('user_id', userId).in('status', ['succeeded', 'completed', 'confirmed', 'settled']).gte('created_at', dayAgo),
    supabaseAdmin.from('pending_payments').select('amount').eq('user_id', userId).in('status', ['succeeded', 'completed', 'confirmed', 'settled']).gte('created_at', monthAgo),
    supabaseAdmin.from('otp_records').select('attempts').eq('phone', fromPhone).limit(5),
    supabaseAdmin.from('pending_payments').select('id').eq('user_id', userId).eq('status', 'reversed').gte('created_at', monthAgo),
    supabaseAdmin.from('risk_events').select('score').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
    metadata.device_fingerprint
      ? supabaseAdmin.from('device_sessions').select('id').eq('user_id', userId).eq('device_fingerprint', metadata.device_fingerprint).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const sumAmounts = (rows: { data?: Array<{ amount?: number | string }> }) =>
    (Array.isArray(rows.data) ? rows.data : []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const failedOtpAttempts = (Array.isArray(otpRows.data) ? otpRows.data : [])
    .reduce((sum, row) => sum + Number(row.attempts || 0), 0);
  const recipientRiskScore = Math.max(0, ...(Array.isArray(recipientRiskRows.data) ? recipientRiskRows.data : []).map((row) => Number(row.score || 0)));
  const accountCreatedAt = user.created_at ? new Date(String(user.created_at)) : null;
  const accountAgeDays = accountCreatedAt && Number.isFinite(accountCreatedAt.getTime())
    ? Math.floor((now.getTime() - accountCreatedAt.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  return {
    userId,
    txRef: String(pendingRecord.tx_ref),
    amount,
    paymentType: String(pendingRecord.payment_type || 'send'),
    fromPhone,
    toPhone,
    idempotencyKey: String(pendingRecord.idempotency_key || ''),
    now,
    recentPaymentCountHour: Number(recentPaymentCountHour || 0),
    recentPaymentCountDay: Number(recentPaymentCountDay || 0),
    dailyTotalAmount: sumAmounts(dailyRows),
    monthlyTotalAmount: sumAmounts(monthlyRows),
    newRecipient: !priorRecipient.data,
    failedOtpAttempts,
    newDevice: Boolean(metadata.device_fingerprint && !deviceRows.data),
    impossibleTravel: metadata.impossible_travel === true,
    recentSimOrAccountChange: metadata.recent_sim_change === true || metadata.recent_account_change === true,
    accountAgeDays,
    recentReversalCount: Array.isArray(reversalRows.data) ? reversalRows.data.length : 0,
    recipientRiskScore,
    userDailyLimit: Number(metadata.user_daily_limit || 150000),
    userMonthlyLimit: Number(metadata.user_monthly_limit || 1000000),
    clientRiskOverridePresent: Boolean(
      body.risk_decision
      || body.risk_score
      || body.fraud_decision
      || body.ai_risk_decision
      || metadata.risk_decision
      || metadata.ai_risk_decision
    ),
  };
}
