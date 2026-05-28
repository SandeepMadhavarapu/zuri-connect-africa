import { getFunctionsBaseUrl } from '@/config/env.js';

export function edgeUrl(name) {
  const base = getFunctionsBaseUrl();
  return `${base}/${name}`;
}

export const endpoints = {
  sendOtp: () => edgeUrl('send-otp'),
  verifyOtp: () => edgeUrl('verify-otp'),
  webhookHandler: () => edgeUrl('webhook-handler'),
  reconciliationJob: () => edgeUrl('reconciliation-job'),
  settlementRecovery: () => edgeUrl('settlement-recovery'),
  aiRouter: () => edgeUrl('ai-router'),
  notificationDispatcher: () => edgeUrl('notification-dispatcher'),
  initiatePayment: () => edgeUrl('initiate-payment'),
  completeStepUp: () => edgeUrl('complete-step-up'),
  setPin: () => edgeUrl('set-pin'),
};
