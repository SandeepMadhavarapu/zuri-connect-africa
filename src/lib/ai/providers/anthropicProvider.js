/**
 * Anthropic Claude via unified AI router (Edge Function).
 */

import { withBreaker } from '../circuitBreaker.js';
import { invokeLlm } from '@/services/aiService.js';

export async function generateResponse({ systemPrompt, userMessage, context }) {
  const prompt = `${systemPrompt}\n\nContext:\n${context || 'none'}\n\nUser: ${userMessage}`;
  return withBreaker(
    'anthropic',
    async () => {
      const response = await invokeLlm({ prompt, model: 'claude' });
      if (response === undefined || response === null) {
        throw new Error('Anthropic returned empty response');
      }
      const out = typeof response === 'string' ? response : JSON.stringify(response);
      if (!String(out).trim()) {
        throw new Error('Anthropic returned empty body');
      }
      return out;
    },
    {
      failureThreshold: 5,
      cooldownMs: 60_000,
      probeTimeoutMs: 8_000,
    }
  );
}
