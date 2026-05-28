import { invokeEdgeFunction } from '@/api/client.js';

export async function dispatchWebhookEvent(payload) {
  return invokeEdgeFunction('webhookHandler', payload);
}
